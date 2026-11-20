import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	bindAgent,
	bindingsDir,
	clearBindings,
	parseBindCommand,
	pointerFile,
	resolveRun,
	setPointer,
	settleBinding,
	unbindWorktree,
	workRoot,
} from '../scripts/run-context.mjs';

const SCRIPTS = new URL('../scripts/', import.meta.url).pathname;
const RUN_CONTEXT = path.join(SCRIPTS, 'run-context.mjs');
const BUILDER = 'dev-factory:factory-builder';
const REVIEWER = 'dev-factory:factory-reviewer';

// A session started in `repo`, a worktree elsewhere holding run.json, and a state dir for the bindings.
function fixture(run) {
	// the canonical name of the folder (macOS keeps temp folders behind /var -> /private/var), since a binding records that name;
	// the alias test below makes its own other names
	const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'df-ctx-')));
	const repo = path.join(base, 'repo');
	const worktree = path.join(base, '.worktrees', 'APP-1');
	fs.mkdirSync(repo, { recursive: true });
	fs.mkdirSync(path.join(worktree, '.dev-factory'), { recursive: true });
	fs.writeFileSync(path.join(worktree, '.dev-factory', 'run.json'), JSON.stringify({ key: 'APP-1', ...run }));
	const env = { ...process.env, DF_STATE_DIR: path.join(base, 'state'), DF_ACTIVE: '1' };
	return { base, repo, worktree, env };
}

// A further worktree beside the fixture's, holding its own run.json.
function addWorktree(base, key, run) {
	const worktree = path.join(base, '.worktrees', key);
	fs.mkdirSync(path.join(worktree, '.dev-factory'), { recursive: true });
	fs.writeFileSync(path.join(worktree, '.dev-factory', 'run.json'), JSON.stringify({ key, ...run }));
	return worktree;
}

const bound = (r) => {
	assert.equal(r.ok, true, r.reason);
	return r.binding;
};
const listBindings = (env) => {
	try {
		return fs.readdirSync(bindingsDir(env)).sort();
	} catch {
		return [];
	}
};

const hook = (script, env, evt) => spawnSync('node', [path.join(SCRIPTS, script)], { input: JSON.stringify(evt), env, encoding: 'utf8' });

test('two agents of one role, bound to two worktrees, each resolve to their own run', () => {
	const { base, repo, worktree: one, env } = fixture({ role: 'builder', branch: 'feat/APP-1' });
	const two = addWorktree(base, 'APP-2', { role: 'builder', branch: 'feat/APP-2' });
	bound(bindAgent({ agentId: 'agentA', agentType: BUILDER, worktree: one, env }));
	bound(bindAgent({ agentId: 'agentB', agentType: BUILDER, worktree: two, env }));
	// events arrive alternately from the two agents, in both orders, and each sees only its own run
	for (const order of [
		['agentA', 'agentB', 'agentA', 'agentB'],
		['agentB', 'agentA', 'agentB', 'agentA'],
	]) {
		for (const agentId of order) {
			const r = resolveRun({ cwd: repo, agentType: BUILDER, agentId, env });
			assert.equal(r.via, 'binding');
			assert.equal(r.unbound, undefined);
			if (agentId === 'agentA') {
				assert.equal(r.root, one);
				assert.equal(r.run.key, 'APP-1');
				assert.equal(r.run.branch, 'feat/APP-1');
			} else {
				assert.equal(r.root, two);
				assert.equal(r.run.key, 'APP-2');
				assert.equal(r.run.branch, 'feat/APP-2');
			}
		}
	}
});

