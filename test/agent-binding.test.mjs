// The hooks as a dispatched factory agent meets them: each agent binds itself to its worktree with its first command, is judged by
// its own run from then on, and is refused everything else until it has bound. The hook scripts run as processes with the event on
// stdin, the way Claude Code runs them.
import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bindingsDir, unbindAgent } from '../scripts/run-context.mjs';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const RUN_CONTEXT = path.join(SCRIPTS, 'run-context.mjs');
const BUILDER = 'dev-factory:factory-builder';
const REVIEWER = 'dev-factory:factory-reviewer';
const RESEARCHER = 'dev-factory:factory-researcher';
const SENTRY = 'mcp__plugin_dev-factory_sentry__search_events';

// A session started in `repo` (no run there), two ticket worktrees beside it, and a state folder for the bindings.
function fixture() {
	const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'df-bind-')));
	const repo = path.join(base, 'repo');
	fs.mkdirSync(repo, { recursive: true });
	const env = { ...process.env, DF_STATE_DIR: path.join(base, 'state'), DF_ACTIVE: '1' };
	const one = addWorktree(base, 'APP-1', { role: 'builder', branch: 'feat/APP-1' });
	const two = addWorktree(base, 'APP-2', { role: 'builder', branch: 'feat/APP-2' });
	return { base, repo, env, one, two };
}

function addWorktree(base, key, run) {
	const worktree = path.join(base, '.worktrees', key);
	fs.mkdirSync(path.join(worktree, '.dev-factory'), { recursive: true });
	if (run) fs.writeFileSync(path.join(worktree, '.dev-factory', 'run.json'), JSON.stringify({ key, ...run }));
	return worktree;
}

const hook = (script, env, evt) => spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input: JSON.stringify(evt), env, encoding: 'utf8' });
const agent = (agent_type, agent_id) => ({ agent_type, ...(agent_id === undefined ? {} : { agent_id }) });
const bash = (env, repo, who, command) => hook('guard-bash.mjs', env, { cwd: repo, tool_input: { command }, ...who });
const edit = (env, repo, who, file) => hook('edit-guard.mjs', env, { cwd: repo, tool_input: { file_path: file, content: 'x' }, ...who });
const mcp = (env, repo, who, tool = SENTRY) => hook('mcp-guard.mjs', env, { cwd: repo, tool_name: tool, tool_input: {}, ...who });
const stop = (env, repo, who) => hook('stop-gate.mjs', env, { cwd: repo, ...who });
const bindCmd = (worktree, script = RUN_CONTEXT) => `node "${script}" bind --worktree ${worktree}`;
const listBindings = (env) => {
	try {
		return fs.readdirSync(bindingsDir(env)).sort();
	} catch {
		return [];
	}
};

