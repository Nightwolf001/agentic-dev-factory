import './isolate-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { EXIT, mergeArgs } from '../scripts/automerge-lib.mjs';
import { run } from '../scripts/automerge.mjs';

const cfg = {
	autoMerge: { enabled: true, label: 'auto-merge', maxSize: 'small', method: 'squash' },
	pr: { sizeLabels: { small: 100, medium: 500, large: null } },
	review: { bugbot: false, bugbotAuthor: 'cursor[bot]' },
	tasks: { blockedLabel: 'factory-blocked', questionLabel: 'factory-question' },
};
const withCfg = (over) => ({ ...cfg, ...over });

// A non-draft, CLEAN, 40-line PR at commit abc123.
const view = (over = {}) => ({
	number: 7,
	state: 'OPEN',
	isDraft: false,
	headRefOid: 'abc123',
	headRefName: 'task/APP-1-x',
	mergeStateStatus: 'CLEAN',
	reviewDecision: '',
	additions: 30,
	deletions: 10,
	body: '',
	statusCheckRollup: [],
	...over,
});

// Fake gh and qa that record every argv. Nothing here can reach a real gh or qa.
function harness({ pr = view(), threads, graphql, ghThrows = {}, verifyStatus = 0, review = { clean: true, triggered: [] }, config = cfg } = {}) {
	const ghCalls = [];
	const qaCalls = [];
	const gh = (argv) => {
		ghCalls.push(argv);
		const key = argv.slice(0, 2).join(' ');
		if (ghThrows[key]) throw new Error(ghThrows[key]);
		if (key === 'pr view') return JSON.stringify(pr);
		if (key === 'repo view') return JSON.stringify({ owner: { login: 'acme' }, name: 'shop' });
		if (key === 'api graphql') {
			if (graphql instanceof Error) throw graphql;
			return (
				graphql ??
				JSON.stringify({
					data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads ?? [] } } } },
				})
			);
		}
		if (key === 'pr ready' || key === 'pr merge') return '';
		throw new Error(`unexpected gh call: ${argv.join(' ')}`);
	};
	const qa = (argv) => {
		qaCalls.push(argv);
		if (argv[0] === 'verify') return { status: verifyStatus, stdout: '' };
		if (argv[0] === 'review' && argv[1] === 'status') return { status: 0, stdout: JSON.stringify(review) };
		throw new Error(`unexpected qa call: ${argv.join(' ')}`);
	};
	const writes = () => ghCalls.filter((a) => a[0] === 'pr' && (a[1] === 'ready' || a[1] === 'merge'));
	return { deps: { gh, qa, cfg: config }, ghCalls, qaCalls, writes };
}

const args = (extra = []) => ['run', '--pr', '7', '--key', 'APP-1', '--labels', '', '--worktree', '/tmp/wt', ...extra];

test('an eligible non-draft PR merges with exactly the merge argv, pinned to the head of the view it decided on', async () => {
	const h = harness();
	const { code, result } = await run(args(), h.deps);
	assert.equal(code, EXIT.DONE);
	assert.equal(result.action, 'merged');
	assert.equal(result.via, 'small');
	assert.equal(result.pr, 7);
	assert.equal(result.head, 'abc123');
	assert.equal(result.lines, 40);
	assert.deepEqual(h.writes(), [mergeArgs({ pr: 7, head: 'abc123', method: 'squash' })]);
	assert.deepEqual(h.writes()[0].slice(-2), ['--match-head-commit', 'abc123']);
	assert.equal(h.ghCalls.filter((a) => a[0] === 'pr' && a[1] === 'view').length, 1, 'one view, so the pinned commit is the one that was checked');
	assert.ok(!h.writes()[0].includes('--admin') && !h.writes()[0].includes('--auto'));
	assert.deepEqual(h.ghCalls.at(-1), h.writes()[0], 'the merge is the last call');
});

test('the PR is read with the fields the decision needs', async () => {
	const h = harness();
	await run(args(), h.deps);
	const v = h.ghCalls[0];
	assert.deepEqual(v.slice(0, 3), ['pr', 'view', '7']);
	assert.equal(v[3], '--json');
	for (const f of [
		'number',
		'state',
		'isDraft',
		'headRefOid',
		'headRefName',
		'mergeStateStatus',
		'reviewDecision',
		'additions',
		'deletions',
		'body',
		'statusCheckRollup',
	])
		assert.ok(v[4].split(',').includes(f), f);
});

test('an eligible draft is made ready with exactly one gh pr ready and no merge', async () => {
	const h = harness({ pr: view({ isDraft: true, mergeStateStatus: 'UNSTABLE' }) });
	const { code, result } = await run(args(), h.deps);
	assert.equal(code, EXIT.DONE);
	assert.equal(result.action, 'ready');
	assert.deepEqual(h.writes(), [['pr', 'ready', '7']]);
});

test('--dry-run performs no write and still says what it would do', async () => {
	for (const [pr, action] of [
		[view(), 'merge'],
		[view({ isDraft: true }), 'ready'],
	]) {
		const h = harness({ pr });
		const { code, result } = await run(args(['--dry-run']), h.deps);
		assert.equal(code, EXIT.DONE);
		assert.equal(result.action, action);
		assert.equal(result.dryRun, true);
		assert.deepEqual(h.writes(), []);
	}
});

