import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { load, validate } from '../scripts/config.mjs';
import { decide, prNeedsAction, prStateFor } from '../scripts/frontier.mjs';
import { parseStackNote, pathsIn, planStack, stackAction, stackNote, stackSettings, syncBranch } from '../scripts/stack-lib.mjs';

const pr = (n, head, over = {}) => ({ number: n, state: 'OPEN', headRefName: head, baseRefName: 'develop', onOrigin: true, chain: [head], ...over });
const blocker = (key, over = {}) => ({ key, done: false, taskState: 'inReview', pr: pr(1, `task/${key}-x`), ...over });
const plan = (blockers, extra = {}) =>
	planStack({ blockers, text: blockers.map((b) => `Blocked by: ${b.key}`).join('\n'), enabled: true, maxDepth: 3, ...extra });

test('no unmerged blocker builds on the default base, whatever the switch says', () => {
	assert.deepEqual(plan([], { enabled: false }), { action: 'build', base: null });
	assert.equal(plan([blocker('A-1', { done: true, pr: null })]).action, 'build');
});

test('the switch is off by default: an open PR does not unblock a task', () => {
	const p = plan([blocker('A-1')], { enabled: false });
	assert.equal(p.action, 'wait');
	assert.match(p.reason, /unblockOnPr/);
	assert.equal(stackSettings(load()).enabled, false);
	assert.equal(stackSettings(load()).maxDepth, 3);
});

test('one blocker with an open PR on origin: stack on its branch', () => {
	const p = plan([blocker('A-1')]);
	assert.deepEqual(p, { action: 'stack', base: 'task/A-1-x', pr: 1, depth: 2 });
	assert.equal(plan([blocker('A-1', { taskState: 'reviewed' })]).action, 'stack');
});

test('a blocker that is done does not hold the others back', () => {
	const p = plan([blocker('A-1', { done: true, pr: null }), blocker('B-2', { pr: pr(2, 'task/B-2-x') })]);
	assert.equal(p.action, 'stack');
	assert.equal(p.base, 'task/B-2-x');
});

test('blockers in ready or in progress keep the task out', () => {
	assert.equal(plan([blocker('A-1', { taskState: 'ready', pr: null })]).action, 'wait');
	assert.equal(plan([blocker('A-1', { taskState: 'inProgress', pr: null })]).action, 'wait');
	// a mix: one stackable, one still being built
	const p = plan([blocker('A-1'), blocker('B-2', { taskState: 'inProgress', pr: null })]);
	assert.equal(p.action, 'wait');
	assert.match(p.reason, /B-2/);
});

test('a blocker without an open PR on origin cannot be stacked on', () => {
	assert.equal(plan([blocker('A-1', { pr: null })]).action, 'wait');
	assert.equal(plan([blocker('A-1', { pr: pr(1, 'x', { state: 'CLOSED' }) })]).action, 'wait');
	assert.equal(
		plan([blocker('A-1', { pr: pr(1, 'x', { state: 'MERGED' }) })]).action,
		'wait',
		'merged but not done yet: wait for the people who move it',
	);
	assert.equal(plan([blocker('A-1', { pr: pr(1, 'x', { onOrigin: false }) })]).action, 'wait', 'a fork branch is not on origin');
});

test('several blockers that form a chain: stack on the one that contains the others', () => {
	const a = blocker('A-1', { pr: pr(1, 'task/a') });
	const b = blocker('B-2', { pr: pr(2, 'task/b', { baseRefName: 'task/a', chain: ['task/b', 'task/a'] }) });
	const p = plan([a, b]);
	assert.equal(p.action, 'stack');
	assert.equal(p.base, 'task/b');
	assert.equal(p.depth, 3);
	assert.equal(plan([b, a]).base, 'task/b', 'order does not matter');
});

test('a chain may pass through a PR that is not itself a blocker', () => {
	const a = blocker('A-1', { pr: pr(1, 'task/a') });
	const c = blocker('C-3', { pr: pr(3, 'task/c', { baseRefName: 'task/b', chain: ['task/c', 'task/b', 'task/a'] }) });
	assert.equal(plan([a, c], { maxDepth: 4 }).base, 'task/c');
});

