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

// ---- LINK: where the work is ----

import { branchUrl } from '../scripts/tasks.mjs';

test('a branch given by name becomes its GitHub URL; a URL is kept', async () => {
	const resolve = async () => 'https://github.com/o/r/';
	assert.equal(await branchUrl('feature/TASK-1-x', resolve), 'https://github.com/o/r/tree/feature/TASK-1-x');
	assert.equal(await branchUrl('https://github.com/o/r/tree/b', resolve), 'https://github.com/o/r/tree/b');
});

test('local: link records the branch, PR and verdict in the task file and keeps a copy of the screenshots beside the tasks', () => {
	const { cli, file, root } = repo();
	cli('init');
	const body = file('b.md', '## Acceptance criteria\n- works\n');
	cli('create', '--title', 'Slice', '--file', body);
	const a = file('login.png', 'png-a');
	const b = file('arm.png', 'png-b');
	const r = cli(
		'link',
		'TASK-1',
		'--branch',
		'https://github.com/o/r/tree/feature/TASK-1-slice',
		'--pr',
		'https://github.com/o/r/pull/7',
		'--qa-verdict',
		'pass',
		'--evidence',
		`${a},${b}`,
	);
	assert.equal(r.status, 0, r.stderr);
	const text = fs.readFileSync(
		path.join(
			root,
			'.factory/tasks',
			fs.readdirSync(path.join(root, '.factory/tasks')).find((f) => f.endsWith('.md')),
		),
		'utf8',
	);
	assert.match(text, /^branch: https:\/\/github\.com\/o\/r\/tree\/feature\/TASK-1-slice$/m);
	assert.match(text, /^pr: https:\/\/github\.com\/o\/r\/pull\/7$/m);
	assert.match(text, /^qaVerdict: pass$/m);
	assert.match(text, /^evidence: \[evidence\/TASK-1\/login\.png, evidence\/TASK-1\/arm\.png\]$/m);
	assert.equal(fs.readFileSync(path.join(root, '.factory/tasks/evidence/TASK-1/arm.png'), 'utf8'), 'png-b');
	// the file still reads as a task
	assert.deepEqual(
		JSON.parse(cli('list', '--state', 'ready').stdout).map((t) => t.key),
		['TASK-1'],
	);
});

test('github: link is one comment that points at the branch and the PR; nothing when there is nothing to say', async () => {
	const calls = [];
	const gh = (args, input) => (calls.push({ args, input }), '');
	const { githubSource } = await import('../scripts/sources/github.mjs');
	const { merge, load } = await import('../scripts/config.mjs');
	const src = githubSource(merge(load(), { tasks: { source: 'github' } }), { env: {}, gh });
	await src.link('GH-12', { branch: 'https://github.com/o/r/tree/b', pr: 'https://github.com/o/r/pull/7', qaVerdict: 'pass' });
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].args.slice(0, 3), ['issue', 'comment', '12']);
	assert.equal(calls[0].input, '[dev-factory] links: branch https://github.com/o/r/tree/b, PR https://github.com/o/r/pull/7, QA pass');
	await src.link('GH-12', {});
	assert.equal(calls.length, 1);
});

test('link is a tracker write: refused to factory agents, and Jira or Notion send the caller to their MCP server', () => {
	const jira = repo({ tasks: { source: 'jira' }, sources: { jira: { site: 's', cloudId: 'c', projects: ['APP'] } } });
	const r = jira.cli('link', 'APP-1', '--pr', 'https://x/pull/1');
	assert.equal(r.status, 4);
	assert.match(r.stderr, /skills\/task-source\/jira\.md/);
});