test('off, wait and refused make no write and exit 12, 10 and 11', async () => {
	const off = harness({ config: withCfg({ autoMerge: { ...cfg.autoMerge, enabled: false } }) });
	let r = await run(args(), off.deps);
	assert.equal(r.code, EXIT.OFF);
	assert.equal(r.result.action, 'off');
	assert.deepEqual(off.writes(), []);

	const big = harness({ pr: view({ additions: 900, deletions: 0 }) });
	r = await run(args(), big.deps);
	assert.equal(r.code, EXIT.OFF, 'neither small nor labelled is a PR for a person');
	assert.equal(r.result.action, 'off');
	assert.deepEqual(big.writes(), []);

	const wait = harness({ pr: view({ mergeStateStatus: 'BLOCKED' }) });
	r = await run(args(), wait.deps);
	assert.equal(r.code, EXIT.WAIT);
	assert.equal(r.result.action, 'wait');
	assert.match(r.result.reasons.join(' '), /BLOCKED/);
	assert.deepEqual(wait.writes(), []);

	const refused = harness({ verifyStatus: 1 });
	r = await run(args(), refused.deps);
	assert.equal(r.code, EXIT.REFUSED);
	assert.equal(r.result.action, 'refused');
	assert.deepEqual(r.result.reasons, ['QA has not passed at this commit']);
	assert.deepEqual(refused.writes(), []);
});

test('a labelled larger PR merges via the label, with labels read from --labels as trimmed strings', async () => {
	const h = harness({ pr: view({ additions: 900, deletions: 100 }) });
	const { code, result } = await run(
		args().map((a, i, all) => (all[i - 1] === '--labels' ? ' bug , auto-merge ,, ' : a)),
		h.deps,
	);
	assert.equal(code, EXIT.DONE);
	assert.equal(result.action, 'merged');
	assert.equal(result.via, 'label');
	assert.deepEqual(result.notes, ['labelled task, 1000 changed lines']);
});

test('a parked label refuses', async () => {
	const h = harness();
	const { code, result } = await run(
		args().map((a, i, all) => (all[i - 1] === '--labels' ? 'factory-blocked' : a)),
		h.deps,
	);
	assert.equal(code, EXIT.REFUSED);
	assert.deepEqual(result.reasons, ['the task is parked']);
	assert.deepEqual(h.writes(), []);
});

test('a draft a person re-drafted at the readied head is refused', async () => {
	const h = harness({ pr: view({ isDraft: true }) });
	const { code, result } = await run(args(['--readied-head', 'abc123']), h.deps);
	assert.equal(code, EXIT.REFUSED);
	assert.match(result.reasons.join(' '), /draft again/);
	assert.deepEqual(h.writes(), []);
	const moved = harness({ pr: view({ isDraft: true }) });
	assert.equal((await run(args(['--readied-head', 'old999']), moved.deps)).result.action, 'ready');
});

test('a failing pr view is failed/21 with no write', async () => {
	const h = harness({ ghThrows: { 'pr view': 'gh: not logged in' } });
	const { code, result } = await run(args(), h.deps);
	assert.equal(code, EXIT.UNKNOWN);
	assert.equal(result.action, 'failed');
	assert.match(result.reasons.join(' '), /not logged in/);
	assert.deepEqual(h.writes(), []);
});

test('a merge that throws (the head moved) is failed/21 and is not retried or replaced', async () => {
	const h = harness({ ghThrows: { 'pr merge': 'head branch was modified' } });
	const { code, result } = await run(args(), h.deps);
	assert.equal(code, EXIT.UNKNOWN);
	assert.equal(result.action, 'failed');
	assert.match(result.reasons.join(' '), /head branch was modified/);
	assert.equal(h.writes().length, 1, 'exactly one attempt');
	assert.equal(h.ghCalls.filter((a) => a[1] === 'ready').length, 0);
});

test('a ready call that throws is failed/21', async () => {
	const h = harness({ pr: view({ isDraft: true }), ghThrows: { 'pr ready': 'boom' } });
	const { code, result } = await run(args(), h.deps);
	assert.equal(code, EXIT.UNKNOWN);
	assert.equal(result.action, 'failed');
	assert.equal(h.writes().length, 1);
});

test('bad input is failed/21 before anything is asked or written', async () => {
	for (const bad of [
		['run', '--pr', 'x', '--key', 'K', '--worktree', '/w'],
		['run', '--pr', '0', '--key', 'K', '--worktree', '/w'],
		['run', '--pr', '7', '--worktree', '/w'],
		['run', '--pr', '7', '--key', 'K'],
	]) {
		const h = harness();
		const { code, result } = await run(bad, h.deps);
		assert.equal(code, EXIT.UNKNOWN, bad.join(' '));
		assert.equal(result.action, 'failed');
		assert.deepEqual(h.ghCalls, []);
		assert.deepEqual(h.qaCalls, []);
	}
});

