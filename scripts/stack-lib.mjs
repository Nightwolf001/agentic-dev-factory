// Stacked PRs: building a task whose blockers are not done yet, on top of the branch of a blocker that already has
// an open PR. Everything here is a pure decision over data the caller gathered (planStack, stackAction) except
// syncBranch, which only merges. No function here pushes, rebases or resolves a conflict.
//
// Vocabulary: the blocker is the task being built on; its PR is the stack base; the dependent is the task built on it.
// A PR carries one line (stackNote) naming the PR it was stacked on, which is how every later pass finds the stack.
import { execFileSync } from 'node:child_process';
import { get } from './config.mjs';
import { normaliseRef, parseBlockedBy } from './sources/common.mjs';
import { parseBase } from './worktree.mjs';

export const DEFAULT_MAX_DEPTH = 3;

export function stackSettings(cfg) {
	return {
		enabled: get('tasks.unblockOnPr', { config: cfg }) === true,
		maxDepth: get('caps.maxStackDepth', { config: cfg }) ?? DEFAULT_MAX_DEPTH,
	};
}

export const stackNote = ({ number, branch }) => `This PR is stacked on PR #${number} (branch \`${branch}\`): review only the commits after it.`;

export function parseStackNote(body) {
	const m = /stacked on PR #(\d+) \(branch `([^`\s]+)`\)/i.exec(String(body ?? ''));
	return m ? { number: Number(m[1]), branch: m[2] } : null;
}

// File paths a ticket mentions: something with a directory part and an extension, not a URL.
export function pathsIn(text) {
	const out = [];
	const clean = String(text ?? '').replace(/https?:\/\/\S+/g, ' ');
	for (const m of clean.matchAll(/(?:^|[\s`'"(\[])((?:[\w.-]+\/)+[\w.-]+\.\w+)(?=$|[\s`'")\],:;])/g)) if (!out.includes(m[1])) out.push(m[1]);
	return out;
}

const linked = (text, key) => parseBlockedBy(text).some((r) => normaliseRef(r) === key.toUpperCase());

// Whether the task's scope depends on the blocker's code: the ticket names the blocker in a `Blocked by:` line, or
// mentions a file the blocker's PR changes. A blocker that is only ordering (a native link, no shared files) is
// not stacked on.
export function dependsOn({ text, key, files = [] }) {
	if (linked(text, key)) return true;
	const mine = pathsIn(text);
	return files.some((f) => mine.includes(f));
}

const stackable = (b) => ['inReview', 'reviewed'].includes(b.taskState) && b.pr?.state === 'OPEN' && b.pr.onOrigin === true;

const why = (b) => {
	if (!['inReview', 'reviewed'].includes(b.taskState)) return `${b.key} is ${b.taskState ?? 'not started'}`;
	if (!b.pr) return `${b.key} has no PR`;
	if (b.pr.state === 'MERGED') return `${b.key} is merged but not done yet`;
	if (b.pr.state !== 'OPEN') return `${b.key} has a closed PR`;
	return `${b.key}'s branch is not on origin`;
};

// blockers: [{ key, done, taskState, pr: { number, state, headRefName, baseRefName, onOrigin, chain } | null, files? }]
// chain is the PR's head branch followed by the branches it is stacked on, lowest last ([self] when it is on the base).
// Returns { action: 'build', base: null } (nothing unmerged: the default base),
// { action: 'stack', base, pr, depth } or { action: 'wait', reason }. Waiting never blocks the task.
export function planStack({ blockers = [], text = '', enabled = false, maxDepth = DEFAULT_MAX_DEPTH, checkScope = true }) {
	const open = blockers.filter((b) => !b.done);
	if (!open.length) return { action: 'build', base: null };
	if (!enabled) return { action: 'wait', reason: `${open.map((b) => b.key).join(', ')} not done and tasks.unblockOnPr is off` };
	const bad = open.filter((b) => !stackable(b));
	if (bad.length) return { action: 'wait', reason: bad.map(why).join('; ') };
	const override = parseBase(text);
	if (override) {
		const named = open.find((b) => b.pr.headRefName === override);
		if (!named) return { action: 'wait', reason: `Base branch ${override} is not the branch of a blocker with an open PR` };
	} else if (checkScope) {
		const off = open.filter((b) => !dependsOn({ text, key: b.key, files: b.files ?? [] }));
		if (off.length) return { action: 'wait', reason: `scope does not depend on ${off.map((b) => b.key).join(', ')}, so it is not stacked on it` };
	}
	const tip = [...open].sort((a, b) => b.pr.chain.length - a.pr.chain.length)[0];
	const loose = open.filter((b) => b !== tip && !tip.pr.chain.includes(b.pr.headRefName));
	if (loose.length)
		return {
			action: 'wait',
			reason: `independent blockers ${[tip, ...loose].map((b) => b.key).join(', ')}: no single branch contains them all`,
		};
	const depth = tip.pr.chain.length + 1;
	if (depth > maxDepth) return { action: 'wait', reason: `stack would be ${depth} PRs deep, over caps.maxStackDepth ${maxDepth}` };
	return { action: 'stack', base: tip.pr.headRefName, pr: tip.pr.number, depth };
}

// What an open stacked dependent needs, from the stack data prStateFor read:
// pr.stack = { number, branch, state, baseRefName, containsHead, containsMerge }. baseRefName is where the blocker's PR was
// merged, containsHead whether the dependent contains the blocker's current head, containsMerge whether it contains the merge.
// 'abandoned' (blocker closed unmerged: block the dependent), 'retarget' (blocker merged: point the PR at where it
// merged and merge that in), 'restack' (blocker has new commits: merge them in before building further), or null.
export function stackAction(pr) {
	if (!pr?.stack || pr.state !== 'OPEN') return null;
	const s = pr.stack;
	if (s.state === 'CLOSED') return 'abandoned';
	if (s.state === 'MERGED') return pr.baseRefName === s.baseRefName && s.containsMerge === true ? null : 'retarget';
	if (s.state === 'OPEN' && s.containsHead === false) return 'restack';
	return null;
}

// Whether a PR still targets its blocker's branch.
export const isStacked = (pr) => !!pr?.stack && pr.baseRefName === pr.stack.branch;

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Brings the checked-out branch up to date with `ref` (origin/<trunk> after the blocker merged, origin/<blocker> after
// it gained commits) with a merge, never a rebase: the factory never force-pushes, and after a squash merge the
// blocker's original commits and its one squashed commit make the same change, so git applies the merge cleanly and
// the PR diff shrinks to the dependent's own work. A conflict is never resolved: the merge is aborted and the files named.
// Returns { status: 'current' | 'merged' | 'conflict', files? }.
export function syncBranch({ repo, ref, fetch = true }) {
	if (fetch) git(repo, 'fetch', '--quiet', 'origin');
	try {
		git(repo, 'merge-base', '--is-ancestor', ref, 'HEAD');
		return { status: 'current' };
	} catch {
		/* not contained */
	}
	try {
		git(repo, 'merge', '--no-edit', ref);
		return { status: 'merged' };
	} catch {
		let files = [];
		try {
			files = git(repo, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
		} catch {
			/* no index to read */
		}
		try {
			git(repo, 'merge', '--abort');
		} catch {
			/* nothing to abort */
		}
		return { status: 'conflict', files };
	}
}
