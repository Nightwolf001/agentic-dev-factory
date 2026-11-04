import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { load } from '../scripts/config.mjs';
import { commitPending, decide, discardPending, fingerprintOf, isBuildable, prNeedsAction, prStateFor, savePending } from '../scripts/frontier.mjs';

const cfg = load();
const task = (key, extra = {}) => ({ key, state: 'ready', updated: '2026-10-15T10:00:00Z', labels: ['dev-factory'], blockedBy: [], ...extra });
// list() answers by the first state in the filter, so a test sets up the queue, the strays and the tasks in review separately
const deps = (byState, prs = {}) => ({ list: async ({ states }) => byState[states?.[0]] ?? [], prState: async (key) => prs[key] ?? null });

test('an unresolved blocker makes a task unbuildable', () => {
	assert.equal(isBuildable(task('A', { blockedBy: [{ key: 'B', done: false }] })), false);
	assert.equal(isBuildable(task('A', { blockedBy: [{ key: 'B', done: true }] })), true);
	assert.equal(isBuildable(task('A')), true);
});

test('empty frontier skips the session', async () => {
	const d = await decide({ cfg, deps: deps({}), state: null });
	assert.equal(d.run, false);
});

test('a stray or a merged PR always runs the session', async () => {
	assert.equal((await decide({ cfg, deps: deps({ inProgress: [task('S')] }), state: null })).run, true);
	assert.equal((await decide({ cfg, deps: deps({ inReview: [task('R')] }, { R: { state: 'MERGED' } }), state: null })).run, true);
	assert.equal((await decide({ cfg, deps: deps({ inReview: [task('R')] }, {}), state: null })).run, false);
});

test('strays are asked for with the configured stall window', async () => {
	let asked;
	await decide({ cfg, deps: { list: async (f) => ((asked = asked ?? f), []), prState: async () => null }, state: null });
	assert.deepEqual(asked, { states: ['inProgress'], staleMinutes: 90 });
});

test('an unchanged frontier is not re-dispatched until the repeat window passes', async () => {
	const ready = [task('F-1')];
	const first = await decide({ cfg, deps: deps({ ready }), state: null });
	assert.equal(first.run, true);
	const state = { fingerprint: first.fingerprint, at: new Date().toISOString() };
	assert.equal((await decide({ cfg, deps: deps({ ready }), state })).run, false);
	const later = Date.now() + 7 * 3600_000;
	assert.equal((await decide({ cfg, deps: deps({ ready }), state, now: later })).run, true);
	const changed = [task('F-1', { updated: '2026-10-15T11:00:00Z' })];
	assert.equal((await decide({ cfg, deps: deps({ ready: changed }), state })).run, true);
});

test('a stray defeats the fingerprint skip', async () => {
	const ready = [task('F-1')];
	const state = { fingerprint: fingerprintOf(ready), at: new Date().toISOString() };
	assert.equal((await decide({ cfg, deps: deps({ ready, inProgress: [task('S')] }), state })).run, true);
});

test('blocked frontier items are dropped before fingerprinting', async () => {
	const blocked = task('B', { blockedBy: [{ key: 'X', done: false }] });
	assert.equal((await decide({ cfg, deps: deps({ ready: [blocked] }), state: null })).run, false);
});

test('prStateFor finds the PR by the key in its title', () => {
	const calls = [];
	const run = (args) => {
		calls.push(args.join(' '));
		if (args[1] === 'list') return JSON.stringify([{ number: 7, title: 'Add thing [GH-12]', state: 'OPEN' }]);
		return JSON.stringify({
			state: 'OPEN',
			reviewDecision: 'APPROVED',
			author: { login: 'bot' },
			commits: [{ committedDate: 'x' }],
			reviews: [],
		});
	};
	const pr = prStateFor('GH-12', run);
	assert.match(calls[0], /GH-12 in:title/);
	assert.equal(pr.reviewDecision, 'APPROVED');
	assert.equal(
		prStateFor('GH-1', () => '[]'),
		null,
	);
});