test('verified is qa verify at the viewed head, and review is the JSON of qa review status', async () => {
	const h = harness();
	await run(args(), h.deps);
	assert.deepEqual(h.qaCalls[0], ['verify', '--head', 'abc123', '--key', 'APP-1', '--require-review', 'true', '--worktree', '/tmp/wt']);
	assert.deepEqual(h.qaCalls[1], ['review', 'status', '--worktree', '/tmp/wt']);

	const dirty = harness({ review: { clean: false, triggered: [] } });
	assert.equal((await run(args(), dirty.deps)).result.reasons[0], 'review not clean');
	const triggered = harness({ review: { clean: true, triggered: ['security'] } });
	assert.match((await run(args(), triggered.deps)).result.reasons[0], /specialist review step is required \(security\)/);
});

test('qa review status that fails or prints no JSON is failed/21, never a clean review', async () => {
	for (const bad of [
		{ status: 1, stdout: '' },
		{ status: 0, stdout: 'not json' },
	]) {
		const h = harness();
		const deps = { ...h.deps, qa: (argv) => (argv[0] === 'verify' ? { status: 0, stdout: '' } : bad) };
		const { code, result } = await run(args(), deps);
		assert.equal(code, EXIT.UNKNOWN);
		assert.equal(result.action, 'failed');
		assert.deepEqual(h.writes(), []);
	}
});

test('with Bugbot off nothing is asked of GitHub about it', async () => {
	const h = harness();
	await run(args(), h.deps);
	assert.deepEqual(
		h.ghCalls.map((a) => a.slice(0, 2).join(' ')),
		['pr view', 'pr merge'],
	);
});

const bugbotCfg = withCfg({ review: { bugbot: true, bugbotAuthor: 'cursor[bot]' } });
const thread = (resolved, login) => ({ isResolved: resolved, comments: { nodes: [{ author: { login } }] } });

test('with Bugbot on, unresolved threads by the bot author come from a graphql query, never a mutation', async () => {
	const h = harness({ config: bugbotCfg, threads: [thread(false, 'cursor[bot]'), thread(true, 'cursor[bot]'), thread(false, 'someone')] });
	const { code, result } = await run(args(), h.deps);
	assert.equal(code, EXIT.WAIT);
	assert.equal(result.action, 'wait');
	assert.match(result.reasons.join(' '), /1 bot review thread\(s\) unresolved/);
	assert.deepEqual(h.writes(), []);
	const q = h.ghCalls.find((a) => a[0] === 'api');
	assert.deepEqual(q.slice(0, 2), ['api', 'graphql']);
	const text = q.join(' ');
	assert.match(text, /query=query\(/);
	assert.doesNotMatch(text, /mutation/i);
	assert.ok(q.includes('owner=acme') && q.includes('name=shop') && q.includes('n=7'));
});

test('with Bugbot on and nothing open or pending, the PR merges', async () => {
	const h = harness({
		config: bugbotCfg,
		threads: [thread(true, 'cursor[bot]')],
		pr: view({
			statusCheckRollup: [
				{ name: 'build', status: 'IN_PROGRESS' },
				{ name: 'Cursor Bugbot', status: 'COMPLETED' },
			],
		}),
	});
	const { code, result } = await run(args(), h.deps);
	assert.equal(code, EXIT.DONE);
	assert.equal(result.action, 'merged');
});

test('a Bugbot check that is not completed is pending and waits; another check is not Bugbot', async () => {
	const h = harness({ config: bugbotCfg, pr: view({ statusCheckRollup: [{ name: 'Cursor Bugbot', status: 'IN_PROGRESS' }] }) });
	const { code, result } = await run(args(), h.deps);
	assert.equal(code, EXIT.WAIT);
	assert.match(result.reasons.join(' '), /still running/);
	const other = harness({ config: bugbotCfg, pr: view({ statusCheckRollup: [{ name: 'lint', status: 'IN_PROGRESS' }] }) });
	assert.equal((await run(args(), other.deps)).result.action, 'merged');
});

test('a Bugbot fetch that fails or has an unexpected shape waits as unknown, never as zero', async () => {
	for (const o of [
		{ graphql: new Error('network') },
		{ graphql: JSON.stringify({ data: null }) },
		{ graphql: 'not json' },
		{ graphql: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [] } } } } }) },
		{ pr: view({ statusCheckRollup: undefined }) },
		{ ghThrows: { 'repo view': 'no repo' } },
	]) {
		const h = harness({ config: bugbotCfg, ...o });
		const { code, result } = await run(args(), h.deps);
		assert.equal(code, EXIT.WAIT, JSON.stringify(o));
		assert.equal(result.action, 'wait');
		assert.match(result.reasons.join(' '), /bot review state unknown/);
		assert.deepEqual(h.writes(), []);
	}
});

test('automerge.mjs runs outside the agents sandbox, where gh can reach the network and its credentials', () => {
	const settings = JSON.parse(fs.readFileSync(new URL('../settings.factory.json', import.meta.url), 'utf8'));
	assert.ok(settings.sandbox.excludedCommands.includes('node *automerge.mjs*'));
});
