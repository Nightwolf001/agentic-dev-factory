import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { load, merge } from '../scripts/config.mjs';
import { normaliseRef, parseBlockedBy, stateOf } from '../scripts/sources/common.mjs';
import { githubSource } from '../scripts/sources/github.mjs';
import { jiraSource, jql, normalise as jiraNormalise } from '../scripts/sources/jira.mjs';
import { localSource } from '../scripts/sources/local.mjs';
import { notionSource } from '../scripts/sources/notion.mjs';
import { makeSource, missingCredentials } from '../scripts/sources/index.mjs';

const cfgFor = (over) => merge(load(), over);

// ---- blockers written in a description, the same in every tracker ----

test('Blocked by is read from a line, a list under a heading, #n and issue URLs', () => {
	assert.deepEqual(parseBlockedBy('Summary\n\nBlocked by: TASK-2, TASK-3\n\n## Out of scope\n- x'), ['TASK-2', 'TASK-3']);
	assert.deepEqual(parseBlockedBy('## Blocked by\n- #12\n- https://github.com/o/r/issues/13\n\n## Next\n- GH-99'), [
		'#12',
		'https://github.com/o/r/issues/13',
	]);
	assert.deepEqual(parseBlockedBy('**Blocked by:** APP-4'), ['APP-4']);
	assert.deepEqual(parseBlockedBy('Blocked by: none'), []);
	assert.deepEqual(parseBlockedBy('no dependencies here, see TASK-9'), []);
});

test('references normalise to task keys', () => {
	assert.equal(normaliseRef('#12'), 'GH-12');
	assert.equal(normaliseRef('https://github.com/o/r/issues/13'), 'GH-13');
	assert.equal(normaliseRef('app-4'), 'APP-4');
	assert.equal(normaliseRef('nonsense'), null);
});

test('a native status name maps to a logical state, case-insensitively, or to other', () => {
	const states = load().sources.jira.states;
	assert.equal(stateOf('peer review', states), 'inReview');
	assert.equal(stateOf('To Do', states), 'ready');
	assert.equal(stateOf('UAT', states), 'other');
});

// ---- local ----

function localFixture(over = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-local-'));
	let t = Date.parse('2026-10-15T10:00:00Z');
	const now = () => new Date((t += 60_000));
	const src = localSource(cfgFor(over), { root, env: {}, now });
	const at = (ms) => localSource(cfgFor(over), { root, env: {}, now: () => new Date(ms) });
	return { root, src, now, at };
}

test('local: create, list, claim, comment and finish a task through the files', async () => {
	const { root, src } = localFixture();
	const a = await src.create({ title: 'Add CSV export', body: '## Acceptance criteria\n- exports a csv', type: 'story' });
	assert.equal(a.key, 'TASK-1');
	assert.ok(fs.existsSync(a.file) && a.file.startsWith(path.join(root, '.factory/tasks')));
	const b = await src.create({ title: 'Download button', body: 'Blocked by: TASK-1', blockedBy: ['TASK-1'] });
	assert.equal(b.key, 'TASK-2');

	const ready = await src.list({ states: ['ready'] });
	assert.deepEqual(
		ready.map((x) => x.key),
		['TASK-1', 'TASK-2'],
	);
	assert.deepEqual(ready[1].blockedBy, [{ key: 'TASK-1', done: false }]);

	await src.setState('TASK-1', 'inProgress');
	await src.comment('TASK-1', '[dev-factory] phase: claim started run=1');
	const got = await src.get('TASK-1');
	assert.equal(got.state, 'inProgress');
	assert.deepEqual(
		got.comments.map((c) => c.replace(/^\S+ /, '')),
		['[dev-factory] phase: claim started run=1'],
	);
	assert.match(got.body, /exports a csv/);

	await src.setState('TASK-1', 'done');
	assert.deepEqual(
		(await src.list({ states: ['ready'] })).map((x) => x.key),
		['TASK-2'],
	);
	assert.deepEqual((await src.get('TASK-2')).blockedBy, [{ key: 'TASK-1', done: true }], 'finishing a blocker unblocks the dependent');
});