test('prNeedsAction: advance on approved or merged, fix on a fresh change request only', () => {
	const base = { state: 'OPEN', author: 'bot', headCommittedAt: '2026-10-15T10:00:00Z', reviews: [], comments: [] };
	assert.equal(prNeedsAction(null), null);
	assert.equal(prNeedsAction({ ...base, state: 'MERGED' }), 'advance');
	assert.equal(prNeedsAction({ ...base, reviewDecision: 'APPROVED' }), 'advance');
	assert.equal(prNeedsAction(base), null);
	const req = { state: 'CHANGES_REQUESTED', submittedAt: '2026-10-15T11:00:00Z', author: 'fr' };
	assert.equal(prNeedsAction({ ...base, reviews: [req] }), 'fix');
	assert.equal(prNeedsAction({ ...base, headCommittedAt: '2026-10-15T12:00:00Z', reviews: [req] }), null);
	assert.equal(prNeedsAction({ ...base, reviews: [{ ...req, author: 'bot' }] }), null, 'the factory never answers its own review');
	// the same reviewer's later approval (or a dismissal) ends the request; another reviewer's request still stands
	const later = '2026-10-15T11:30:00Z';
	assert.equal(prNeedsAction({ ...base, reviews: [req, { state: 'APPROVED', submittedAt: later, author: 'fr' }] }), null);
	assert.equal(prNeedsAction({ ...base, reviews: [req, { state: 'DISMISSED', submittedAt: later, author: 'fr' }] }), null);
	assert.equal(prNeedsAction({ ...base, reviews: [req, { state: 'APPROVED', submittedAt: later, author: 'someone-else' }] }), 'fix');
	assert.equal(
		prNeedsAction({ ...base, reviews: [{ state: 'APPROVED', submittedAt: '2026-10-15T10:30:00Z', author: 'fr' }, req] }),
		'fix',
		'order of arrival does not matter, the later one wins',
	);
});

test('comments, bot reviews, questions and an LGTM never start a fix pass', () => {
	const base = { state: 'OPEN', author: 'bot', headCommittedAt: '2026-10-15T10:00:00Z', reviews: [], comments: [] };
	const at = '2026-10-15T11:00:00Z';
	assert.equal(prNeedsAction({ ...base, comments: [{ createdAt: at, author: 'fr' }] }), null);
	assert.equal(prNeedsAction({ ...base, comments: [{ createdAt: at, author: 'cursor' }] }), null);
	assert.equal(prNeedsAction({ ...base, reviews: [{ state: 'COMMENTED', submittedAt: at, author: 'cursor' }] }), null);
	assert.equal(prNeedsAction({ ...base, reviews: [{ state: 'COMMENTED', submittedAt: at, author: 'fr' }] }), null);
	assert.equal(prNeedsAction({ ...base, reviews: [{ state: 'DISMISSED', submittedAt: at, author: 'fr' }] }), null);
});

test('a frontier fingerprint is remembered only once the session is committed', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-frontier-'));
	assert.equal(commitPending(dir), false);
	savePending(dir, 'abc');
	assert.equal(fs.existsSync(path.join(dir, 'frontier.json')), false);
	discardPending(dir);
	assert.equal(commitPending(dir), false);
	savePending(dir, 'abc');
	assert.equal(commitPending(dir), true);
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'frontier.json'), 'utf8')).fingerprint, 'abc');
});

const open = { state: 'OPEN', author: 'fr', baseRefName: 'develop', headCommittedAt: '2026-10-15T10:00:00Z', reviews: [], comments: [] };
const later = '2026-10-15T11:00:00Z';

test('with pr.reviewedOnMergeInto set only a merge into that branch is reviewed; an approval is not', () => {
	const o = { reviewedOn: 'develop' };
	assert.equal(prNeedsAction({ ...open, state: 'MERGED' }, o), 'advance');
	assert.equal(prNeedsAction({ ...open, state: 'MERGED', baseRefName: 'feature/x' }, o), null);
	assert.equal(prNeedsAction({ ...open, reviewDecision: 'APPROVED' }, o), null);
});

test('with pr.doneOnMergeInto set, a merge into it, or a merge that reached it, is done', () => {
	const o = { reviewedOn: 'develop', doneOn: 'main' };
	assert.equal(prNeedsAction({ ...open, state: 'MERGED', baseRefName: 'main' }, o), 'done');
	assert.equal(prNeedsAction({ ...open, state: 'MERGED' }, o), 'advance', 'merged into develop only: reviewed, not done yet');
	assert.equal(prNeedsAction({ ...open, state: 'MERGED', reachedDone: true }, o), 'done', 'a release that carried the merge to main');
	assert.equal(prNeedsAction({ ...open, state: 'MERGED' }, { doneOn: 'main' }), 'advance', 'with no reviewedOn any merge is reviewed');
});