test('an unbound factory agent resolves to no run and is marked unbound; a non-factory agent and the main session are not', () => {
	const { repo, worktree, env } = fixture({ role: 'reviewer', axis: 'spec' });
	// a leftover pointer is never read: the pointer is retired, so it cannot stand in for a binding
	setPointer(worktree, env);
	const agent = resolveRun({ cwd: repo, agentType: REVIEWER, agentId: 'r1', env });
	assert.equal(agent.run, null);
	assert.equal(agent.via, 'none');
	assert.equal(agent.unbound, true);
	const noId = resolveRun({ cwd: repo, agentType: REVIEWER, env });
	assert.equal(noId.run, null);
	assert.equal(noId.unbound, true, 'a factory agent type with no agent id is unbound too');
	for (const r of [resolveRun({ cwd: repo, env }), resolveRun({ cwd: repo, agentType: 'general-purpose', agentId: 'g1', env })]) {
		assert.equal(r.run, null);
		assert.equal(r.via, 'none');
		assert.equal('unbound' in r, false);
	}
	// an agent id that is not a safe file name never reaches the file system and resolves as unbound
	bound(bindAgent({ agentId: 'r1', agentType: REVIEWER, worktree, env }));
	const odd = resolveRun({ cwd: repo, agentType: REVIEWER, agentId: '../agents/r1', env });
	assert.equal(odd.run, null);
	assert.equal(odd.unbound, true);
	// a binding is used only by an agent of the role it was made for
	const other = resolveRun({ cwd: repo, agentType: BUILDER, agentId: 'r1', env });
	assert.equal(other.run, null);
	assert.equal(other.unbound, true);
});

test('bindAgent accepts a matching role and refuses each failing rule with a reason', () => {
	const { base, repo, worktree, env } = fixture({ role: 'builder' });
	const reviewing = addWorktree(base, 'APP-3', { role: 'reviewer' });
	const refused = (args, pattern) => {
		const r = bindAgent({ env, ...args });
		assert.equal(r.ok, false);
		assert.equal(typeof r.reason, 'string');
		assert.match(r.reason, pattern);
		assert.match(r.reason, /\.$/, 'a reason is a sentence');
	};
	refused({ agentType: BUILDER, worktree }, /agent id/);
	refused({ agentId: '', agentType: BUILDER, worktree }, /agent id/);
	refused({ agentId: '../x', agentType: BUILDER, worktree }, /agent id/);
	refused({ agentId: 'a b', agentType: BUILDER, worktree }, /agent id/);
	refused({ agentId: 'g1', agentType: 'general-purpose', worktree }, /factory agent/);
	refused({ agentId: 'm1', worktree }, /factory agent/);
	refused({ agentId: 'b1', agentType: BUILDER, worktree: 'rel/dir' }, /absolute/);
	refused({ agentId: 'b1', agentType: BUILDER }, /absolute/);
	refused({ agentId: 'b1', agentType: BUILDER, worktree: repo }, /run\.json/);
	refused({ agentId: 'b1', agentType: BUILDER, worktree: reviewing }, /role/);
	assert.deepEqual(listBindings(env), [], 'no refusal records anything');

	const first = bound(bindAgent({ agentId: 'b1', agentType: BUILDER, worktree, env }));
	assert.equal(first.worktree, worktree);
	assert.equal(first.role, 'builder');
	assert.equal(typeof first.at, 'string');
	const file = path.join(bindingsDir(env), 'b1.json');
	assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), first);
	// the same agent binding again is accepted and leaves one binding
	bound(bindAgent({ agentId: 'b1', agentType: BUILDER, worktree, env }));
	assert.deepEqual(listBindings(env), ['b1.json']);
	// a second agent of the same role on a worktree another holds is refused
	refused({ agentId: 'b2', agentType: BUILDER, worktree }, /already bound/);
	// written beside the file and renamed, so nothing but the binding is left in the folder
	assert.deepEqual(listBindings(env), ['b1.json']);
	// an agent of another role on its own run is accepted beside it
	bound(bindAgent({ agentId: 'r1', agentType: REVIEWER, worktree: reviewing, env }));
	assert.deepEqual(listBindings(env), ['b1.json', 'r1.json']);
});

test('a binding to a worktree that lost its run.json is treated as unbound', () => {
	const { repo, worktree, env } = fixture({ role: 'builder' });
	bound(bindAgent({ agentId: 'b1', agentType: BUILDER, worktree, env }));
	assert.equal(resolveRun({ cwd: repo, agentType: BUILDER, agentId: 'b1', env }).via, 'binding');
	fs.rmSync(path.join(worktree, '.dev-factory', 'run.json'));
	const r = resolveRun({ cwd: repo, agentType: BUILDER, agentId: 'b1', env });
	assert.equal(r.run, null);
	assert.equal(r.unbound, true);
	// a corrupt binding file does not crash resolution either
	fs.writeFileSync(path.join(bindingsDir(env), 'b1.json'), '{nope');
	assert.equal(resolveRun({ cwd: repo, agentType: BUILDER, agentId: 'b1', env }).unbound, true);
});