test('independent sibling blockers wait: the safe default', () => {
	const p = plan([blocker('A-1', { pr: pr(1, 'task/a') }), blocker('B-2', { pr: pr(2, 'task/b') })]);
	assert.equal(p.action, 'wait');
	assert.match(p.reason, /independent/);
	assert.match(p.reason, /A-1/);
	assert.match(p.reason, /B-2/);
});

test('the stack depth cap counts the new PR', () => {
	const deep = (n) => blocker('A-1', { pr: pr(1, 'task/c', { chain: ['task/c', 'task/b', 'task/a'].slice(0, n) }) });
	assert.equal(plan([deep(2)], { maxDepth: 3 }).action, 'stack');
	assert.equal(plan([deep(2)], { maxDepth: 3 }).depth, 3);
	const capped = plan([deep(3)], { maxDepth: 3 });
	assert.equal(capped.action, 'wait');
	assert.match(capped.reason, /maxStackDepth/);
});

test('a task whose scope does not touch the blocker is not stacked', () => {
	const b = blocker('A-1', { files: ['src/billing/invoice.ts'] });
	const unrelated = planStack({ blockers: [b], text: 'Add a dark mode toggle in src/ui/theme.ts', enabled: true, maxDepth: 3 });
	assert.equal(unrelated.action, 'wait');
	assert.match(unrelated.reason, /scope/);
	const sameFiles = planStack({ blockers: [b], text: 'Extend src/billing/invoice.ts with a tax line', enabled: true, maxDepth: 3 });
	assert.equal(sameFiles.action, 'stack');
	const linked = planStack({ blockers: [b], text: 'Blocked by: A-1', enabled: true, maxDepth: 3 });
	assert.equal(linked.action, 'stack');
});

test('a Base branch line naming the blocker branch is an explicit override of the scope check', () => {
	const b = blocker('A-1', { files: [] });
	const p = planStack({ blockers: [b], text: 'Unrelated words\nBase branch: task/A-1-x', enabled: true, maxDepth: 3 });
	assert.equal(p.action, 'stack');
	assert.equal(p.base, 'task/A-1-x');
	const other = planStack({ blockers: [b], text: 'Blocked by: A-1\nBase branch: feature/other', enabled: true, maxDepth: 3 });
	assert.equal(other.action, 'wait', 'an override that is not the blocker leaves the blocker unresolved');
});

test('the preflight can skip the scope check; the session applies it', () => {
	const b = blocker('A-1');
	assert.equal(planStack({ blockers: [b], text: '', enabled: true, maxDepth: 3, checkScope: false }).action, 'stack');
});

test('pathsIn reads file paths out of a ticket', () => {
	assert.deepEqual(pathsIn('Change `src/a/b.ts` and scripts/x.mjs, not the word and/or. See https://example.com/a/b.html'), [
		'src/a/b.ts',
		'scripts/x.mjs',
	]);
});

