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
const deps = (byState, prs = {}) => ({ list: async ({ states }) => byState[states[0]] ?? [], prState: async (key) => prs[key] ?? null });

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
		if (args[1] === 'list') return JSON.stringify([{ number: 7 }]);
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
