// The hooks as a dispatched factory agent meets them: each agent binds itself to its worktree with its first command, is judged by
// its own run from then on, and is refused everything else until it has bound. The hook scripts run as processes with the event on
// stdin, the way Claude Code runs them.
import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
const edit = (env, repo, who, file, tool_name = 'Write') =>
	hook('edit-guard.mjs', env, { cwd: repo, tool_name, tool_input: { file_path: file, content: 'x' }, ...who });
const mcp = (env, repo, who, tool = SENTRY) => hook('mcp-guard.mjs', env, { cwd: repo, tool_name: tool, tool_input: {}, ...who });
const stop = (env, repo, who) => hook('stop-gate.mjs', env, { cwd: repo, ...who });
const bindCmd = (worktree, script = RUN_CONTEXT) => `node "${script}" bind --worktree ${worktree}`;
const listBindings = (env) => {
	try {
		// the bindings themselves, not the claims folder beside them
		return fs
			.readdirSync(bindingsDir(env))
			.filter((f) => f.endsWith('.json'))
			.sort();
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
		`${bindCmd(one)}\rid`,
		`${bindCmd(one)} & id`,
		`${bindCmd(one)} > /tmp/x`,
		`bash <<EOF\n${bindCmd(one)}\nEOF`,
		`bash -c '${bindCmd(one)}'`,
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
	// bound only through the tools a researcher has: its first Write
	assert.equal(edit(env, repo, who, path.join(research, 'docs/plans/APP-4/research.md')).status, 0);
	assert.deepEqual(listBindings(env), ['s1.json']);
	const held = stop(env, repo, who);
	assert.equal(held.status, 2, held.stderr);
	assert.deepEqual(listBindings(env), ['s1.json'], 'an agent told to carry on is still bound');
	assert.equal(edit(env, repo, who, path.join(research, '.dev-factory/blocked.json')).status, 0);
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
	assert.match(write.stderr, /run-context\.mjs is run only by the scheduler/);
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

// A researcher has no Bash tool (agents/factory-researcher.md), so it cannot run the bind command: its first Write binds it.
test('a researcher is bound by its first Write, and only by a Write into a free researcher run', () => {
	const { base, repo, env, one } = fixture();
	const res = addWorktree(base, 'APP-6', { role: 'researcher' });
	const held = addWorktree(base, 'APP-8', { role: 'researcher' });
	const Q = agent(RESEARCHER, 'q1');
	const refusedWrite = (who, file, reason, tool) => {
		const before = listBindings(env);
		const r = edit(env, repo, who, file, tool);
		assert.equal(r.status, 2, `${file}: ${r.stderr}`);
		if (reason) assert.match(r.stderr, reason, file);
		assert.deepEqual(listBindings(env), before, `${file}: nothing recorded`);
	};
	// another researcher holds APP-8
	assert.equal(edit(env, repo, agent(RESEARCHER, 'q0'), path.join(held, 'docs/plans/APP-8/research.md')).status, 0);
	assert.deepEqual(listBindings(env), ['q0.json']);
	refusedWrite(Q, path.join(held, 'docs/plans/APP-8/research.md'), /already bound/);
	// a relative path cannot name a run
	refusedWrite(Q, 'docs/plans/APP-6/research.md', /absolute path/);
	// the nearest run above the file is a builder's
	refusedWrite(Q, path.join(one, 'docs/plans/APP-1/research.md'), /builder role, and this agent is a researcher/);
	// `..` is judged by where it leads: out of APP-6 into APP-1's builder run, and out of every run
	refusedWrite(Q, path.join(res, '..', 'APP-1', 'docs', 'research.md'), /builder role/);
	refusedWrite(Q, path.join(res, '..', '..', 'repo', 'notes.md'), /no folder above/);
	// only the Write tool binds, and only a researcher
	refusedWrite(Q, path.join(res, 'docs/plans/APP-6/research.md'), /not bound/, 'Edit');
	refusedWrite(Q, path.join(res, 'docs/plans/APP-6/research.md'), /not bound/, 'MultiEdit');
	for (const [role, key] of [
		['builder', 'APP-11'],
		['reviewer', 'APP-12'],
		['debugger', 'APP-13'],
		['improver', 'APP-14'],
		['promoter', 'APP-15'],
	]) {
		const w = addWorktree(base, key, { role });
		refusedWrite(agent(`dev-factory:factory-${role}`, `x-${role}`), path.join(w, 'AGENTS.md'), /not bound/);
	}
	// the first Write binds and is judged under the run it bound: research.md passes
	assert.equal(edit(env, repo, Q, path.join(res, 'docs/plans/APP-6/research.md')).status, 0);
	assert.deepEqual(listBindings(env), ['q0.json', 'q1.json']);
	// from then on the researcher's limits hold
	const src = edit(env, repo, Q, path.join(res, 'src/x.js'));
	assert.equal(src.status, 2);
	assert.match(src.stderr, /a researcher writes only docs\/plans\/APP-6\/research\.md/);
	// a first Write the researcher limits refuse is refused, and binds nothing
	const R = agent(RESEARCHER, 'q2');
	const res2 = addWorktree(base, 'APP-9', { role: 'researcher' });
	const wrong = edit(env, repo, R, path.join(res2, 'src/x.js'));
	assert.equal(wrong.status, 2);
	assert.match(wrong.stderr, /a researcher writes only/);
	assert.match(wrong.stderr, /nothing was bound/);
	assert.ok(!listBindings(env).includes('q2.json'));
	assert.equal(edit(env, repo, R, path.join(res2, 'docs/plans/APP-9/research.md')).status, 0, 'its intended first Write still binds');
	assert.ok(listBindings(env).includes('q2.json'));
	// the stop gate removes the binding when it lets the researcher go
	fs.writeFileSync(path.join(res, '.dev-factory', 'blocked.json'), '{}');
	assert.equal(stop(env, repo, Q).status, 0);
	assert.ok(!listBindings(env).includes('q1.json'));
});

test('a bound agent does not bind to a second worktree, and rebinding its own is fine', () => {
	const { repo, env, one, two } = fixture();
	const A = agent(BUILDER, 'm1');
	assert.equal(bash(env, repo, A, bindCmd(one)).status, 0);
	const moved = bash(env, repo, A, bindCmd(two));
	assert.equal(moved.status, 2);
	assert.match(moved.stderr, /already bound to/);
	assert.equal(bash(env, repo, A, bindCmd(one)).status, 0);
	assert.match(bash(env, repo, A, 'git push origin feat/APP-2').stderr, /feat\/APP-1/, 'still judged by its first run');
	// the second worktree is still free for another agent
	assert.equal(bash(env, repo, agent(BUILDER, 'm2'), bindCmd(two)).status, 0);
});

// A misdirected first Write must not bind: bound to the wrong run, the researcher could not reach its own, the other run's
// researcher could not bind, and the stop gate would block the wrong ticket.
test("a researcher's misdirected first Write binds nothing, so its own run and the other run's researcher are unaffected", () => {
	const { base, repo, env: fixtureEnv } = fixture();
	const env = { ...fixtureEnv, DF_STOP_GATE_MAX: '1' };
	const R1 = addWorktree(base, 'R-1', { role: 'researcher' });
	const R2 = addWorktree(base, 'R-2', { role: 'researcher' });
	const m1 = agent(RESEARCHER, 'm1');
	const first = edit(env, repo, m1, path.join(R2, 'notes.md'));
	assert.equal(first.status, 2);
	assert.match(first.stderr, /nothing was bound/);
	assert.deepEqual(listBindings(env), []);
	assert.equal(edit(env, repo, m1, path.join(R1, 'docs/plans/R-1/research.md')).status, 0, 'the intended first Write binds');
	assert.deepEqual(listBindings(env), ['m1.json']);
	assert.equal(edit(env, repo, agent(RESEARCHER, 'real2'), path.join(R2, 'docs/plans/R-2/research.md')).status, 0, "R-2's own researcher binds");
	assert.deepEqual(listBindings(env), ['m1.json', 'real2.json']);
	// m1's stop gate gives up on R-1, its own ticket, never on R-2
	for (let i = 0; i < 3; i++) stop(env, repo, m1);
	assert.equal(fs.existsSync(path.join(R1, '.dev-factory', 'blocked.json')), true);
	assert.equal(fs.existsSync(path.join(R2, '.dev-factory', 'blocked.json')), false);
});

test('a first Write through a symlink or another case of the path is never bound and then refused', () => {
	const { base, repo, env } = fixture();
	const R3 = addWorktree(base, 'R-3', { role: 'researcher' });
	const link = path.join(base, 'link-R3');
	fs.symlinkSync(R3, link);
	const variants = [path.join(link, 'docs/plans/R-3/research.md')];
	const upper = path.join(path.dirname(R3), 'r-3');
	if (fs.existsSync(upper)) variants.push(path.join(upper, 'docs/plans/R-3/research.md'));
	for (const [i, file] of variants.entries()) {
		const who = agent(RESEARCHER, `v${i}`);
		const r = edit(env, repo, who, file);
		const bound = listBindings(env).includes(`v${i}.json`);
		assert.ok((r.status === 0 && bound) || (r.status === 2 && !bound), `${file}: exit ${r.status}, bound ${bound}: ${r.stderr}`);
		// whatever happened, the agent can still reach its run by the real path
		if (!bound) assert.equal(edit(env, repo, who, path.join(R3, 'docs/plans/R-3/research.md')).status, 0);
		fs.rmSync(bindingsDir(env), { recursive: true, force: true });
	}
});

test('a bound builder cannot clear the bindings or rewrite a run through run-context.mjs, and every binding stays as it was', () => {
	const { repo, env, one, two } = fixture();
	const A = agent(BUILDER, 'c1');
	const B = agent(BUILDER, 'c2');
	assert.equal(bash(env, repo, A, bindCmd(one)).status, 0);
	assert.equal(bash(env, repo, B, bindCmd(two)).status, 0);
	const snapshot = () => listBindings(env).map((f) => [f, fs.readFileSync(path.join(bindingsDir(env), f), 'utf8')]);
	const before = snapshot();
	for (const command of [
		`node "${RUN_CONTEXT}" clear`,
		`node ${RUN_CONTEXT} clear`,
		`cd ${SCRIPTS} && node run-context.mjs clear`,
		`node --no-warnings "${RUN_CONTEXT}" write --worktree ${one} --json '{"branch":"feat/APP-2"}'`,
		`env node "${RUN_CONTEXT}" write --worktree ${two} --json '{"role":"builder"}'`,
	]) {
		const r = bash(env, repo, A, command);
		assert.equal(r.status, 2, command);
		assert.match(r.stderr, /run-context\.mjs/, command);
	}
	assert.deepEqual(snapshot(), before);
	// the bind itself still works for a bound agent, as the same binding
	assert.equal(bash(env, repo, A, bindCmd(one)).status, 0);
	assert.deepEqual(
		snapshot().map(([f]) => f),
		['c1.json', 'c2.json'],
	);
});

test('three agents binding one worktree at once: at most one is accepted, every round', async () => {
	const { repo, env, one } = fixture();
	const bindAt = (id) =>
		new Promise((resolve) => {
			const c = spawn(process.execPath, [path.join(SCRIPTS, 'guard-bash.mjs')], { env });
			c.stdin.end(JSON.stringify({ cwd: repo, tool_input: { command: bindCmd(one) }, ...agent(BUILDER, id) }));
			c.on('exit', (code) => resolve(code));
		});
	for (let round = 0; round < 25; round++) {
		fs.rmSync(bindingsDir(env), { recursive: true, force: true });
		const codes = await Promise.all(['a', 'b', 'c'].map((s) => bindAt(`P${round}${s}`)));
		const accepted = codes.filter((c) => c === 0).length;
		assert.ok(accepted <= 1, `round ${round}: ${codes.join(',')}`);
		assert.ok(
			codes.every((c) => c === 0 || c === 2),
			`round ${round}: ${codes.join(',')}`,
		);
		assert.equal(listBindings(env).length, accepted, `round ${round}: one binding for the one accepted`);
	}
});

test('an event that is null, a list or a bare value is let through by every hook without a crash', () => {
	const { env } = fixture();
	for (const script of ['guard-bash.mjs', 'edit-guard.mjs', 'mcp-guard.mjs', 'stop-gate.mjs'])
		for (const raw of ['null', '[]', '"x"', '7', 'true', '', '{']) {
			const r = spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input: raw, env, encoding: 'utf8' });
			assert.equal(r.status, 0, `${script} ${raw}: ${r.stderr}`);
			assert.equal(r.stderr, '', `${script} ${raw}`);
		}
});

test('a bound agent whose session is in another worktree is judged by that worktree, as the run in cwd wins', () => {
	const { repo, env, one, two } = fixture();
	const A = agent(BUILDER, 'w1');
	assert.equal(bash(env, repo, A, bindCmd(one)).status, 0);
	const fromTwo = hook('guard-bash.mjs', env, { cwd: two, tool_input: { command: 'git push origin feat/APP-1' }, ...A });
	assert.equal(fromTwo.status, 2);
	assert.match(fromTwo.stderr, /only the ticket branch feat\/APP-2 may be pushed/);
	assert.equal(hook('guard-bash.mjs', env, { cwd: two, tool_input: { command: 'git push origin feat/APP-2' }, ...A }).status, 0);
});
