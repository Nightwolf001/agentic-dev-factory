import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { load, merge } from '../scripts/config.mjs';
import { run } from '../scripts/tasks.mjs';

const SCRIPT = new URL('../scripts/tasks.mjs', import.meta.url).pathname;

function repo(config = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-tasks-'));
	fs.writeFileSync(path.join(root, 'dev-factory.config.json'), JSON.stringify(config));
	const cli = (...args) => spawnSync('node', [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, DF_STATE_DIR: root } });
	const file = (name, text) => (fs.writeFileSync(path.join(root, name), text), path.join(root, name));
	return { root, cli, file };
}

test('the CLI drives a local plan end to end: init, create with blockers, list, claim, comment, block, finish', () => {
	const { cli, file, root } = repo();
	assert.equal(cli('init').status, 0);
	const body = file('b.md', '## Summary\nx\n\n## Acceptance criteria\n- works\n');
	const one = JSON.parse(cli('create', '--title', 'First slice', '--file', body, '--type', 'story').stdout);
	assert.equal(one.key, 'TASK-1');
	const two = JSON.parse(cli('create', '--title', 'Second slice', '--file', body, '--blocked-by', 'TASK-1', '--parent', 'TASK-1').stdout);
	assert.equal(two.key, 'TASK-2');
	assert.ok(fs.existsSync(path.join(root, '.factory/tasks')));

	const ready = JSON.parse(cli('list', '--state', 'ready').stdout);
	assert.deepEqual(
		ready.map((t) => t.key),
		['TASK-1', 'TASK-2'],
	);
	assert.equal(ready[1].blockedBy[0].done, false);

	assert.equal(cli('set-state', 'TASK-1', 'inProgress').status, 0);
	const note = file('c.txt', '[dev-factory] phase: claim started run=1');
	assert.equal(cli('comment', 'TASK-1', '--file', note).status, 0);
	assert.match(JSON.parse(cli('get', 'TASK-1').stdout).comments[0], /phase: claim started/);

	assert.equal(cli('block', 'TASK-1', '--reason', 'needs acceptance criteria', '--decision', 'add some').status, 0);
	const blocked = JSON.parse(cli('get', 'TASK-1').stdout);
	assert.equal(blocked.state, 'ready');
	assert.ok(blocked.labels.includes('factory-blocked'));
	assert.match(blocked.comments.at(-1), /blocked: needs acceptance criteria\. Decision needed: add some/);
	assert.deepEqual(
		JSON.parse(cli('list', '--state', 'ready').stdout).map((t) => t.key),
		['TASK-2'],
		'a blocked task leaves the queue',
	);
	assert.deepEqual(
		JSON.parse(cli('list', '--label', 'factory-blocked', '--updated-within-minutes', '60').stdout).map((t) => t.key),
		['TASK-1'],
	);

	assert.equal(cli('label', 'TASK-1', '--remove', 'factory-blocked').status, 0);
	cli('set-state', 'TASK-1', 'done');
	assert.equal(JSON.parse(cli('get', 'TASK-2').stdout).blockedBy[0].done, true);
});

test('the CLI refuses states it does not know and tells a Jira or Notion user where writes go', () => {
	const { cli } = repo();
	const bad = cli('set-state', 'TASK-1', 'finished');
	assert.equal(bad.status, 3);
	const jira = repo({ tasks: { source: 'jira' }, sources: { jira: { site: 's', cloudId: 'c', projects: ['APP'] } } });
	const r = jira.cli('set-state', 'APP-1', 'inProgress');
	assert.equal(r.status, 4);
	assert.match(r.stderr, /skills\/task-source\/jira\.md/);
});

test('run() takes an injected source, so any adapter can be exercised without a tracker', async () => {
	const cfg = merge(load(), { tasks: { source: 'jira' } });
	const calls = [];
	const source = { list: async (f) => (calls.push(f), []), setState: async (k, s) => calls.push([k, s]) };
	assert.deepEqual(await run(['list', '--state', 'ready'], { cfg, source }), []);
	await run(['set-state', 'APP-1', 'inReview'], { cfg, source });
	assert.deepEqual(calls[1], ['APP-1', 'inReview']);
});