test('a run.json in the session directory still wins (interactive build in a worktree)', () => {
	const { worktree, env } = fixture({ role: 'builder' });
	assert.equal(resolveRun({ cwd: worktree, env }).via, 'cwd');
	assert.equal(resolveRun({ cwd: worktree, agentType: BUILDER, agentId: 'b9', env }).via, 'cwd');
});

test('set refuses a relative path or a directory without run.json', () => {
	const { repo, env } = fixture({});
	assert.throws(() => setPointer('rel/dir', env));
	assert.throws(() => setPointer(repo, env));
});

// These two drive the hook scripts, which pass the event's agent_id once they resolve through the binding.
test('the bash hook applies the reviewer rules to a reviewer agent even though cwd is the repo root', () => {
	const { repo, worktree, env } = fixture({ role: 'reviewer', axis: 'spec' });
	bound(bindAgent({ agentId: 'a1', agentType: REVIEWER, worktree, env }));
	const evt = (command, agent_type) => ({ cwd: repo, tool_input: { command }, ...(agent_type ? { agent_type, agent_id: 'a1' } : {}) });
	assert.equal(hook('guard-bash.mjs', env, evt('rm -rf services', REVIEWER)).status, 2);
	assert.equal(hook('guard-bash.mjs', env, evt('git diff origin/develop...HEAD', REVIEWER)).status, 0);
	// the scheduler's own wait loop in the main session is not judged as the reviewer
	assert.equal(hook('guard-bash.mjs', env, evt('until [ -f x ]; do sleep 5; done')).status, 0);
});

test('the edit hook protects the worktree of the dispatched role, and the stop gate holds a reviewer until its record exists', () => {
	const { repo, worktree, env } = fixture({ role: 'researcher' });
	const RESEARCHER = 'dev-factory:factory-researcher';
	bound(bindAgent({ agentId: 's1', agentType: RESEARCHER, worktree, env }));
	const edit = (file) =>
		hook('edit-guard.mjs', env, { cwd: repo, agent_type: RESEARCHER, agent_id: 's1', tool_input: { file_path: file, content: 'x' } });
	assert.equal(edit(path.join(worktree, 'services/api/a.js')).status, 2);
	assert.equal(edit(path.join(worktree, 'docs/plans/APP-1/research.md')).status, 0);
	assert.equal(edit(path.join(worktree, '.dev-factory/blocked.json')).status, 0);
	const stop = hook('stop-gate.mjs', env, { cwd: repo, agent_type: RESEARCHER, agent_id: 's1' });
	assert.equal(stop.status, 2);
	fs.writeFileSync(path.join(worktree, '.dev-factory', 'blocked.json'), '{}');
	assert.equal(hook('stop-gate.mjs', env, { cwd: repo, agent_type: RESEARCHER, agent_id: 's1' }).status, 0);
});

test('workRoot: cwd run, one binding, two bindings throw naming --worktree, none falls to the git root', () => {
	const { base, repo, worktree, env } = fixture({ role: 'builder' });
	const two = addWorktree(base, 'APP-2', { role: 'builder' });
	// no bindings: the git root of the cwd (a plain folder here, so the folder itself), and a leftover pointer is not read
	setPointer(worktree, env);
	assert.equal(workRoot({ cwd: repo, env }), repo);
	// the cwd run wins over any binding
	bound(bindAgent({ agentId: 'b1', agentType: BUILDER, worktree, env }));
	assert.equal(workRoot({ cwd: two, env }), two);
	// exactly one binding is used
	assert.equal(workRoot({ cwd: repo, env }), worktree);
	// two bindings to two worktrees cannot be told apart without --worktree
	bound(bindAgent({ agentId: 'b2', agentType: BUILDER, worktree: two, env }));
	assert.throws(() => workRoot({ cwd: repo, env }), /--worktree/);
	assert.equal(workRoot({ cwd: worktree, env }), worktree, 'the cwd run still wins with two bindings');
	// a binding whose run is gone does not count
	fs.rmSync(path.join(two, '.dev-factory', 'run.json'));
	assert.equal(workRoot({ cwd: repo, env }), worktree);
	clearBindings(env);
	assert.equal(workRoot({ cwd: repo, env }), repo);
});