test('a comment that says the fix phrase, with or without the slash, newer than the head asks for a fix pass', () => {
	const o = { fixComment: 'dev-factory fix' };
	const c = (body, extra = {}) => ({ ...open, comments: [{ createdAt: later, author: 'fr', body, ...extra }] });
	assert.equal(prNeedsAction(c('dev-factory fix rename the helper'), o), 'fix');
	assert.equal(prNeedsAction(c('/dev-factory fix'), o), 'fix');
	assert.equal(prNeedsAction(c('Dev-Factory Fix: the date is wrong'), o), 'fix');
	assert.equal(prNeedsAction(c('thanks, looks fine'), o), null);
	assert.equal(prNeedsAction(c('please do not dev-factory fix this yet'), o), null, 'the phrase starts a line');
	assert.equal(prNeedsAction(c('dev-factory fix', { author: 'cursor[bot]' }), o), null, 'a bot never asks');
	assert.equal(prNeedsAction({ ...c('dev-factory fix'), headCommittedAt: '2026-10-15T12:00:00Z' }, o), null, 'answered by a later commit');
});

test('open Bugbot threads start a fix pass only when bugbot review is on', () => {
	const pr = { ...open, bugbotOpen: 2 };
	assert.equal(prNeedsAction(pr, { bugbot: true }), 'fix');
	assert.equal(prNeedsAction(pr, {}), null);
	assert.equal(prNeedsAction({ ...pr, bugbotOpen: 0 }, { bugbot: true }), null);
	assert.equal(prNeedsAction({ ...pr, state: 'MERGED' }, { bugbot: true }), 'advance');
});

test('a reviewed task is checked for done only when pr.doneOnMergeInto is set', async () => {
	const merged = { ...open, state: 'MERGED', reachedDone: true };
	const both = { ...cfg, pr: { ...cfg.pr, reviewedOnMergeInto: 'develop', doneOnMergeInto: 'main' } };
	const d = await decide({ cfg: both, deps: deps({ reviewed: [task('R', { state: 'reviewed' })] }, { R: merged }), state: null });
	assert.equal(d.run, true);
	assert.match(d.reason, /reached main/);
	assert.equal((await decide({ cfg, deps: deps({ reviewed: [task('R')] }, { R: merged }), state: null })).run, false);
});

test('prStateFor reads the base, comments, Bugbot threads and whether the merge reached the done branch', () => {
	const calls = [];
	let state = 'MERGED';
	const run = (args) => {
		calls.push(args.join(' '));
		if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{ number: 7, title: 'Add thing [GH-12]', state: 'MERGED' }]);
		if (args[0] === 'repo') return JSON.stringify({ owner: { login: 'o' }, name: 'r' });
		if (args[0] === 'pr') {
			return JSON.stringify({
				state,
				author: { login: 'fr' },
				baseRefName: 'develop',
				mergeCommit: { oid: 'abc123' },
				commits: [{ committedDate: 'x' }],
				reviews: [],
				comments: [{ author: { login: 'fr' }, createdAt: 'y', body: 'dev-factory fix it' }],
			});
		}
		if (args[0] === 'api' && args[1] === 'graphql') {
			const node = (resolved, login) => ({ isResolved: resolved, comments: { nodes: [{ author: { login } }] } });
			return JSON.stringify({
				data: {
					repository: {
						pullRequest: { reviewThreads: { nodes: [node(false, 'cursor[bot]'), node(true, 'cursor[bot]'), node(false, 'fr')] } },
					},
				},
			});
		}
		return 'behind';
	};
	const opts = { doneOn: 'main', bugbot: true, bugbotAuthor: 'cursor[bot]' };
	const pr = prStateFor('GH-12', run, opts);
	assert.equal(pr.baseRefName, 'develop');
	assert.equal(pr.comments[0].body, 'dev-factory fix it');
	assert.equal(pr.reachedDone, true);
	assert.equal(pr.bugbotOpen, 0, 'a merged PR has no threads to answer');
	state = 'OPEN';
	assert.equal(prStateFor('GH-12', run, opts).bugbotOpen, 1, 'one unresolved thread opened by the bot');
	state = 'MERGED';
	assert.ok(calls.some((c) => /compare\/main\.\.\.abc123/.test(c)));
	const quiet = prStateFor('GH-12', run);
	assert.equal(quiet.bugbotOpen, 0);
	assert.equal(quiet.reachedDone, false);
});

