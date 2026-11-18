import { qaCommand } from './plugin-root.mjs';

// Whether the stop is the end of a build phase, the one that hands over to review: build.done is then checked against the
// repository (checksBuild), not just for existing.
export const checksBuild = (run) => (!run.role || run.role === 'builder') && run.until === 'build';

// Whether the gate may write blocked.json for a run it lets go unfinished. A reviewer's stop condition is its review record and
// the scheduler waits on that file alone, so a block written for a reviewer would be read by nothing.
export const mayRecordBlock = (run) => run.role !== 'reviewer';

// Decides whether a factory agent may stop. Pure: the caller supplies what exists on disk.
//   has(file)        whether .dev-factory/<file> exists
//   head             the worktree's HEAD sha (reviewers)
//   debug            result of debug-lib status() for the worktree; recordedAll and openAll include validate rounds
//   build            { problems } from qa.mjs buildReadiness, for a build phase whose build.done exists; left out, the file alone ends it
export function decide({ run, has, head = '', debug = { rounds: 0, open: [], hasRootCause: false }, build = null }) {
	if (run.role === 'reviewer') {
		return {
			finished: has(`review/${head}-${run.axis}.json`),
			next: `Finish by recording the ${run.axis} review: ${qaCommand('review record')} --axis ${run.axis} --head ${head.slice(0, 12)} --summary "..." --findings '[...]'.`,
		};
	}
	if (run.role === 'promoter') {
		return {
			finished: has('blocked.json') || has('promote.done'),
			next: `Finish: ${qaCommand('promote check')} must pass, then push, open the draft PR and write .dev-factory/promote.done containing the PR URL, or write .dev-factory/blocked.json {"reason","decision"}.`,
		};
	}
	if (run.role === 'improver') {
		return {
			finished: has('blocked.json') || has('improve.done'),
			next: 'Finish: run the tests, Prettier, the vocabulary lint (on the worktree) and claude plugin validate, push the branch, open the draft PR, then write .dev-factory/improve.done containing the PR URL, or write .dev-factory/blocked.json {"reason","decision"}.',
		};
	}
	if (run.role === 'researcher') {
		return {
			finished: has('blocked.json') || has(`../docs/plans/${run.key}/research.md`),
			next: `Write docs/plans/${run.key}/research.md (Summary, Sources, Gaps, Confidence), or write .dev-factory/blocked.json {"reason","decision"}.`,
		};
	}
	if (run.role === 'debugger') {
		const recorded = debug.recordedAll ?? debug.recorded;
		const stillOpen = debug.openAll ?? debug.open;
		const done = recorded > (run.debugBefore ?? 0) && stillOpen.length === 0;
		return {
			finished: has('blocked.json') || done,
			next: 'Finish the debug round: qa.mjs debug open, run a red-capable loop with qa.mjs debug run, then qa.mjs debug record (root cause, evidence, fix plan), or qa.mjs debug block --reason "...".',
		};
	}
	if (run.until === 'build') {
		const bugNeedsCause = run.kind === 'bug' && !debug.hasRootCause;
		const problems = build?.problems ?? [];
		const buildDone = has('build.done') && !bugNeedsCause && problems.length === 0;
		let next =
			'Finish the environment, implement and qa phases, commit, then write .dev-factory/build.done containing the QA head, or write .dev-factory/needs_debug.json (stuck, bug ticket) or .dev-factory/blocked.json {"reason","decision"}.';
		if (bugNeedsCause && has('build.done'))
			next =
				'This is a bug ticket: build.done is not accepted until a root cause is recorded (qa.mjs debug status). Write .dev-factory/needs_debug.json {"test","attempts","lastError"} so the scheduler can run the debugger, or write blocked.json.';
		else if (has('build.done') && problems.length)
			next = `build.done is not accepted yet: ${problems.join('; ')}. Fix that and write .dev-factory/build.done again with the QA head, or write .dev-factory/blocked.json {"reason","decision"} if it cannot be fixed.`;
		return { finished: has('blocked.json') || has('needs_debug.json') || buildDone, next };
	}
	return {
		finished: has('blocked.json') || has('ship.done'),
		next: 'Finish the ship phase: push, open the draft PR (or push to the existing one), attach the QA screenshots as evidence on the PR, run qa.mjs verify with --require-review true, then write .dev-factory/ship.done, or write .dev-factory/blocked.json {"reason","decision"}.',
	};
}
