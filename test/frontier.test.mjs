import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { load } from '../scripts/config.mjs';
import { commitPending, decide, discardPending, savePending, fingerprintOf, isBuildable, prNeedsAction, queries } from '../scripts/frontier.mjs';

const cfg = load();
const issue = (key, extra = {}) => ({ key, fields: { status: { name: 'To Do' }, updated: '2026-10-15T10:00:00Z', issuelinks: [], ...extra } });
const deps = (map, prs = {}) => ({
	search: async (jql) => map[Object.keys(queries(cfg)).find((k) => queries(cfg)[k] === jql)] ?? [],
	prState: async (key) => prs[key] ?? null,
});

test('queries carry the configured projects, label, stall window and blocked label', () => {
	const q = queries(cfg);
	assert.match(q.frontier, /project in \("OAPP", "PLAT", "ONE", "MAX"\)/);
	assert.match(q.frontier, /status in \("Ready for Dev", "To Do"\)/);
	assert.match(q.frontier, /labels != "factory-blocked"/);
	assert.match(q.strays, /status = "In Progress" AND updated <= -90m/);
	assert.match(q.peerReview, /status = "Peer review"/);
});

test('an unresolved blocker makes an issue unbuildable', () => {
	const link = (cat) => ({ type: { inward: 'is blocked by' }, inwardIssue: { fields: { status: { statusCategory: { key: cat } } } } });
	assert.equal(isBuildable(issue('A', { issuelinks: [link('indeterminate')] })), false);
	assert.equal(isBuildable(issue('A', { issuelinks: [link('done')] })), true);
});

test('empty frontier skips the session', async () => {
	const d = await decide({ cfg, deps: deps({}), state: null });
	assert.equal(d.run, false);
});

test('a stray or a merged PR always runs the session', async () => {
	assert.equal((await decide({ cfg, deps: deps({ strays: [issue('S')] }), state: null })).run, true);
	assert.equal((await decide({ cfg, deps: deps({ peerReview: [issue('R')] }, { R: { state: 'MERGED' } }), state: null })).run, true);
	assert.equal((await decide({ cfg, deps: deps({ peerReview: [issue('R')] }, {}), state: null })).run, false);
});

test('an unchanged frontier is not re-dispatched until the repeat window passes', async () => {
	const frontier = [issue('F-1')];
	const first = await decide({ cfg, deps: deps({ frontier }), state: null });
	assert.equal(first.run, true);
	const state = { fingerprint: first.fingerprint, at: new Date().toISOString() };
	assert.equal((await decide({ cfg, deps: deps({ frontier }), state })).run, false);
	const later = Date.now() + 7 * 3600_000;
	assert.equal((await decide({ cfg, deps: deps({ frontier }), state, now: later })).run, true);
	const changed = [issue('F-1', { updated: '2026-10-15T11:00:00Z' })];
	assert.equal((await decide({ cfg, deps: deps({ frontier: changed }), state })).run, true);
});

test('a stray defeats the fingerprint skip', async () => {
	const frontier = [issue('F-1')];
	const state = { fingerprint: fingerprintOf(frontier), at: new Date().toISOString() };
	assert.equal((await decide({ cfg, deps: deps({ frontier, strays: [issue('S')] }), state })).run, true);
});

test('blocked frontier items are dropped before fingerprinting', async () => {
	const blocked = issue('B', {
		issuelinks: [{ type: { inward: 'is blocked by' }, inwardIssue: { fields: { status: { statusCategory: { key: 'new' } } } } }],
	});
	assert.equal((await decide({ cfg, deps: deps({ frontier: [blocked] }), state: null })).run, false);
});

test('done statuses count by name, so UAT and Ready for Release unblock', () => {
	const link = (name, cat) => ({ type: { inward: 'is blocked by' }, inwardIssue: { fields: { status: { name, statusCategory: { key: cat } } } } });
	const done = ['UAT', 'Ready for Release', 'Done'];
	assert.equal(isBuildable(issue('A', { issuelinks: [link('UAT', 'indeterminate')] }), done), true);
	assert.equal(isBuildable(issue('A', { issuelinks: [link('Ready for Release', 'done')] }), done), true);
	assert.equal(isBuildable(issue('A', { issuelinks: [link('Peer review', 'indeterminate')] }), done), false);
	assert.equal(isBuildable(issue('A', { issuelinks: [link('UAT', 'indeterminate')] }), []), false);
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

test('the blocker is the inwardIssue of an "is blocked by" link, as Jira returns it on the blocked issue', () => {
	// Shape taken from a live Jira site: OAPP-3617 blocks OAPP-3619. The blocked issue lists the blocker as inwardIssue,
	// the blocker lists the blocked issue as outwardIssue with the same type.
	const type = { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
	const status = (name, key) => ({ name, statusCategory: { key } });
	const blocked = issue('OAPP-3619', {
		issuelinks: [{ type, inwardIssue: { key: 'OAPP-3617', fields: { status: status('In Progress', 'indeterminate') } } }],
	});
	const blocker = issue('OAPP-3617', {
		issuelinks: [{ type, outwardIssue: { key: 'OAPP-3619', fields: { status: status('Ready for Dev', 'new') } } }],
	});
	assert.equal(isBuildable(blocked), false, 'blocked by an unfinished issue');
	assert.equal(isBuildable(blocker), true, 'the blocker itself is claimable although the issue it blocks is not done');
	const finished = issue('OAPP-3619', { issuelinks: [{ type, inwardIssue: { key: 'OAPP-3617', fields: { status: status('Done', 'done') } } }] });
	assert.equal(isBuildable(finished), true);
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