test('local: a blocked label keeps a task out of the ready queue until removed; stale in-progress tasks are strays', async () => {
	const { src, at } = localFixture();
	await src.create({ title: 'One', body: 'x' });
	await src.addLabel('TASK-1', 'factory-blocked');
	assert.deepEqual(await src.list({ states: ['ready'] }), []);
	await src.removeLabel('TASK-1', 'factory-blocked');
	assert.equal((await src.list({ states: ['ready'] })).length, 1);
	await src.setState('TASK-1', 'inProgress');
	assert.equal((await src.list({ states: ['inProgress'], staleMinutes: 90 })).length, 0);
	assert.equal(
		(await at(Date.parse('2026-10-15T14:00:00Z')).list({ states: ['inProgress'], staleMinutes: 90 })).length,
		1,
		'three hours later it is a stray',
	);
});

test('local: a task file written by hand is understood, including blockers in the body', async () => {
	const { root, src } = localFixture();
	const dir = path.join(root, '.factory/tasks');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'TASK-7-hand.md'),
		'---\nkey: TASK-7\ntitle: By hand\nstate: Ready\nlabels: [dev-factory, urgent]\nupdated: 2026-10-01T00:00:00Z\n---\nDo it\n\nBlocked by: TASK-8\n',
	);
	const [t] = await src.list({ states: ['ready'] });
	assert.equal(t.key, 'TASK-7');
	assert.deepEqual(t.labels, ['dev-factory', 'urgent']);
	assert.deepEqual(t.blockedBy, [{ key: 'TASK-8', done: false }]);
});

// ---- github ----

function fakeGh(issues) {
	const calls = [];
	const gh = (args, input) => {
		calls.push({ args, input });
		const a = args.join(' ');
		if (a.startsWith('issue list')) return JSON.stringify(issues.filter((i) => (a.includes('--state all') ? true : i.state === 'OPEN')));
		if (a.startsWith('issue view')) {
			const n = Number(args[2]);
			const i = issues.find((x) => x.number === n);
			if (!i) throw new Error('not found');
			return JSON.stringify(i);
		}
		if (a.startsWith('issue create')) return 'https://github.com/o/r/issues/42\n';
		return '';
	};
	return { gh, calls };
}
const issue = (number, extra = {}) => ({
	number,
	title: `T${number}`,
	state: 'OPEN',
	labels: [{ name: 'dev-factory' }],
	updatedAt: '2026-10-15T10:00:00Z',
	body: '',
	...extra,
});

test('github: state comes from labels, closed means done, and blockers are read from the body', async () => {
	const { gh } = fakeGh([
		issue(1),
		issue(2, { labels: [{ name: 'dev-factory' }, { name: 'df:in-review' }] }),
		issue(3, { body: 'Blocked by: #4, #5' }),
		issue(4, { state: 'CLOSED' }),
		issue(5),
		issue(6, { labels: [{ name: 'dev-factory' }, { name: 'factory-blocked' }] }),
	]);
	const src = githubSource(cfgFor({ tasks: { source: 'github' } }), { env: {}, gh });
	const ready = await src.list({ states: ['ready'] });
	assert.deepEqual(
		ready.map((t) => t.key),
		['GH-1', 'GH-3', 'GH-5'],
		'a blocked label keeps GH-6 out of the queue',
	);
	assert.deepEqual(ready.find((t) => t.key === 'GH-3').blockedBy, [
		{ key: 'GH-4', done: true },
		{ key: 'GH-5', done: false },
	]);
	assert.deepEqual(
		(await src.list({ states: ['inReview'] })).map((t) => t.key),
		['GH-2'],
	);
});

