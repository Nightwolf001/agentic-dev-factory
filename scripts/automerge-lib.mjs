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
// Stacked PRs and PRs with a "Decisions made without a person" section are never refused for that; they only produce `notes`.

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

export function decide({ cfg, labels = [], pr = {}, verified, review = {}, bugbot = {}, readiedHead = null } = {}) {
	const result = (action, via = null, reasons = [], notes = []) => ({ action, via, reasons, notes });
	if (cfg?.autoMerge?.enabled !== true) return result('off');

	const have = new Set((labels ?? []).map(norm));
	const lines = changedLines(pr);
	const bound = sizeBound(cfg);
	const labelled = have.has(norm(cfg.autoMerge.label));
	// at or below the bound, 0 included: an empty PR must reach the refusal below instead of being ignored
	const small = bound > 0 && lines <= bound;
	if (!small && !labelled) return result('off');
	const via = labelled ? 'label' : 'small';

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
	if (bugbot.pending) waiting.push('the bot review is still running');
	if (bugbot.unresolved > 0) waiting.push(`${bugbot.unresolved} bot review thread(s) unresolved`);
	if (!pr.isDraft && pr.mergeStateStatus !== 'CLEAN') waiting.push(`the merge state is ${pr.mergeStateStatus || 'unknown'}, not CLEAN`);
	if (waiting.length > 0) return result('wait', via, waiting);

	const notes = [];
	const body = String(pr.body ?? '');
	const stack = /stacked on PR #(\d+)/i.exec(body);
	if (stack) notes.push(`stacked on PR #${stack[1]}`);
	if (/^#{1,6}\s*decisions made without a person\b/im.test(body)) notes.push('carries decisions made without a person');
	if (labelled && lines > bound) notes.push(`labelled task, ${lines} changed lines`);
	return result(pr.isDraft ? 'ready' : 'merge', via, [], notes);
}

// The whole of the merge command: the method, pinned to the commit that was checked. Never --admin, never --auto.
export const mergeArgs = ({ pr, head, method }) => ['pr', 'merge', String(pr), `--${method}`, '--match-head-commit', head];
