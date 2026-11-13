import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT, changedLines, decide, mergeArgs, scope, sizeBound } from '../scripts/automerge-lib.mjs';

const cfg = {
	autoMerge: { enabled: true, label: 'auto-merge', maxSize: 'small', method: 'squash' },
	pr: { sizeLabels: { small: 100, medium: 500, large: null } },
	tasks: { blockedLabel: 'factory-blocked', questionLabel: 'factory-question' },
};

// An all-eligible, non-draft, CLEAN, 40-line PR. Each test changes the one thing it is about.
const base = (over = {}) => ({
	cfg,
	labels: [],
	pr: {
		state: 'OPEN',
		isDraft: false,
		headRefOid: 'abc123',
		headRefName: 'task/APP-1-x',
		mergeStateStatus: 'CLEAN',
		reviewDecision: '',
		additions: 30,
		deletions: 10,
		body: '',
	},
	verified: true,
	review: { clean: true, triggered: [] },
	bugbot: { unresolved: 0, pending: false },
	readiedHead: null,
	...over,
});
const withPr = (pr, over = {}) => base({ pr: { ...base().pr, ...pr }, ...over });
const withCfg = (autoMerge) => ({ ...cfg, autoMerge: { ...cfg.autoMerge, ...autoMerge } });

test('changedLines adds additions and deletions, and a missing field counts as 0', () => {
	assert.equal(changedLines({ additions: 30, deletions: 10 }), 40);
	assert.equal(changedLines({ additions: 7 }), 7);
	assert.equal(changedLines({}), 0);
	assert.equal(changedLines(undefined), 0);
});

test('sizeBound reads the configured size label; a bound below 1 means nothing is small', () => {
	assert.equal(sizeBound(cfg), 100);
	assert.equal(sizeBound(withPr({}, { cfg: withCfg({ maxSize: 'medium' }) }).cfg), 500);
	assert.equal(sizeBound({ ...cfg, pr: { sizeLabels: { small: 0 } } }), 0);
	assert.equal(sizeBound({ ...cfg, pr: { sizeLabels: { small: -5 } } }), 0);
	assert.equal(sizeBound({ ...cfg, pr: { sizeLabels: { small: null } } }), 0);
});

test('off when disabled, even for a small PR that carries the label', () => {
	const r = decide(base({ cfg: withCfg({ enabled: false }), labels: ['auto-merge'] }));
	assert.equal(r.action, 'off');
	assert.equal(r.via, null);
	assert.deepEqual(r.reasons, []);
});

test('a small PR with no label merges, via small', () => {
	const r = decide(base());
	assert.equal(r.action, 'merge');
	assert.equal(r.via, 'small');
	assert.deepEqual(r.reasons, []);
});

test('a 5,000-line PR with no label is off: it is a PR for a person, not a refusal', () => {
	const r = decide(withPr({ additions: 4000, deletions: 1000 }));
	assert.equal(r.action, 'off');
	assert.equal(r.via, null);
	assert.deepEqual(r.reasons, []);
});

test('the label authorises a larger PR, compared case-insensitively and trimmed', () => {
	for (const labels of [['Auto-Merge'], [' auto-merge ', 'x']]) {
		const r = decide(withPr({ additions: 4000, deletions: 1000 }, { labels }));
		assert.equal(r.action, 'merge');
		assert.equal(r.via, 'label');
		assert.ok(r.notes.includes('labelled task, 5000 changed lines'), r.notes.join('|'));
	}
});

test('the label wins when the PR is also small, and then there is no size note', () => {
	const r = decide(base({ labels: ['auto-merge'] }));
	assert.equal(r.action, 'merge');
	assert.equal(r.via, 'label');
	assert.deepEqual(r.notes, []);
});

test('a configured label is compared the same way', () => {
	const r = decide(withPr({ additions: 900 }, { cfg: withCfg({ label: ' Ship-It ' }), labels: ['ship-it'] }));
	assert.equal(r.action, 'merge');
	assert.equal(r.via, 'label');
});

test('the blocked and the question label refuse, case-insensitively', () => {
	for (const label of ['factory-blocked', 'factory-question', 'Factory-Blocked']) {
		const r = decide(base({ labels: [label] }));
		assert.equal(r.action, 'refused', label);
		assert.match(r.reasons.join('|'), /the task is parked/, label);
	}
	const labelled = decide(base({ labels: ['auto-merge', 'factory-blocked'] }));
	assert.equal(labelled.action, 'refused');
});