test('github: moving state swaps labels, closing finishes a task, and the repo and assignee filters are passed to gh', async () => {
	const { gh, calls } = fakeGh([issue(1)]);
	const src = githubSource(cfgFor({ tasks: { source: 'github' }, sources: { github: { repo: 'o/r', assignee: '@me' } } }), { env: {}, gh });
	await src.list({ states: ['ready'] });
	assert.match(calls[0].args.join(' '), /--repo o\/r/);
	assert.match(calls[0].args.join(' '), /--assignee @me/);
	calls.length = 0;
	await src.setState('GH-1', 'inProgress');
	const edit = calls.find((c) => c.args[1] === 'edit').args.join(' ');
	assert.match(edit, /--add-label df:in-progress/);
	assert.match(edit, /--remove-label df:in-review/);
	calls.length = 0;
	await src.setState('GH-1', 'done');
	assert.ok(calls.some((c) => c.args.slice(0, 2).join(' ') === 'issue close'));
});

test('github: create makes the labels, writes blockers into the body and returns the key', async () => {
	const { gh, calls } = fakeGh([]);
	const src = githubSource(cfgFor({ tasks: { source: 'github' } }), { env: {}, gh });
	const out = await src.create({ title: 'Slice', body: 'Body', type: 'story', blockedBy: ['GH-3'], parent: 'GH-1' });
	assert.equal(out.key, 'GH-42');
	const create = calls.find((c) => c.args[1] === 'create' && c.args[0] === 'issue');
	assert.match(create.input, /Blocked by: GH-3/);
	assert.match(create.input, /Parent: GH-1/);
	assert.ok(calls.some((c) => c.args.join(' ').startsWith('label create dev-factory')));
});

// ---- jira ----

test('jira: queries carry the configured projects, label, stale window and blocked label, with keys quoted', () => {
	const cfg = cfgFor({ tasks: { source: 'jira' }, sources: { jira: { site: 's', cloudId: 'c', projects: ['APP', 'MAX'], requireSprint: true } } });
	const ready = jql(cfg, { states: ['ready'] }, {});
	assert.match(ready, /project in \("APP", "MAX"\)/);
	assert.match(ready, /status in \("Ready for Dev", "To Do"\)/);
	assert.match(ready, /labels != "factory-blocked"/);
	assert.match(ready, /sprint in openSprints\(\)/);
	assert.match(ready, /ORDER BY Rank ASC$/);
	assert.match(jql(cfg, { states: ['inProgress'], staleMinutes: 90 }, {}), /status in \("In Progress"\) AND updated <= -90m/);
	assert.doesNotMatch(jql(cfgFor({ tasks: { source: 'jira' }, sources: { jira: { projects: ['APP'] } } }), { states: ['ready'] }, {}), /sprint/);
});