test('the stack note round-trips', () => {
	const note = stackNote({ number: 12, branch: 'task/A-1-x' });
	assert.match(note, /stacked on PR #12/);
	assert.deepEqual(parseStackNote(`Summary\n\n${note}\n\nmore`), { number: 12, branch: 'task/A-1-x' });
	assert.equal(parseStackNote('no note here'), null);
	assert.equal(parseStackNote(undefined), null);
});

// ---- what a stacked dependent needs once its blocker moves
const dep = (stack, over = {}) => ({
	state: 'OPEN',
	baseRefName: 'task/a',
	stack: { number: 1, branch: 'task/a', state: 'OPEN', containsHead: true, ...stack },
	...over,
});

test('stackAction: nothing to do while the blocker is open and contained', () => {
	assert.equal(stackAction(dep({})), null);
	assert.equal(stackAction({ state: 'OPEN', baseRefName: 'develop' }), null);
});

test('stackAction: new commits on the blocker are merged in before building further', () => {
	assert.equal(stackAction(dep({ containsHead: false })), 'restack');
});

test('stackAction: the blocker merged into develop (squash or not) means retarget', () => {
	assert.equal(stackAction(dep({ state: 'MERGED', baseRefName: 'develop', containsMerge: false })), 'retarget');
	// GitHub already retargeted the PR when the blocker branch was deleted, but the branch lacks the merge
	assert.equal(stackAction(dep({ state: 'MERGED', baseRefName: 'develop', containsMerge: false }, { baseRefName: 'develop' })), 'retarget');
	assert.equal(stackAction(dep({ state: 'MERGED', baseRefName: 'develop', containsMerge: true }, { baseRefName: 'develop' })), null);
});

test('stackAction: a blocker closed unmerged blocks the dependent', () => {
	assert.equal(stackAction(dep({ state: 'CLOSED' })), 'abandoned');
});

test('prNeedsAction reports stack actions before a fix request', () => {
	const base = { author: 'bot', headCommittedAt: '2026-10-15T10:00:00Z', reviews: [], comments: [] };
	const req = { state: 'CHANGES_REQUESTED', submittedAt: '2026-10-15T11:00:00Z', author: 'fr' };
	assert.equal(prNeedsAction({ ...base, ...dep({ containsHead: false }), reviews: [req] }), 'restack');
	assert.equal(prNeedsAction({ ...base, ...dep({ state: 'CLOSED' }) }), 'abandoned');
	assert.equal(prNeedsAction({ ...base, ...dep({ state: 'MERGED', baseRefName: 'develop', containsMerge: false }) }), 'retarget');
	assert.equal(prNeedsAction({ ...base, ...dep({}), reviews: [req] }), 'fix');
});

test('a stacked PR merged into its blocker branch is neither reviewed nor done', () => {
	const merged = { ...dep({}), state: 'MERGED', reviews: [], comments: [] };
	// reviewed with no pr.reviewedOnMergeInto would otherwise be "any merge"
	assert.equal(prNeedsAction(merged, {}), null);
	assert.equal(prNeedsAction(merged, { reviewedOn: 'develop' }), null);
	assert.equal(prNeedsAction(merged, { reviewedOn: 'develop', doneOn: 'main' }), null);
	// once the work has reached the done branch the existing rule applies
	assert.equal(prNeedsAction({ ...merged, reachedDone: true }, { doneOn: 'main' }), 'done');
	// the same merge into develop (after the retarget) is an ordinary one
	const retargeted = { ...merged, baseRefName: 'develop' };
	assert.equal(prNeedsAction(retargeted, { reviewedOn: 'develop' }), 'advance');
	assert.equal(prNeedsAction(retargeted, {}), 'advance');
});

// ---- the frontier preflight
const task = (key, extra = {}) => ({ key, state: 'ready', updated: '2026-10-15T10:00:00Z', labels: ['dev-factory'], blockedBy: [], ...extra });
const on = () => ({ ...load(), tasks: { ...load().tasks, unblockOnPr: true } });
const lists = (byState, prs) => ({ list: async ({ states }) => byState[states[0]] ?? [], prState: async (key) => prs[key] ?? null });

test('frontier: a task blocked by an in-review task with an open PR is claimable when the switch is on', async () => {
	const dependent = task('B-2', { blockedBy: [{ key: 'A-1', done: false }] });
	const deps = lists(
		{ ready: [dependent], inReview: [task('A-1', { state: 'inReview' })] },
		{
			'A-1': {
				state: 'OPEN',
				number: 1,
				headRefName: 'task/a',
				baseRefName: 'develop',
				onOrigin: true,
				chain: ['task/a'],
				reviews: [],
				comments: [],
			},
		},
	);
	assert.equal((await decide({ cfg: on(), deps, state: null })).run, true);
	assert.equal((await decide({ cfg: load(), deps, state: null })).run, false, 'off by default');
});

test('frontier: blockers in progress or ready keep it out; siblings wait', async () => {
	const dependent = task('B-2', { blockedBy: [{ key: 'A-1', done: false }] });
	assert.equal((await decide({ cfg: on(), deps: lists({ ready: [dependent], inProgress: [] }, {}), state: null })).run, false);
	const two = task('C-3', {
		blockedBy: [
			{ key: 'A-1', done: false },
			{ key: 'B-2', done: false },
		],
	});
	const open = (n, h) => ({
		state: 'OPEN',
		number: n,
		headRefName: h,
		baseRefName: 'develop',
		onOrigin: true,
		chain: [h],
		reviews: [],
		comments: [],
	});
	const deps = lists(
		{ ready: [two], inReview: [task('A-1', { state: 'inReview' }), task('B-2', { state: 'inReview' })] },
		{ 'A-1': open(1, 'task/a'), 'B-2': open(2, 'task/b') },
	);
	assert.equal((await decide({ cfg: on(), deps, state: null })).run, false);
});

test('frontier: a dependent whose blocker merged or closed starts a session', async () => {
	const inReview = [task('B-2', { state: 'inReview' })];
	const merged = dep({ state: 'MERGED', baseRefName: 'develop', containsMerge: false });
	const d = await decide({ cfg: on(), deps: lists({ inReview }, { 'B-2': { ...merged, reviews: [], comments: [] } }), state: null });
	assert.equal(d.run, true);
	assert.match(d.reason, /retarget/);
	const closed = await decide({
		cfg: on(),
		deps: lists({ inReview }, { 'B-2': { ...dep({ state: 'CLOSED' }), reviews: [], comments: [] } }),
		state: null,
	});
	assert.match(closed.reason, /closed/);
});

test('prStateFor reads the stack note, the blocker and the containment of its commits', () => {
	const calls = [];
	const run = (args) => {
		calls.push(args.join(' '));
		if (args[1] === 'list') return JSON.stringify([{ number: 7 }]);
		if (args[1] === 'view' && args[2] === '7')
			return JSON.stringify({
				number: 7,
				state: 'OPEN',
				author: { login: 'bot' },
				commits: [],
				reviews: [],
				comments: [],
				baseRefName: 'task/a',
				headRefName: 'task/b',
				headRefOid: 'bbb',
				isCrossRepository: false,
				body: `x\n${stackNote({ number: 5, branch: 'task/a' })}`,
			});
		if (args[1] === 'view' && args[2] === '5')
			return JSON.stringify({ number: 5, state: 'OPEN', headRefName: 'task/a', headRefOid: 'aaa', baseRefName: 'develop', body: '' });
		if (args[0] === 'api') return 'ahead';
		throw new Error(`unexpected ${args.join(' ')}`);
	};
	const s = prStateFor('B-2', run);
	assert.deepEqual(s.stack, { number: 5, branch: 'task/a', state: 'OPEN', baseRefName: 'develop', containsHead: true, containsMerge: false });
	assert.deepEqual(s.chain, ['task/b', 'task/a']);
	assert.equal(s.onOrigin, true);
	assert.ok(calls.some((c) => /compare\/aaa\.\.\.bbb/.test(c)));
});

// ---- the git side: bringing a dependent branch up to date without rewriting it
const sh = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-stack-'));
	const origin = path.join(dir, 'origin.git');
	execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', origin]);
	const w = path.join(dir, 'work');
	execFileSync('git', ['clone', '-q', origin, w], { stdio: 'ignore' });
	for (const [k, v] of [
		['user.email', 't@example.com'],
		['user.name', 't'],
		['commit.gpgsign', 'false'],
	])
		sh(w, 'config', k, v);
	const write = (f, c) => (fs.mkdirSync(path.dirname(path.join(w, f)), { recursive: true }), fs.writeFileSync(path.join(w, f), c));
	const commit = (msg) => (sh(w, 'add', '-A'), sh(w, 'commit', '-q', '-m', msg));
	write('base.txt', 'one\ntwo\nthree\n');
	commit('base');
	sh(w, 'push', '-q', 'origin', 'develop');
	return { w, write, commit };
}

