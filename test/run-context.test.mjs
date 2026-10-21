import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { clearPointer, pointerFile, resolveRun, setPointer } from '../scripts/run-context.mjs';

const SCRIPTS = new URL('../scripts/', import.meta.url).pathname;

// A session started in `repo`, a worktree elsewhere holding run.json, and a state dir for the pointer.
function fixture(run) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'df-ctx-'));
	const repo = path.join(base, 'repo');
	const worktree = path.join(base, '.worktrees', 'OAPP-1');
	fs.mkdirSync(repo, { recursive: true });
	fs.mkdirSync(path.join(worktree, '.dev-factory'), { recursive: true });
	fs.writeFileSync(path.join(worktree, '.dev-factory', 'run.json'), JSON.stringify({ key: 'OAPP-1', ...run }));
	const env = { ...process.env, DF_STATE_DIR: path.join(base, 'state'), DF_ACTIVE: '1' };
	return { repo, worktree, env };
}

const hook = (script, env, evt) => spawnSync('node', [path.join(SCRIPTS, script)], { input: JSON.stringify(evt), env, encoding: 'utf8' });

test('a factory agent resolves the worktree through the pointer, the scheduler session does not', () => {
	const { repo, worktree, env } = fixture({ role: 'reviewer', axis: 'spec' });
	assert.equal(resolveRun({ cwd: repo, agentType: 'dev-factory:factory-reviewer', env }).run, null);
	setPointer(worktree, env);
	const r = resolveRun({ cwd: repo, agentType: 'dev-factory:factory-reviewer', env });
	assert.equal(r.via, 'pointer');
	assert.equal(r.root, worktree);
	assert.equal(r.run.role, 'reviewer');
	assert.equal(resolveRun({ cwd: repo, env }).run, null, 'main session has no agent_type');
	assert.equal(resolveRun({ cwd: repo, agentType: 'general-purpose', env }).run, null, 'other agents are not factory agents');
	clearPointer(env);
	assert.equal(fs.existsSync(pointerFile(env)), false);
});

test('a run.json in the session directory still wins (interactive build in a worktree)', () => {
	const { worktree, env } = fixture({ role: 'builder' });
	assert.equal(resolveRun({ cwd: worktree, env }).via, 'cwd');
});

test('set refuses a relative path or a directory without run.json', () => {
	const { repo, env } = fixture({});
	assert.throws(() => setPointer('rel/dir', env));
	assert.throws(() => setPointer(repo, env));
});

test('the bash hook applies the reviewer rules to a reviewer agent even though cwd is the repo root', () => {
	const { repo, worktree, env } = fixture({ role: 'reviewer', axis: 'spec' });
	setPointer(worktree, env);
	const evt = (command, agent_type) => ({ cwd: repo, tool_input: { command }, ...(agent_type ? { agent_type, agent_id: 'a1' } : {}) });
	assert.equal(hook('guard-bash.mjs', env, evt('rm -rf services', 'dev-factory:factory-reviewer')).status, 2);
	assert.equal(hook('guard-bash.mjs', env, evt('git diff origin/develop...HEAD', 'dev-factory:factory-reviewer')).status, 0);
	// the scheduler's own wait loop in the main session is not judged as the reviewer
	assert.equal(hook('guard-bash.mjs', env, evt('until [ -f x ]; do sleep 5; done')).status, 0);
});

test('the edit hook protects the worktree of the dispatched role, and the stop gate holds a reviewer until its record exists', () => {
	const { repo, worktree, env } = fixture({ role: 'researcher' });
	setPointer(worktree, env);
	const edit = (file) =>
		hook('edit-guard.mjs', env, { cwd: repo, agent_type: 'dev-factory:factory-researcher', tool_input: { file_path: file, content: 'x' } });
	assert.equal(edit(path.join(worktree, 'services/api/a.js')).status, 2);
	assert.equal(edit(path.join(worktree, 'docs/plans/OAPP-1/research.md')).status, 0);
	assert.equal(edit(path.join(worktree, '.dev-factory/blocked.json')).status, 0);
	const stop = hook('stop-gate.mjs', env, { cwd: repo, agent_type: 'dev-factory:factory-researcher' });
	assert.equal(stop.status, 2);
	fs.writeFileSync(path.join(worktree, '.dev-factory', 'blocked.json'), '{}');
	assert.equal(hook('stop-gate.mjs', env, { cwd: repo, agent_type: 'dev-factory:factory-researcher' }).status, 0);
});

test('qa.mjs reads the dispatched worktree through the pointer when run from the repo root', async () => {
	const { workRoot } = await import('../scripts/run-context.mjs');
	const { repo, worktree, env } = fixture({ role: 'reviewer' });
	assert.notEqual(workRoot({ cwd: repo, env }), worktree);
	setPointer(worktree, env);
	assert.equal(workRoot({ cwd: repo, env }), worktree);
	assert.equal(workRoot({ cwd: worktree, env }), worktree);
});