test('an unbound factory agent is refused by the Bash, edit and MCP hooks, with the bind command named', () => {
	const { repo, env, one } = fixture();
	const who = agent(BUILDER, 'u1');
	for (const r of [bash(env, repo, who, 'ls'), edit(env, repo, who, path.join(one, 'src/a.js')), mcp(env, repo, who)]) {
		assert.equal(r.status, 2, r.stderr);
		assert.match(r.stderr, /run-context\.mjs/);
		assert.match(r.stderr, /bind --worktree/);
		assert.match(r.stderr, /not bound/);
		// the command named is this plugin's own script, so it can be run as given
		assert.ok(r.stderr.includes(`node "${path.join(path.resolve(SCRIPTS), 'run-context.mjs')}" bind --worktree`), r.stderr);
		// nothing of any run leaks into the refusal
		assert.doesNotMatch(r.stderr, /APP-1|feat\//);
	}
	assert.match(edit(env, repo, who, path.join(one, 'src/a.js')).stderr, /Bash/, 'the edit hook says to bind with Bash first');
	assert.match(mcp(env, repo, who).stderr, /Bash/, 'so does the MCP hook');
	// the same holds outside a scheduled pass: a factory agent with no run is never unguarded
	const off = { ...env, DF_ACTIVE: '' };
	assert.equal(bash(off, repo, who, 'ls').status, 2);
	assert.equal(edit(off, repo, who, path.join(repo, 'a.js')).status, 2);
	// an agent id that cannot name a binding is unbound too
	assert.equal(bash(env, repo, agent(BUILDER), 'ls').status, 2);
	assert.equal(bash(env, repo, agent(BUILDER, '../x'), 'ls').status, 2);
	assert.deepEqual(listBindings(env), []);
});

test("the bind command binds the agent and is allowed; the same agent's next command is judged by its own run", () => {
	const { repo, env, one, two } = fixture();
	const A = agent(BUILDER, 'agentA');
	const B = agent(BUILDER, 'agentB');
	const bindA = bash(env, repo, A, bindCmd(one));
	assert.equal(bindA.status, 0, bindA.stderr);
	assert.deepEqual(listBindings(env), ['agentA.json']);
	assert.equal(JSON.parse(fs.readFileSync(path.join(bindingsDir(env), 'agentA.json'), 'utf8')).worktree, one);
	// a bind to a path in single or double quotes is the bind command too, and rebinding is the same binding
	assert.equal(bash(env, repo, A, `node "${RUN_CONTEXT}" bind --worktree '${one}'`).status, 0);
	assert.equal(bash(env, repo, A, `node "${RUN_CONTEXT}" bind --worktree "${one}"`).status, 0);
	const wrongA = bash(env, repo, A, 'git push origin feat/APP-2');
	assert.equal(wrongA.status, 2);
	assert.match(wrongA.stderr, /only the ticket branch feat\/APP-1 may be pushed/);
	// B is not bound yet: refused, while A carries on
	assert.equal(bash(env, repo, B, 'ls').status, 2);
	assert.equal(bash(env, repo, B, bindCmd(two)).status, 0);
	// events of the two agents arrive alternately, each judged by its own run
	for (let i = 0; i < 2; i++) {
		const a = bash(env, repo, A, 'git push origin feat/APP-2');
		assert.equal(a.status, 2);
		assert.match(a.stderr, /feat\/APP-1/);
		const b = bash(env, repo, B, 'git push origin feat/APP-1');
		assert.equal(b.status, 2);
		assert.match(b.stderr, /only the ticket branch feat\/APP-2 may be pushed/);
		assert.equal(bash(env, repo, A, 'git push origin feat/APP-1').status, 0);
		assert.equal(bash(env, repo, B, 'git push origin feat/APP-2').status, 0);
	}
	// the edit hook protects each agent's own worktree by its own run
	assert.equal(edit(env, repo, A, path.join(one, '.dev-factory', 'run.json')).status, 2);
	assert.equal(edit(env, repo, A, path.join(one, 'src', 'a.js')).status, 0);
	assert.equal(edit(env, repo, B, path.join(two, 'src', 'a.js')).status, 0);
});

test('a refused bind is exited 2 with the reason and records nothing', () => {
	const { base, repo, env, one } = fixture();
	const empty = addWorktree(base, 'APP-3', null);
	const refused = (who, command, reason) => {
		const r = bash(env, repo, who, command);
		assert.equal(r.status, 2, `${command}: ${r.stderr}`);
		assert.match(r.stderr, reason, command);
		assert.deepEqual(listBindings(env), [], command);
	};
	refused(agent(REVIEWER, 'r1'), bindCmd(one), /builder role, and this agent is a reviewer/);
	refused(agent(BUILDER), bindCmd(one), /agent id/);
	refused(agent(BUILDER, 'b1'), bindCmd(empty), /no \.dev-factory\/run\.json/);
	// a relative path is not the bind command at all, so the agent is still unbound
	refused(agent(BUILDER, 'b1'), `node "${RUN_CONTEXT}" bind --worktree .worktrees/APP-1`, /not bound/);
	// a script of the same name somewhere else would run unchecked once the bind is allowed
	const other = path.join(base, 'elsewhere', 'run-context.mjs');
	fs.mkdirSync(path.dirname(other), { recursive: true });
	fs.writeFileSync(other, 'console.log("anything")\n');
	refused(agent(BUILDER, 'b1'), bindCmd(one, other), /not this plugin's own/);
	refused(agent(BUILDER, 'b1'), bindCmd(one, path.join(base, 'missing', 'run-context.mjs')), /not this plugin's own/);
	refused(agent(BUILDER, 'b1'), `node "scripts/run-context.mjs" bind --worktree ${one}`, /not this plugin's own/);
	// a link to the plugin's own file is the plugin's own file
	const link = path.join(base, 'link', 'run-context.mjs');
	fs.mkdirSync(path.dirname(link), { recursive: true });
	fs.symlinkSync(RUN_CONTEXT, link);
	assert.equal(bash(env, repo, agent(BUILDER, 'b1'), bindCmd(one, link)).status, 0);
	assert.deepEqual(listBindings(env), ['b1.json']);
	// a second agent of the same role on that worktree is refused, and the first keeps its binding
	const second = bash(env, repo, agent(BUILDER, 'b2'), bindCmd(one));
	assert.equal(second.status, 2);
	assert.match(second.stderr, /already bound/);
	assert.deepEqual(listBindings(env), ['b1.json']);
});

test('a bind chained with another command is not the bind command', () => {
	const { repo, env, one } = fixture();
	const who = agent(BUILDER, 'c1');
	for (const command of [
		`${bindCmd(one)}; echo x`,
		`${bindCmd(one)} && echo x`,
		`${bindCmd(one)} | cat`,
		`${bindCmd(one)} --force`,
		`echo $(${bindCmd(one)})`,
		`${bindCmd(one)}\necho x`,
		`echo x; ${bindCmd(one)}`,
	]) {
		const r = bash(env, repo, who, command);
		assert.equal(r.status, 2, command);
		assert.match(r.stderr, /not bound/, command);
		assert.deepEqual(listBindings(env), [], command);
	}
});

test('the main session and a non-factory agent are unaffected', () => {
	const { repo, env, one } = fixture();
	const other = agent('another-plugin:helper', 'h1');
	for (const who of [{}, other]) {
		assert.equal(bash(env, repo, who, 'ls').status, 0);
		// the scheduler does not push, as before
		const push = bash(env, repo, who, 'git push origin feat/APP-1');
		assert.equal(push.status, 2);
		assert.match(push.stderr, /the scheduler does not push/);
		assert.equal(edit(env, repo, who, path.join(repo, 'notes.md')).status, 0);
		assert.equal(mcp(env, repo, who).status, 0);
		// the bind command is nothing special for them: the hook records nothing
		bash(env, repo, who, bindCmd(one));
		assert.deepEqual(listBindings(env), []);
		assert.equal(stop(env, repo, who).status, 0);
	}
	// outside a pass, with no run, nothing is judged
	assert.equal(bash({ ...env, DF_ACTIVE: '' }, repo, {}, 'git push origin main --force').status, 0);
	// an interactive session in a worktree is judged by the run there, with or without an agent field
	assert.equal(bash(env, one, {}, 'git push origin feat/APP-2').status, 2);
	assert.equal(bash(env, one, {}, 'git push origin feat/APP-1').status, 0);
});

test("an unbound factory agent's stop is not held", () => {
	const { repo, env } = fixture();
	const r = stop(env, repo, agent(BUILDER, 'u1'));
	assert.equal(r.status, 0, r.stderr);
	assert.equal(stop(env, repo, agent(BUILDER)).status, 0);
});

test('the stop gate removes the binding of an agent it lets stop, and keeps it while it holds the agent', () => {
	const { base, repo, env } = fixture();
	const research = addWorktree(base, 'APP-4', { role: 'researcher' });
	const who = agent(RESEARCHER, 's1');
	assert.equal(bash(env, repo, who, bindCmd(research)).status, 0);
	const held = stop(env, repo, who);
	assert.equal(held.status, 2, held.stderr);
	assert.deepEqual(listBindings(env), ['s1.json'], 'an agent told to carry on is still bound');
	assert.equal(bash(env, repo, who, 'ls').status, 0);
	fs.writeFileSync(path.join(research, '.dev-factory', 'blocked.json'), '{}');
	assert.equal(stop(env, repo, who).status, 0);
	assert.deepEqual(listBindings(env), [], 'a finished agent leaves no binding behind');
	// an agent whose binding no longer resolves (its run moved on) is let go, and its file goes too
	const b = agent(BUILDER, 'b9');
	assert.equal(bash(env, repo, b, bindCmd(path.join(base, '.worktrees', 'APP-1'))).status, 0);
	fs.writeFileSync(path.join(base, '.worktrees', 'APP-1', '.dev-factory', 'run.json'), JSON.stringify({ key: 'APP-1', role: 'reviewer' }));
	assert.equal(stop(env, repo, b).status, 0);
	assert.deepEqual(listBindings(env), []);
});

test('unbindAgent removes one binding and never throws', () => {
	const { repo, env, one, two } = fixture();
	assert.equal(bash(env, repo, agent(BUILDER, 'k1'), bindCmd(one)).status, 0);
	assert.equal(bash(env, repo, agent(BUILDER, 'k2'), bindCmd(two)).status, 0);
	unbindAgent('k1', env);
	assert.deepEqual(listBindings(env), ['k2.json']);
	for (const id of [undefined, null, '', '../k2', 'k2.json', 42, 'x'.repeat(200), 'gone']) assert.doesNotThrow(() => unbindAgent(id, env));
	assert.deepEqual(listBindings(env), ['k2.json']);
	assert.doesNotThrow(() => unbindAgent('k2', { DF_STATE_DIR: path.join(one, 'no', 'such', 'state') }));
});

test('a builder bound to a run with no role is judged by the builder limits', () => {
	const { base, repo, env } = fixture();
	const roleless = addWorktree(base, 'APP-5', { branch: 'feat/APP-5' });
	fs.mkdirSync(env.DF_STATE_DIR, { recursive: true });
	fs.writeFileSync(path.join(env.DF_STATE_DIR, 'config.json'), JSON.stringify({ telemetry: { allowedRoles: ['debugger'] } }));
	const who = agent(BUILDER, 'n1');
	assert.equal(bash(env, repo, who, bindCmd(roleless)).status, 0);
	const write = bash(env, repo, who, `node "${RUN_CONTEXT}" write --worktree ${roleless} --json '{"role":"reviewer"}'`);
	assert.equal(write.status, 2);
	assert.match(write.stderr, /run state is written only by the scheduler/);
	const sentry = mcp(env, repo, who);
	assert.equal(sentry.status, 2);
	assert.match(sentry.stderr, /the builder role may not read telemetry/);
});

test('a hook that fails on a factory agent refuses rather than allows', () => {
	const { repo, env, one } = fixture();
	const who = agent(BUILDER, 'f1');
	assert.equal(bash(env, repo, who, bindCmd(one)).status, 0);
	// tool inputs the hooks do not expect, which make them throw while judging
	const faults = [
		['edit-guard.mjs', { tool_input: { file_path: path.join(one, 'a.js'), edits: [null] } }],
		['mcp-guard.mjs', { tool_name: SENTRY, tool_input: null }],
	];
	for (const [script, extra] of faults) {
		const r = hook(script, env, { cwd: repo, ...who, ...extra });
		assert.equal(r.status, 2, `${script} must not fail into allowing: ${r.stderr}`);
		assert.match(r.stderr, /could not judge/);
		// an unbound agent is refused before anything can fail
		assert.equal(hook(script, env, { cwd: repo, ...agent(BUILDER, 'f2'), ...extra }).status, 2);
	}
});