test('syncBranch after a squash merge of the blocker leaves only the dependent changes in the diff', () => {
	const { w, write, commit } = fixture();
	sh(w, 'checkout', '-q', '-b', 'task/a');
	write('a/one.txt', '1\n');
	commit('a1');
	write('a/two.txt', '2\n');
	commit('a2');
	sh(w, 'push', '-q', 'origin', 'task/a');
	sh(w, 'checkout', '-q', '-b', 'task/b');
	write('b/dep.txt', 'depends on a\n');
	commit('b1');
	sh(w, 'push', '-q', 'origin', 'task/b');
	// the blocker is squash-merged into develop: its commits no longer match
	sh(w, 'checkout', '-q', 'develop');
	sh(w, 'merge', '--squash', 'task/a');
	commit('Squashed A');
	sh(w, 'push', '-q', 'origin', 'develop');
	sh(w, 'checkout', '-q', 'task/b');
	const r = syncBranch({ repo: w, ref: 'origin/develop' });
	assert.equal(r.status, 'merged');
	assert.equal(sh(w, 'diff', '--name-only', 'origin/develop...HEAD'), 'b/dep.txt');
	assert.equal(sh(w, 'log', '--format=%s', 'origin/task/b..HEAD').split('\n').length >= 1, true);
});

test('syncBranch merges new commits of the blocker into the dependent', () => {
	const { w, write, commit } = fixture();
	sh(w, 'checkout', '-q', '-b', 'task/a');
	write('a.txt', '1\n');
	commit('a1');
	sh(w, 'push', '-q', 'origin', 'task/a');
	sh(w, 'checkout', '-q', '-b', 'task/b');
	write('b.txt', 'b\n');
	commit('b1');
	sh(w, 'checkout', '-q', 'task/a');
	write('a2.txt', '2\n');
	commit('a2 (fix pass)');
	sh(w, 'push', '-q', 'origin', 'task/a');
	sh(w, 'checkout', '-q', 'task/b');
	assert.equal(syncBranch({ repo: w, ref: 'origin/task/a' }).status, 'merged');
	assert.ok(fs.existsSync(path.join(w, 'a2.txt')));
	assert.equal(syncBranch({ repo: w, ref: 'origin/task/a' }).status, 'current');
});