test('parseBindCommand accepts the exact form and rejects chains, pipes, extra flags, relative paths and command substitution', () => {
	const script = '/Users/me/.claude/plugins/dev-factory/scripts/run-context.mjs';
	const ok = (command, worktree) => assert.deepEqual(parseBindCommand(command), { worktree }, command);
	ok(`node "${script}" bind --worktree /w/APP-1`, '/w/APP-1');
	ok(`node "${script}" bind --worktree '/w/APP 1'`, '/w/APP 1');
	ok(`node "${script}" bind --worktree "/w/APP 1"`, '/w/APP 1');
	ok(`  node "${script}"  bind   --worktree /w/APP-1  `, '/w/APP-1');
	for (const command of [
		`node "${script}" bind --worktree /w; rm -rf /`,
		`node "${script}" bind --worktree /w && rm -rf /`,
		`node "${script}" bind --worktree /w || true`,
		`node "${script}" bind --worktree /w & rm -rf /`,
		`node "${script}" bind --worktree /w | cat`,
		`echo x | node "${script}" bind --worktree /w`,
		`node "${script}" bind --worktree /w > /tmp/x`,
		`node "${script}" bind --worktree /w < /tmp/x`,
		`node "${script}" bind --worktree /w\nrm -rf /`,
		`node "${script}" bind --worktree /w\rrm -rf /`,
		`node "${script}" bind --worktree /w --json '{}'`,
		`node "${script}" bind --force --worktree /w`,
		`node "${script}" bind --worktree /w extra`,
		`node "${script}" bind --worktree`,
		`node "${script}" bind`,
		`node "${script}" bind --worktree rel/dir`,
		`node "${script}" bind --worktree ./w`,
		`node "${script}" bind --worktree ~/w`,
		`node "${script}" bind --worktree "$(pwd)"`,
		`node "${script}" bind --worktree /w/$(id)`,
		`node "${script}" bind --worktree /w/\`id\``,
		`node "${script}" bind --worktree "$HOME/w"`,
		`node "${script}" bind --worktree /w/\\;x`,
		`node "${script}" bind --worktree /w/*`,
		`node "${script}" bind --worktree '/w/a'b`,
		`node "${script}" bind --worktree "/w/a`,
		`node "${script}" bind --worktree ( /w )`,
		`node "${script}" write --worktree /w --json '{"role":"builder"}'`,
		`node "${script}" set --worktree /w`,
		`node "/x/other.mjs" bind --worktree /w`,
		`node "/x/not-run-context.mjs" bind --worktree /w`,
		`node /x/run-context.mjs bind --worktree /w`,
		`FOO=1 node "${script}" bind --worktree /w`,
		`nodejs "${script}" bind --worktree /w`,
		`bash -c 'node "${script}" bind --worktree /w'`,
		'',
		null,
		undefined,
		42,
	])
		assert.equal(parseBindCommand(command), null, String(command));
});

// The scheduler session cannot create or change run.json with the edit tools: the hook protects run state during a scheduled pass
// (DF_ACTIVE=1), so `write` is the one way it records a run.
const cli = (env, ...args) => spawnSync('node', [RUN_CONTEXT, ...args], { env, encoding: 'utf8' });
const write = (env, worktree, patch) => cli(env, 'write', '--worktree', worktree, '--json', JSON.stringify(patch));
const readRun = (worktree) => JSON.parse(fs.readFileSync(path.join(worktree, '.dev-factory', 'run.json'), 'utf8'));

// A worktree as `worktree.mjs add` leaves it: a checkout with no .dev-factory folder yet.
function freshWorktree() {
	const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'df-write-')));
	const worktree = path.join(base, '.worktrees', 'APP-7');
	fs.mkdirSync(worktree, { recursive: true });
	return { base, repo: path.join(base, 'repo'), worktree, env: { ...process.env, DF_STATE_DIR: path.join(base, 'state'), DF_ACTIVE: '1' } };
}

