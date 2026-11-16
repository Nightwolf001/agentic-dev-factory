// The decision behind scheduler auto-merge, as pure functions: every fact comes in through `decide`'s input and nothing is read
// or run here. The rule is `autoMerge.enabled` AND (small OR labelled): a small PR merges with no label, and the label
// authorises a larger one. A PR that is neither is a PR for a person, so it is `off`, not refused.
//
//   off      the feature is off, or the PR is not for the scheduler to merge
//   refused  a permanent reason (one string each, all collected so one comment explains everything)
//   wait     a transient reason: the bots are still looking, or the merge state is not CLEAN yet
//   ready    eligible, but still a draft: mark it ready for review first
//   merge    eligible and ready: merge it at exactly this commit
//
// Stacked PRs and PRs with a "Decisions made without a person" section are never refused for that; they produce `notes`, and a
// stacked PR waits until its blocker PR is merged (the caller passes the blocker's state as `blocker: { pr, state }`).

export const EXIT = { DONE: 0, WAIT: 10, REFUSED: 11, OFF: 12, UNKNOWN: 21 };

const norm = (s) =>
	String(s ?? '')
		.trim()
		.toLowerCase();

export const changedLines = (pr) => (Number(pr?.additions) || 0) + (Number(pr?.deletions) || 0);

// A bound below 1 (validation does not forbid one) means nothing counts as small.
export function sizeBound(cfg) {
	const n = Number(cfg?.pr?.sizeLabels?.[cfg?.autoMerge?.maxSize]);
	return Number.isFinite(n) && n >= 1 ? n : 0;
}

const labelSet = (labels) => new Set((Array.isArray(labels) ? labels : []).map(norm));

// Whether the PR is the scheduler's to merge at all, from the config, the labels and the PR's size alone: 'label', 'small' or null
// (off). It needs no evidence, so the caller can answer `off` before asking qa or GitHub anything more.
export function scope({ cfg, labels, pr } = {}) {
	if (cfg?.autoMerge?.enabled !== true) return null;
	const want = norm(cfg.autoMerge.label);
	// a blank label authorises nothing, and neither does the factory's own task label, which every factory task carries
	const labelled = want !== '' && want !== norm(cfg.tasks?.label) && labelSet(labels).has(want);
	const bound = sizeBound(cfg);
	// at or below the bound, 0 included: an empty PR must reach the refusal in `decide` instead of being ignored
	const small = bound > 0 && changedLines(pr) <= bound;
	return labelled ? 'label' : small ? 'small' : null;
}

export function decide(input = {}) {
	const { cfg, labels, verified, readiedHead = null } = input;
	// a fact that is missing or null is treated as missing, never as a throw: unknown input must fail closed
	const pr = input.pr ?? {};
	const review = input.review ?? {};
	const bugbot = input.bugbot ?? null;
	const result = (action, via = null, reasons = [], notes = []) => ({ action, via, reasons, notes });
	const via = scope({ cfg, labels, pr });
	if (via === null) return result('off');

	const have = labelSet(labels);
	const lines = changedLines(pr);
	const bound = sizeBound(cfg);
	const labelled = via === 'label';
	const body = String(pr.body ?? '');
	const stack = /stacked on PR #(\d+)/i.exec(body);

	const refused = [];
	if (lines === 0) refused.push('no changed lines');
	if (pr.state !== 'OPEN') refused.push('the PR is not open');
	if (String(pr.headRefName ?? '').startsWith('ai-tooling/')) refused.push("the branch is for the factory's own changes");
	if (!verified) refused.push('QA has not passed at this commit');
	if (!review.clean) refused.push('review not clean');
	const triggered = review.triggered ?? [];
	if (triggered.length > 0) refused.push(`a specialist review step is required (${triggered.join(', ')})`);
	if (pr.reviewDecision === 'CHANGES_REQUESTED') refused.push('changes were requested');
	if (have.has(norm(cfg.tasks?.blockedLabel)) || have.has(norm(cfg.tasks?.questionLabel))) refused.push('the task is parked');
	if (pr.mergeStateStatus === 'DIRTY') refused.push('the branch has conflicts');
	if (pr.isDraft && readiedHead && readiedHead === pr.headRefOid) refused.push('it was made a draft again by a person');
	if (refused.length > 0) return result('refused', via, refused);

	const waiting = [];
	// With Bugbot off the caller passes { unresolved: 0, pending: false }; only a missing or non-numeric count is unknown. With it on
	// and no Bugbot check at this commit yet (the trigger failed, the bot has not started, its quota ran out), `notRun` is set: a
	// person who turned Bugbot on expects it to have looked at the head, so that waits too.
	if (!Number.isFinite(bugbot?.unresolved)) waiting.push('bot review state unknown');
	if (bugbot?.notRun) waiting.push('the bot review has not run at this commit');
	else if (bugbot?.pending) waiting.push('the bot review is still running');
	if (bugbot?.unresolved > 0) waiting.push(`${bugbot.unresolved} bot review thread(s) unresolved`);
	// A stacked PR targets its blocker's branch: merged now, it would land there and change the blocker's head, so its QA and review
	// would no longer match. It waits for the blocker to merge; the tick's retarget then moves it onto the real base.
	if (stack) {
		const m = Number(stack[1]);
		const b = input.blocker;
		const state = b && b.pr === m ? b.state : null;
		if (state === 'OPEN') waiting.push(`its blocker PR #${m} is not merged yet`);
		else if (state === 'CLOSED') waiting.push(`its blocker PR #${m} was closed without merging`);
		else if (state !== 'MERGED') waiting.push(`its blocker PR #${m} state is unknown`);
	}
	if (!pr.isDraft && pr.mergeStateStatus !== 'CLEAN') waiting.push(`the merge state is ${pr.mergeStateStatus || 'unknown'}, not CLEAN`);
	if (waiting.length > 0) return result('wait', via, waiting);

	const notes = [];
	if (stack) notes.push(`stacked on PR #${stack[1]}`);
	if (/^#{1,6}\s*decisions made without a person\b/im.test(body)) notes.push('carries decisions made without a person');
	if (labelled && lines > bound) notes.push(`labelled task, ${lines} changed lines`);
	return result(pr.isDraft ? 'ready' : 'merge', via, [], notes);
}

// The whole of the merge command: the method, pinned to the commit that was checked. Never --admin, never --auto.
// It refuses to build anything else: an unknown method (admin, auto) or an empty head (no pin) throws.
export function mergeArgs({ pr, head, method } = {}) {
	if (!['squash', 'merge', 'rebase'].includes(method))
		throw new Error(`mergeArgs: method must be squash, merge or rebase, got ${JSON.stringify(method)}`);
	if (typeof head !== 'string' || head.trim() === '') throw new Error('mergeArgs: a head commit is required to pin the merge');
	if (!Number.isInteger(pr) || pr < 1) throw new Error(`mergeArgs: pr must be a positive integer, got ${JSON.stringify(pr)}`);
	return ['pr', 'merge', String(pr), `--${method}`, '--match-head-commit', head];
}