test('syncBranch never resolves a conflict: it aborts, names the files and leaves the branch as it was', () => {
	const { w, write, commit } = fixture();
	sh(w, 'checkout', '-q', '-b', 'task/b');
	write('base.txt', 'one\nDEPENDENT\nthree\n');
	commit('b1');
	const before = sh(w, 'rev-parse', 'HEAD');
	sh(w, 'checkout', '-q', 'develop');
	write('base.txt', 'one\nTRUNK\nthree\n');
	commit('trunk change');
	sh(w, 'push', '-q', 'origin', 'develop');
	sh(w, 'checkout', '-q', 'task/b');
	const r = syncBranch({ repo: w, ref: 'origin/develop' });
	assert.equal(r.status, 'conflict');
	assert.deepEqual(r.files, ['base.txt']);
	assert.equal(sh(w, 'rev-parse', 'HEAD'), before);
	assert.equal(sh(w, 'status', '--porcelain'), '');
});

// ---- settings
test('the stack settings are validated', () => {
	const c = load();
	assert.deepEqual(validate(c), []);
	assert.ok(validate({ ...c, tasks: { ...c.tasks, unblockOnPr: 'yes' } }).some((p) => /tasks\.unblockOnPr must be true or false/.test(p)));
	assert.ok(validate({ ...c, caps: { ...c.caps, maxStackDepth: 0 } }).some((p) => /caps\.maxStackDepth must be a positive integer/.test(p)));
	assert.deepEqual(validate({ ...c, tasks: { ...c.tasks, unblockOnPr: true }, caps: { ...c.caps, maxStackDepth: 2 } }), []);
});

// ---- the CLI the tick calls
test('livePlan reads each blocker PR and the files it changes, then decides', async () => {
	const { livePlan } = await import('../scripts/stack.mjs');
	const cfg = { ...load(), tasks: { ...load().tasks, unblockOnPr: true } };
	const run = (args) => {
		if (args[1] === 'list') return JSON.stringify([{ number: 4 }]);
		if (args[1] === 'view')
			return JSON.stringify({
				number: 4,
				state: 'OPEN',
				headRefName: 'task/a',
				baseRefName: 'develop',
				author: { login: 'bot' },
				commits: [],
				reviews: [],
				comments: [],
				body: '',
			});
		if (args[1] === 'diff') return 'src/billing/invoice.ts\n';
		throw new Error(args.join(' '));
	};
	const text = 'Extend src/billing/invoice.ts';
	const blockers = [{ key: 'A-1', state: 'inReview' }];
	assert.deepEqual(livePlan({ cfg, text, blockers, run }), { action: 'stack', base: 'task/a', pr: 4, depth: 2 });
	assert.equal(livePlan({ cfg, text: 'Something else in docs/x.md', blockers, run }).action, 'wait');
	assert.equal(livePlan({ cfg, text, blockers: [{ key: 'A-1', state: 'inProgress' }], run }).action, 'wait');
	assert.equal(livePlan({ cfg: load(), text, blockers, run }).action, 'wait', 'off by default');
});