test('during a scheduled pass the edit hook refuses run.json but write creates it and an agent binds to it', () => {
	const { repo, worktree, env } = freshWorktree();
	const runJson = path.join(worktree, '.dev-factory', 'run.json');
	assert.equal(
		hook('edit-guard.mjs', env, { cwd: repo, tool_input: { file_path: runJson, content: '{}' } }).status,
		2,
		'the edit tools stay refused',
	);
	const made = write(env, worktree, { key: 'APP-7', role: 'builder', until: 'build', mode: 'scheduled', runId: '1793873600' });
	assert.equal(made.status, 0, made.stderr);
	assert.deepEqual(readRun(worktree), { key: 'APP-7', role: 'builder', until: 'build', mode: 'scheduled', runId: '1793873600' });
	bound(bindAgent({ agentId: 'b1', agentType: BUILDER, worktree, env }));
	const r = resolveRun({ cwd: repo, agentType: BUILDER, agentId: 'b1', env });
	assert.equal(r.via, 'binding');
	assert.equal(r.run.key, 'APP-7');
});

test('write merges into an existing run.json, and null removes a field', () => {
	const { worktree, env } = freshWorktree();
	assert.equal(write(env, worktree, { key: 'APP-7', role: 'builder', until: 'build', kind: 'story' }).status, 0);
	assert.equal(write(env, worktree, { role: 'reviewer', axis: 'spec' }).status, 0);
	assert.deepEqual(readRun(worktree), { key: 'APP-7', role: 'reviewer', until: 'build', kind: 'story', axis: 'spec' });
	assert.equal(write(env, worktree, { role: 'builder', axis: null }).status, 0);
	assert.deepEqual(readRun(worktree), { key: 'APP-7', role: 'builder', until: 'build', kind: 'story' });
});

test('write refuses what would leave a run that no hook can trust', () => {
	const { worktree, env } = freshWorktree();
	const runJson = path.join(worktree, '.dev-factory', 'run.json');
	const refused = (r) => {
		assert.equal(r.status, 3, r.stderr);
		assert.match(r.stderr, /^run-context: /);
	};
	refused(write(env, worktree, { role: 'builder' })); // a new run.json needs a key
	assert.equal(fs.existsSync(runJson), false, 'nothing is written on a refusal');
	refused(write(env, worktree, { key: 'APP-7', role: 'admin' })); // not a role the hooks know
	refused(write(env, worktree, { key: '' }));
	refused(write(env, 'rel/dir', { key: 'APP-7' }));
	refused(write(env, path.join(worktree, 'missing'), { key: 'APP-7' }));
	refused(cli(env, 'write', '--worktree', worktree, '--json', '[1]'));
	refused(cli(env, 'write', '--worktree', worktree, '--json', '{nope'));
	refused(cli(env, 'write', '--worktree', worktree));
	assert.equal(fs.existsSync(runJson), false);
	// the same command with a good patch succeeds, so the refusals above are about the input, not a command that does not exist
	assert.equal(write(env, worktree, { key: 'APP-7', role: 'builder' }).status, 0);
	refused(write(env, worktree, { role: 'admin' })); // a bad patch leaves the earlier file as it was
	assert.deepEqual(readRun(worktree), { key: 'APP-7', role: 'builder' });
});

test("write with a role clears that worktree's bindings only", () => {
	const { base, worktree, env } = freshWorktree();
	const other = path.join(base, '.worktrees', 'APP-8');
	fs.mkdirSync(other, { recursive: true });
	assert.equal(write(env, worktree, { key: 'APP-7', role: 'builder' }).status, 0);
	assert.equal(write(env, other, { key: 'APP-8', role: 'builder' }).status, 0);
	bound(bindAgent({ agentId: 'b7', agentType: BUILDER, worktree, env }));
	bound(bindAgent({ agentId: 'b8', agentType: BUILDER, worktree: other, env }));
	// a write without a role is not a new stage and clears nothing
	assert.equal(write(env, worktree, { until: 'ship' }).status, 0);
	assert.deepEqual(listBindings(env), ['b7.json', 'b8.json']);
	// a refused write clears nothing either
	assert.equal(write(env, worktree, { role: 'admin' }).status, 3);
	assert.deepEqual(listBindings(env), ['b7.json', 'b8.json']);
	assert.equal(write(env, worktree, { role: 'reviewer', axis: 'spec' }).status, 0);
	assert.deepEqual(listBindings(env), ['b8.json']);
	// the same holds for the function, and for the same role written again
	unbindWorktree(other, env);
	assert.deepEqual(listBindings(env), []);
});