test('size without the label: 100 lines merge, 101 are off', () => {
	assert.equal(decide(withPr({ additions: 100, deletions: 0 })).action, 'merge');
	assert.equal(decide(withPr({ additions: 60, deletions: 40 })).action, 'merge');
	assert.equal(decide(withPr({ additions: 101, deletions: 0 })).action, 'off');
	assert.equal(decide(withPr({ additions: 1, deletions: 100 })).action, 'off');
});

test('an empty PR is refused, with and without the label, rather than ignored', () => {
	for (const labels of [[], ['auto-merge']]) {
		for (const pr of [
			{ additions: 0, deletions: 0 },
			{ additions: undefined, deletions: undefined },
		]) {
			const r = decide(withPr(pr, { labels }));
			assert.equal(r.action, 'refused');
			assert.match(r.reasons.join('|'), /no changed lines/);
		}
	}
	const noFields = base();
	delete noFields.pr.additions;
	delete noFields.pr.deletions;
	assert.equal(decide(noFields).action, 'refused');
	assert.match(decide(noFields).reasons.join('|'), /no changed lines/);
});

test('the size bound follows autoMerge.maxSize', () => {
	const medium = withCfg({ maxSize: 'medium' });
	assert.equal(decide(withPr({ additions: 500, deletions: 0 }, { cfg: medium })).action, 'merge');
	assert.equal(decide(withPr({ additions: 501, deletions: 0 }, { cfg: medium })).action, 'off');
});

test('a bound below 1 makes nothing small, but a labelled task is still eligible', () => {
	const none = { ...cfg, pr: { sizeLabels: { small: 0 } } };
	assert.equal(decide(base({ cfg: none })).action, 'off');
	const labelled = decide(base({ cfg: none, labels: ['auto-merge'] }));
	assert.equal(labelled.action, 'merge');
	assert.equal(labelled.via, 'label');
	assert.equal(decide(withPr({ additions: 0, deletions: 0 }, { cfg: none })).action, 'off');
});

test('a stacked PR still merges once its blocker merged, with a note', () => {
	const r = decide(
		withPr(
			{ body: 'This PR is stacked on PR #5 (branch `task/APP-1-x`): review only the commits after it.' },
			{ blocker: { pr: 5, state: 'MERGED' } },
		),
	);
	assert.equal(r.action, 'merge');
	assert.ok(
		r.notes.some((n) => n.includes('stacked on PR #5')),
		r.notes.join('|'),
	);
});

test('a stacked PR waits while its blocker is open, closed or unknown, so it never lands on the blocker branch', () => {
	const body = 'This PR is stacked on PR #5 (branch `task/APP-1-x`): review only the commits after it.';
	for (const [blocker, reason] of [
		[{ pr: 5, state: 'OPEN' }, 'its blocker PR #5 is not merged yet'],
		[{ pr: 5, state: 'CLOSED' }, 'its blocker PR #5 was closed without merging'],
		[undefined, 'its blocker PR #5 state is unknown'],
		[null, 'its blocker PR #5 state is unknown'],
		[{ pr: 5 }, 'its blocker PR #5 state is unknown'],
		[{ pr: 5, state: 'WHATEVER' }, 'its blocker PR #5 state is unknown'],
		[{ pr: 6, state: 'MERGED' }, 'its blocker PR #5 state is unknown'],
	]) {
		for (const isDraft of [false, true]) {
			const r = decide(withPr({ body, isDraft }, { blocker }));
			assert.equal(r.action, 'wait', JSON.stringify(blocker));
			assert.deepEqual(r.reasons, [reason], JSON.stringify(blocker));
		}
	}
	// a permanent reason still wins
	assert.equal(decide(withPr({ body }, { blocker: { pr: 5, state: 'OPEN' }, verified: false })).action, 'refused');
});

test('a PR that is not stacked needs no blocker fact', () => {
	assert.equal(decide(base({ blocker: undefined })).action, 'merge');
	assert.equal(decide(base({ blocker: { pr: 5, state: 'OPEN' } })).action, 'merge');
});

test('with Bugbot on but not yet run at this commit, the PR waits', () => {
	for (const bugbot of [
		{ unresolved: 0, pending: false, notRun: true },
		{ unresolved: 0, pending: true, notRun: true },
	]) {
		const r = decide(base({ bugbot }));
		assert.equal(r.action, 'wait');
		assert.ok(r.reasons.includes('the bot review has not run at this commit'), r.reasons.join('|'));
		assert.ok(!r.reasons.includes('the bot review is still running'), r.reasons.join('|'));
	}
	assert.equal(decide(base({ bugbot: { unresolved: 0, pending: false } })).action, 'merge', 'Bugbot off is unchanged');
});