// ---- answers, fix requests on the ticket, and one decision ----
import { decisionFingerprint } from '../scripts/frontier.mjs';

const Q = '@jane\n\nWhich format?\n\n[dev-factory] blocked: question';
const cm = (body, id) => ({ id, body });
const withComments = (byState, prs, comments) => ({ ...deps(byState, prs), comments: async (key) => comments[key] ?? [] });
const asked = (extra = {}) => task('Q-1', { labels: ['dev-factory', 'factory-blocked', 'factory-question'], ...extra });
const lists = (byLabel, byState = {}) => ({
	list: async (f) => (f.label ? (byLabel[f.label] ?? []).filter((t) => !f.notStates?.includes(t.state)) : byState[f.states?.[0]] ?? []),
	prState: async () => null,
});

test('a person’s answer to a question the factory asked starts a session; a question still waiting does not', async () => {
	const base = lists({ 'factory-question': [asked()] });
	const waiting = await decide({ cfg, deps: { ...base, comments: async () => [cm(Q, 'q')] }, state: null });
	assert.equal(waiting.run, false);
	const answered = await decide({ cfg, deps: { ...base, comments: async () => [cm(Q, 'q'), cm('Use CSV', 'a1')] }, state: null });
	assert.equal(answered.run, true);
	assert.match(answered.reason, /1 answered question\(s\) \(Q-1\)/);
	assert.match(answered.fingerprint, /^v2:[0-9a-f]{40}$/);
	// a done task that still carries the label is not asked about
	const done = lists({ 'factory-question': [asked({ state: 'done' })] });
	assert.equal((await decide({ cfg, deps: { ...done, comments: async () => [cm(Q, 'q'), cm('Use CSV', 'a1')] }, state: null })).run, false);
	// withdrawn by the factory, or already taken up
	const cancelled = [cm(Q, 'q'), cm('Use CSV', 'a1'), cm('[dev-factory] blocked: factory', 'f')];
	assert.equal((await decide({ cfg, deps: { ...base, comments: async () => cancelled }, state: null })).run, false);
	const taken = [cm(Q, 'q'), cm('Use CSV', 'a1'), cm('[dev-factory] phase: resume started', 'p')];
	assert.equal((await decide({ cfg, deps: { ...base, comments: async () => taken }, state: null })).run, false);
	// a source whose comments cannot be read is no evidence of an answer
	assert.equal(
		(
			await decide({
				cfg,
				deps: {
					...base,
					comments: async () => {
						throw new Error('403');
					},
				},
				state: null,
			})
		).run,
		false,
	);
	assert.equal((await decide({ cfg, deps: base, state: null })).run, false, 'a source with no comments at all');
});

test('the same answer is not started twice within the repeat window, a new reply is, and so is the same one after the window', async () => {
	const base = lists({ 'factory-question': [asked()] });
	const make = (comments) => ({ ...base, comments: async () => comments });
	const first = await decide({ cfg, deps: make([cm(Q, 'q'), cm('Use CSV', 'a1')]), state: null });
	const state = { fingerprint: first.fingerprint, at: new Date().toISOString() };
	const again = await decide({ cfg, deps: make([cm(Q, 'q'), cm('Use CSV', 'a1')]), state });
	assert.equal(again.run, false);
	assert.match(again.reason, /nothing new/);
	assert.equal((await decide({ cfg, deps: make([cm(Q, 'q'), cm('Use CSV', 'a1'), cm('and a header', 'a2')]), state })).run, true, 'a new reply');
	const old = { fingerprint: first.fingerprint, at: new Date(Date.now() - 48 * 3600_000).toISOString() };
	assert.equal((await decide({ cfg, deps: make([cm(Q, 'q'), cm('Use CSV', 'a1')]), state: old })).run, true, 'after the window');
});