test('clear removes all bindings and a leftover pointer', () => {
	const { base, worktree, env } = fixture({ role: 'builder' });
	const two = addWorktree(base, 'APP-2', { role: 'reviewer' });
	bound(bindAgent({ agentId: 'b1', agentType: BUILDER, worktree, env }));
	bound(bindAgent({ agentId: 'r1', agentType: REVIEWER, worktree: two, env }));
	setPointer(worktree, env);
	const r = cli(env, 'clear');
	assert.equal(r.status, 0, r.stderr);
	assert.equal(fs.existsSync(bindingsDir(env)), false);
	assert.equal(fs.existsSync(pointerFile(env)), false);
	// clearing nothing is fine
	assert.equal(cli(env, 'clear').status, 0);
	clearBindings(env);
});

test('run-context.mjs bind --worktree <abs> says the guard records the binding, and set is no longer used', () => {
	const { worktree, env } = fixture({ role: 'builder' });
	const r = cli(env, 'bind', '--worktree', worktree);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /guard records/);
	assert.equal(r.stdout.trim().split('\n').length, 1, 'one line');
	assert.equal(fs.existsSync(bindingsDir(env)), false, 'the command records nothing itself');
	for (const bad of [cli(env, 'bind'), cli(env, 'bind', '--worktree'), cli(env, 'bind', '--worktree', 'rel/dir')]) {
		assert.equal(bad.status, 3);
		assert.match(bad.stderr, /^run-context: /);
	}
	assert.match(cli(env, 'bind').stderr, /usage/);
	const set = cli(env, 'set', '--worktree', worktree);
	assert.equal(set.status, 0, set.stderr);
	assert.match(set.stderr, /no longer used/);
	assert.equal(fs.existsSync(pointerFile(env)), false, 'set writes no pointer');
});

// Another name for one folder: a symlink to it, and on case-insensitive storage the same path in another case.
function aliases(base, worktree) {
	const out = [];
	const link = path.join(base, 'link-to-wt');
	fs.symlinkSync(worktree, link);
	out.push(['symlink', link]);
	const swapped = path.join(path.dirname(worktree), path.basename(worktree).toUpperCase());
	if (swapped !== worktree && fs.existsSync(swapped)) out.push(['case', swapped]);
	return out;
}

test('a symlink or case alias of a bound worktree is the same worktree for the same-role check, unbindWorktree and workRoot', (t) => {
	const { base, repo, worktree: wt0, env } = fixture({ role: 'builder' });
	const worktree = path.join(path.dirname(wt0), 'app-1');
	fs.renameSync(wt0, worktree);
	const found = aliases(base, worktree);
	if (!found.some(([kind]) => kind === 'case')) t.diagnostic('this file system tells case apart, so the case alias is not tested here');
	for (const [kind, alias] of found) {
		clearBindings(env);
		const first = bound(bindAgent({ agentId: 'b1', agentType: BUILDER, worktree, env }));
		assert.equal(first.worktree, fs.realpathSync.native(worktree), 'the binding holds the canonical path');
		const second = bindAgent({ agentId: 'b2', agentType: BUILDER, worktree: alias, env });
		assert.equal(second.ok, false, `${kind}: a second builder through the alias is refused`);
		assert.match(second.reason, /already bound/);
		assert.equal(resolveRun({ cwd: repo, agentType: BUILDER, agentId: 'b1', env }).root, first.worktree);
		// two agents of other roles bound through two names of the folder count as one worktree
		fs.writeFileSync(path.join(bindingsDir(env), 'r1.json'), JSON.stringify({ worktree: alias, role: 'reviewer', at: first.at }));
		assert.equal(workRoot({ cwd: repo, env }), first.worktree, `${kind}: one folder, one worktree`);
		unbindWorktree(alias, env);
		assert.deepEqual(listBindings(env), [], `${kind}: unbinding through the alias removes both`);
	}
});