test('an autoMerge.label equal to tasks.label authorises nothing, since every factory task carries it', () => {
	for (const label of ['dev-factory', ' Dev-Factory ']) {
		const c = { ...withCfg({ label }), tasks: { ...cfg.tasks, label: 'dev-factory' } };
		const r = decide(withPr({ additions: 4000, deletions: 1000 }, { cfg: c, labels: ['dev-factory'] }));
		assert.equal(r.action, 'off', label);
		// a small PR still merges, by size
		assert.equal(decide(base({ cfg: c, labels: ['dev-factory'] })).via, 'small');
	}
});

test('scope answers small, label or null from the config, the labels and the PR alone', () => {
	assert.equal(scope({ cfg, labels: [], pr: { additions: 40 } }), 'small');
	assert.equal(scope({ cfg, labels: ['auto-merge'], pr: { additions: 4000 } }), 'label');
	assert.equal(scope({ cfg, labels: ['auto-merge'], pr: { additions: 4 } }), 'label');
	assert.equal(scope({ cfg, labels: [], pr: { additions: 4000 } }), null);
	assert.equal(scope({ cfg: withCfg({ enabled: false }), labels: ['auto-merge'], pr: { additions: 4 } }), null);
	assert.equal(scope({}), null);
});

test('a PR with decisions made without a person still merges, with a note', () => {
	const r = decide(withPr({ body: 'Summary\n\n## Decisions made without a person\n\n- chose X' }));
	assert.equal(r.action, 'merge');
	assert.ok(
		r.notes.some((n) => n.includes('carries decisions made without a person')),
		r.notes.join('|'),
	);
});

test('a PR with neither has no notes', () => {
	assert.deepEqual(decide(withPr({ body: 'Just a summary.' })).notes, []);
	assert.deepEqual(decide(withPr({ body: null })).notes, []);
});

test('notes only appear when the PR is about to be readied or merged', () => {
	const body = 'This PR is stacked on PR #5 (branch `x`)';
	assert.deepEqual(decide(withPr({ body }, { verified: false })).notes, []);
	assert.deepEqual(decide(withPr({ body, mergeStateStatus: 'BLOCKED' })).notes, []);
});

test('each permanent gate refuses', () => {
	const cases = [
		['the PR is not open', withPr({ state: 'MERGED' })],
		["the branch is for the factory's own changes", withPr({ headRefName: 'ai-tooling/x' })],
		['QA has not passed at this commit', base({ verified: false })],
		['review not clean', base({ review: { clean: false, triggered: [] } })],
		['a specialist review step is required (security)', base({ review: { clean: true, triggered: ['security'] } })],
		['changes were requested', withPr({ reviewDecision: 'CHANGES_REQUESTED' })],
		['the branch has conflicts', withPr({ mergeStateStatus: 'DIRTY' })],
	];
	for (const [reason, input] of cases) {
		const r = decide(input);
		assert.equal(r.action, 'refused', reason);
		assert.deepEqual(r.reasons, [reason]);
		assert.deepEqual(r.notes, [], reason);
	}
});

test('several failures list all their reasons at once', () => {
	const r = decide(
		withPr(
			{ state: 'CLOSED', mergeStateStatus: 'DIRTY', reviewDecision: 'CHANGES_REQUESTED' },
			{ verified: false, review: { clean: false, triggered: ['data', 'security'] }, labels: ['factory-blocked'] },
		),
	);
	assert.equal(r.action, 'refused');
	assert.equal(r.reasons.length, 7);
	for (const re of [
		/not open/,
		/QA has not passed/,
		/review not clean/,
		/specialist review step is required \(data, security\)/,
		/changes were requested/,
		/parked/,
		/conflicts/,
	]) {
		assert.match(r.reasons.join('|'), re);
	}
});

test('a transient state waits, and never reads as a refusal', () => {
	const waits = [
		withPr({ mergeStateStatus: 'BLOCKED' }),
		withPr({ mergeStateStatus: 'UNSTABLE' }),
		withPr({ mergeStateStatus: 'BEHIND' }),
		withPr({ mergeStateStatus: 'UNKNOWN' }),
		base({ bugbot: { unresolved: 1, pending: false } }),
		base({ bugbot: { unresolved: 0, pending: true } }),
	];
	for (const input of waits) {
		const r = decide(input);
		assert.equal(r.action, 'wait');
		assert.ok(r.reasons.length > 0);
		assert.doesNotMatch(r.reasons.join('|'), /refus/i);
	}
});