test('a fix request written on the ticket starts a session while the PR is open, once, until the factory answers it', async () => {
	const open = { state: 'OPEN', author: 'bot', headCommittedAt: '2026-10-15T10:00:00Z', reviews: [], comments: [] };
	const fix = [cm('looks fine', 'c0'), cm('dev-factory fix rename the helper', 'c1')];
	const d1 = await decide({ cfg, deps: withComments({ inReview: [task('R', { state: 'inReview' })] }, { R: open }, { R: fix }), state: null });
	assert.equal(d1.run, true);
	assert.match(d1.reason, /1 fix request\(s\) on the ticket \(R\)/);
	const state = { fingerprint: d1.fingerprint, at: new Date().toISOString() };
	assert.equal(
		(await decide({ cfg, deps: withComments({ inReview: [task('R')] }, { R: open }, { R: fix }), state })).run,
		false,
		'a pass that posted no marker is not repeated',
	);
	const closed = { ...open, state: 'CLOSED' };
	assert.equal(
		(await decide({ cfg, deps: withComments({ inReview: [task('R')] }, { R: closed }, { R: fix }), state: null })).run,
		false,
		'no open PR',
	);
	const answeredByFactory = [...fix, cm('[dev-factory] phase: fix round=1 started', 'c2')];
	assert.equal(
		(await decide({ cfg, deps: withComments({ inReview: [task('R')] }, { R: open }, { R: answeredByFactory }), state: null })).run,
		false,
	);
	const fixed = [cm('I fixed it', 'c1')];
	assert.equal(
		(await decide({ cfg, deps: withComments({ inReview: [task('R')] }, { R: open }, { R: fixed }), state: null })).run,
		false,
		'"fixed" is not the phrase',
	);
});

test('answers, fix requests and the ready queue are one decision, and the old fingerprint is still read', async () => {
	const queue = fingerprintOf([task('A')]);
	assert.equal(decisionFingerprint({ queue }), queue, 'nothing else: the queue’s own, which is what older versions stored');
	const a = decisionFingerprint({ queue, answers: [{ key: 'Q-1', ids: ['a1'] }] });
	const b = decisionFingerprint({ queue, answers: [{ key: 'Q-1', ids: ['a1', 'a2'] }] });
	const c2 = decisionFingerprint({ queue, fixes: [{ key: 'R', id: 'c1' }] });
	assert.equal(new Set([queue, a, b, c2]).size, 4);
	const c3 = decisionFingerprint({ queue, fixes: [{ key: 'R', id: 'c2' }] });
	assert.notEqual(c3, c2, 'a second fix request on the same ticket is a new decision');
	assert.equal(decisionFingerprint({ queue, answers: [{ key: 'Q-1', ids: ['a1'] }] }), a, 'stable');
	// an old state (queue fingerprint only) still holds the session back while the queue is unchanged
	const old = { fingerprint: queue, at: new Date().toISOString() };
	const same = await decide({ cfg, deps: deps({ ready: [task('A')] }), state: old });
	assert.equal(same.run, false);
	// ...and a new answer is a different decision, so it runs even though the queue is the one the old state knew
	const withAnswer = { ...lists({ 'factory-question': [asked()] }, { ready: [task('A')] }), comments: async () => [cm(Q, 'q'), cm('CSV', 'a1')] };
	const next = await decide({ cfg, deps: withAnswer, state: old });
	assert.equal(next.run, true);
	assert.match(next.reason, /1 answered question\(s\).*1 claimable task\(s\)/);
});

test('prStateFor takes the PR whose title ends in the key, preferring an open one', () => {
	const run = (list) => (args) =>
		args[1] === 'list'
			? JSON.stringify(list)
			: JSON.stringify({ state: 'OPEN', reviewDecision: null, author: { login: 'b' }, commits: [], reviews: [] });
	const calls = [];
	const pick = (list) => {
		let chosen;
		prStateFor('GH-1', (args) => (args[1] === 'view' ? ((chosen = args[2]), run(list)(args)) : run(list)(args)));
		return chosen;
	};
	void calls;
	assert.equal(
		pick([
			{ number: 5, title: 'Other [GH-12]', state: 'OPEN' },
			{ number: 6, title: 'Mine [GH-1]', state: 'OPEN' },
		]),
		'6',
		'GH-1 is not GH-12',
	);
	assert.equal(
		pick([
			{ number: 4, title: 'Old try [GH-1]', state: 'CLOSED' },
			{ number: 8, title: 'Retry [GH-1]', state: 'OPEN' },
		]),
		'8',
		'open first',
	);
	assert.equal(prStateFor('GH-1', run([{ number: 5, title: 'Mentions GH-1 in the middle', state: 'OPEN' }])), null);
});