test('after the rename the later of two same-role binds to one worktree removes its own file and is refused', () => {
	const { worktree, env } = fixture({ role: 'builder' });
	const real = fs.realpathSync.native(worktree);
	fs.mkdirSync(bindingsDir(env), { recursive: true });
	const plant = (id, at) => fs.writeFileSync(path.join(bindingsDir(env), `${id}.json`), JSON.stringify({ worktree: real, role: 'builder', at }));
	plant('b0', '2026-11-20T10:00:00.000Z');
	plant('b1', '2026-11-20T10:00:01.000Z');
	const lost = settleBinding('b1', env);
	assert.equal(lost.ok, false);
	assert.match(lost.reason, /already bound/);
	assert.deepEqual(listBindings(env), ['b0.json']);
	// the earlier one keeps its binding when it looks again
	assert.equal(settleBinding('b0', env).ok, true);
	assert.deepEqual(listBindings(env), ['b0.json']);
	// with the same time the lower agent id wins
	plant('a9', '2026-11-20T10:00:00.000Z');
	assert.equal(settleBinding('b0', env).ok, false);
	assert.deepEqual(listBindings(env), ['a9.json']);
});

test("a binding made before the run's role changed no longer resolves", () => {
	const { repo, worktree, env } = fixture({ role: 'builder' });
	bound(bindAgent({ agentId: 'b1', agentType: BUILDER, worktree, env }));
	const runJson = path.join(worktree, '.dev-factory', 'run.json');
	fs.writeFileSync(runJson, JSON.stringify({ key: 'APP-1', role: 'reviewer' }));
	const r = resolveRun({ cwd: repo, agentType: BUILDER, agentId: 'b1', env });
	assert.equal(r.run, null);
	assert.equal(r.unbound, true);
	// a run with no role is a builder's, as the stop gate and the bind check read it
	fs.writeFileSync(runJson, JSON.stringify({ key: 'APP-1' }));
	assert.equal(resolveRun({ cwd: repo, agentType: BUILDER, agentId: 'b1', env }).via, 'binding');
});

test('bindAgent never throws: a too-long agent id and a state folder that cannot be written give a reason', () => {
	const { base, worktree, env } = fixture({ role: 'builder' });
	const long = bindAgent({ agentId: 'a'.repeat(300), agentType: BUILDER, worktree, env });
	assert.equal(long.ok, false);
	assert.match(long.reason, /agent id/);
	assert.equal(bindAgent({ agentId: 'a'.repeat(128), agentType: BUILDER, worktree, env }).ok, true);
	fs.writeFileSync(path.join(base, 'a-file'), 'x');
	const blocked = { ...env, DF_STATE_DIR: path.join(base, 'a-file', 'state') };
	let r;
	assert.doesNotThrow(() => (r = bindAgent({ agentId: 'b1', agentType: BUILDER, worktree, env: blocked })));
	assert.equal(r.ok, false);
	assert.match(r.reason, /\.$/);
	assert.match(r.reason, /binding/);
});

test('resolveRun and workRoot take a missing or non-string cwd as the process directory', () => {
	const { env } = fixture({ role: 'builder' });
	for (const cwd of [undefined, null, 42, '']) {
		assert.doesNotThrow(() => resolveRun({ cwd, agentType: BUILDER, agentId: 'b1', env }));
		assert.equal(resolveRun({ cwd, agentType: BUILDER, agentId: 'b1', env }).unbound, true);
		assert.equal(typeof workRoot({ cwd, env }), 'string');
	}
	assert.doesNotThrow(() => resolveRun());
	assert.doesNotThrow(() => workRoot());
});

test('workRoot skips a corrupt or foreign file in the bindings folder', () => {
	const { repo, worktree, env } = fixture({ role: 'builder' });
	fs.mkdirSync(bindingsDir(env), { recursive: true });
	fs.writeFileSync(path.join(bindingsDir(env), 'bad.json'), '{nope');
	fs.writeFileSync(path.join(bindingsDir(env), 'arr.json'), '[1]');
	fs.writeFileSync(path.join(bindingsDir(env), 'rel.json'), JSON.stringify({ worktree: 'rel/dir', role: 'builder' }));
	fs.writeFileSync(path.join(bindingsDir(env), 'notes.txt'), 'x');
	assert.equal(workRoot({ cwd: repo, env }), repo);
	bound(bindAgent({ agentId: 'b1', agentType: BUILDER, worktree, env }));
	assert.equal(workRoot({ cwd: repo, env }), fs.realpathSync.native(worktree));
});