test('a permanent reason beats a transient one', () => {
	const r = decide(withPr({ mergeStateStatus: 'BLOCKED' }, { verified: false }));
	assert.equal(r.action, 'refused');
	assert.deepEqual(r.reasons, ['QA has not passed at this commit']);
});

test('a draft is readied, not merged, and waits only on the bots, not on the merge state', () => {
	const draft = { isDraft: true, mergeStateStatus: 'DRAFT' };
	const ready = decide(withPr(draft));
	assert.equal(ready.action, 'ready');
	assert.equal(ready.via, 'small');
	assert.equal(decide(withPr(draft, { bugbot: { unresolved: 2, pending: false } })).action, 'wait');
});

test('a draft a person made a draft again is refused; an older readied commit is not', () => {
	const draft = { isDraft: true, mergeStateStatus: 'DRAFT' };
	const again = decide(withPr(draft, { readiedHead: 'abc123' }));
	assert.equal(again.action, 'refused');
	assert.match(again.reasons.join('|'), /made a draft again/);
	assert.equal(decide(withPr(draft, { readiedHead: 'older999' })).action, 'ready');
	assert.equal(decide(withPr(draft, { readiedHead: null })).action, 'ready');
	// a non-draft with the same recorded head is simply ready for merge
	assert.equal(decide(withPr({}, { readiedHead: 'abc123' })).action, 'merge');
});

test('mergeArgs is the exact argument list, with no admin and no auto', () => {
	assert.deepEqual(mergeArgs({ pr: 7, head: 'abc', method: 'squash' }), ['pr', 'merge', '7', '--squash', '--match-head-commit', 'abc']);
	assert.deepEqual(mergeArgs({ pr: 8, head: 'def', method: 'rebase' }), ['pr', 'merge', '8', '--rebase', '--match-head-commit', 'def']);
	for (const method of ['squash', 'merge', 'rebase']) {
		const args = mergeArgs({ pr: 1, head: 'h', method });
		assert.ok(!args.includes('--admin'));
		assert.ok(!args.includes('--auto'));
	}
});

test('unknown bot state waits instead of merging: absent, empty or non-numeric', () => {
	const unknown = [
		base({ bugbot: undefined }),
		base({ bugbot: null }),
		base({ bugbot: {} }),
		base({ bugbot: { unresolved: undefined } }),
		base({ bugbot: { unresolved: NaN } }),
		base({ bugbot: { unresolved: '0' } }),
	];
	for (const input of unknown) {
		const r = decide(input);
		assert.equal(r.action, 'wait');
		assert.ok(r.reasons.includes('bot review state unknown'), r.reasons.join('|'));
	}
	const off = decide(base({ bugbot: { unresolved: 0, pending: false } }));
	assert.equal(off.action, 'merge', 'a repository with Bugbot off passes zero and is not penalised');
});

test('a blank configured label, with a task tagged blank, authorises nothing', () => {
	const r = decide(withPr({ additions: 4000, deletions: 1000 }, { cfg: withCfg({ label: '' }), labels: [' ', ''] }));
	assert.equal(r.action, 'off');
	assert.equal(r.via, null);
});

test('null review or null pr is a missing fact: refused, never a throw, never a merge', () => {
	const noReview = decide(base({ review: null }));
	assert.equal(noReview.action, 'refused');
	assert.match(noReview.reasons.join('|'), /review not clean/);
	const noPr = decide({ ...base(), pr: null });
	assert.notEqual(noPr.action, 'merge');
	assert.equal(noPr.action, 'refused');
});

test('mergeArgs throws for anything it must not build', () => {
	const ok = { pr: 7, head: 'abc', method: 'squash' };
	for (const method of ['admin', 'auto', undefined, '', 'Squash', 'squash --admin'])
		assert.throws(() => mergeArgs({ ...ok, method }), /method/, String(method));
	for (const head of ['', '  ', undefined, null, 5]) assert.throws(() => mergeArgs({ ...ok, head }), /head/, String(head));
	for (const pr of [0, -1, undefined, null, '7', 1.5, NaN]) assert.throws(() => mergeArgs({ ...ok, pr }), /pr/, String(pr));
	assert.throws(() => mergeArgs());
	for (const method of ['squash', 'merge', 'rebase']) {
		assert.deepEqual(mergeArgs({ pr: 12, head: 'deadbeef', method }), ['pr', 'merge', '12', `--${method}`, '--match-head-commit', 'deadbeef']);
	}
});

test('EXIT carries the documented codes', () => {
	assert.deepEqual(EXIT, { DONE: 0, WAIT: 10, REFUSED: 11, OFF: 12, UNKNOWN: 21 });
});