test('jira: the blocker is the inwardIssue of an "is blocked by" link, as Jira returns it on the blocked issue', () => {
	const cfg = cfgFor({
		tasks: { source: 'jira' },
		sources: { jira: { site: 's', cloudId: 'c', projects: ['APP'], states: { done: ['Done', 'UAT'] } } },
	});
	const type = { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
	const status = (name, key) => ({ name, statusCategory: { key } });
	const mk = (links) => ({ key: 'APP-2', fields: { summary: 'x', status: status('To Do', 'new'), updated: 'u', labels: [], issuelinks: links } });
	const blocked = jiraNormalise(mk([{ type, inwardIssue: { key: 'APP-1', fields: { status: status('In Progress', 'indeterminate') } } }]), cfg, {});
	assert.deepEqual(blocked.blockedBy, [{ key: 'APP-1', done: false }]);
	const byName = jiraNormalise(mk([{ type, inwardIssue: { key: 'APP-1', fields: { status: status('UAT', 'indeterminate') } } }]), cfg, {});
	assert.deepEqual(byName.blockedBy, [{ key: 'APP-1', done: true }], 'a configured done status unblocks even in an in-progress category');
	const blocker = jiraNormalise(mk([{ type, outwardIssue: { key: 'APP-3', fields: { status: status('To Do', 'new') } } }]), cfg, {});
	assert.deepEqual(blocker.blockedBy, [], 'the issue that blocks others is itself claimable');
});

test('jira: list sends the JQL with basic auth and normalises the answer', async () => {
	const cfg = cfgFor({ tasks: { source: 'jira' }, sources: { jira: { site: 'example.atlassian.net', cloudId: 'c', projects: ['APP'] } } });
	let seen;
	const fetchImpl = async (url, init) => {
		seen = { url, init };
		return {
			ok: true,
			json: async () => ({
				issues: [
					{ key: 'APP-1', fields: { summary: 's', status: { name: 'To Do' }, updated: 'u', labels: ['dev-factory'], issuelinks: [] } },
				],
			}),
		};
	};
	const src = jiraSource(cfg, { env: { JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 't' }, fetchImpl });
	const [t] = await src.list({ states: ['ready'] });
	assert.equal(t.key, 'APP-1');
	assert.equal(t.state, 'ready');
	assert.match(seen.url, /^https:\/\/example\.atlassian\.net\/rest\/api\/3\/search\/jql\?jql=/);
	assert.match(seen.init.headers.Authorization, /^Basic /);
});

// ---- notion ----

test('notion: list filters on the tag and status, derives keys from the unique ID and resolves relation blockers', async () => {
	const cfg = cfgFor({ tasks: { source: 'notion' }, sources: { notion: { databaseId: 'db1' } } });
	const page = (id, n, status, extra = {}) => ({
		id,
		last_edited_time: '2026-10-15T10:00:00Z',
		properties: {
			Name: { title: [{ plain_text: `Task ${n}` }] },
			Status: { status: { name: status } },
			Tags: { multi_select: [{ name: 'dev-factory' }] },
			ID: { unique_id: { prefix: 'TASK', number: n } },
			...extra,
		},
	});
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, body: init.body && JSON.parse(init.body) });
		const respond = (j) => ({ ok: true, json: async () => j });
		if (url.endsWith('/databases/db1')) return respond({ properties: { Status: { type: 'status' } } });
		if (url.endsWith('/databases/db1/query'))
			return respond({ results: [page('p1', 1, 'Ready'), page('p2', 2, 'Ready', { 'Blocked by': { relation: [{ id: 'p9' }] } })] });
		if (url.endsWith('/pages/p9')) return respond(page('p9', 9, 'Done'));
		throw new Error(url);
	};
	const src = notionSource(cfg, { env: { NOTION_TOKEN: 'secret' }, fetchImpl });
	const tasks = await src.list({ states: ['ready'] });
	assert.deepEqual(
		tasks.map((t) => t.key),
		['TASK-1', 'TASK-2'],
	);
	assert.deepEqual(tasks[1].blockedBy, [{ key: 'p9', done: true }]);
	const query = calls.find((c) => c.url.endsWith('/query')).body.filter;
	assert.deepEqual(query.and[0], { property: 'Tags', multi_select: { contains: 'dev-factory' } });
	assert.deepEqual(query.and[1], { or: [{ property: 'Status', status: { equals: 'Ready' } }] });
});

// ---- choosing a source ----

test('makeSource picks the configured source; tokens are required only where a script must call an API', () => {
	for (const [name, expect] of [
		['local', 'local'],
		['github', 'github'],
		['jira', 'jira'],
		['notion', 'notion'],
	]) {
		const cfg = cfgFor({
			tasks: { source: name },
			sources: { jira: { site: 's', cloudId: 'c', projects: ['APP'] }, notion: { databaseId: 'd' } },
		});
		assert.equal(makeSource(cfg, { env: { JIRA_EMAIL: 'e', JIRA_API_TOKEN: 't', NOTION_TOKEN: 'n' } }).name, expect);
	}
	assert.equal(missingCredentials(cfgFor({}), {}), null);
	assert.equal(missingCredentials(cfgFor({ tasks: { source: 'github' } }), {}), null);
	assert.match(missingCredentials(cfgFor({ tasks: { source: 'jira' } }), {}), /JIRA_API_TOKEN/);
	assert.match(missingCredentials(cfgFor({ tasks: { source: 'notion' } }), {}), /NOTION_TOKEN/);
	assert.equal(missingCredentials(cfgFor({ tasks: { source: 'jira' } }), { JIRA_EMAIL: 'e', JIRA_API_TOKEN: 't' }), null);
});
