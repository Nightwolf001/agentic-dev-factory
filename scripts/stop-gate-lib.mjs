import { qaCommand } from './plugin-root.mjs';
import { FACTORY_AGENT } from './run-context.mjs';

// Whether the stop is the end of a build phase, the one that hands over to review: build.done is then checked against the
// repository (checksBuild), not just for existing.
export const checksBuild = (run) => (!run.role || run.role === 'builder') && run.until === 'build';

// Whether the gate may write blocked.json for a run it lets go unfinished. A reviewer's stop condition is its review record and
// the scheduler waits on that file alone, so a block written for a reviewer would be read by nothing.
export const mayRecordBlock = (run) => run.role !== 'reviewer';

// Where the gate moves a build.done it refuses. The scheduler's wait loop looks for build.done, so a refused one left in place
// could be read as a hand-off while the builder is still told to work.
export const REFUSED = 'build.refused';

// The role a dispatched factory agent works as, from its agent type ('dev-factory:factory-builder' is a builder), or null for any
// other type, including none.
export const agentRoleOf = (agentType) => (typeof agentType === 'string' ? FACTORY_AGENT.exec(agentType)?.[2] ?? null : null);

// Whether this agent's stop is the run's. The scheduler takes a hand-off and then moves the run to another role in run.json, so a
// builder stopping after that must not be judged by, counted against or given a block for the new role's finish line. An agent
// whose role cannot be told (no type, or not a factory agent) is gated exactly as before.
export const ownsRun = (agentType, run) => {
	const role = agentRoleOf(agentType);
	return role === null || role === (run.role ?? 'builder');
};

// Decides whether a factory agent may stop. Pure: the caller supplies what exists on disk.
//   has(file)        whether .dev-factory/<file> exists
//   head             the worktree's HEAD sha (reviewers)
//   debug            result of debug-lib status() for the worktree; recordedAll and openAll include validate rounds
//   build            { problems } from qa.mjs buildReadyProblems, for a build phase whose build.done exists; left out, the file alone ends it
//   root             the run's worktree: every qa.mjs command a nudge names carries --worktree with it, since several agents can be
//                    bound at once and a command without it may not find this one's tree
// Returns { finished, next, unmet }: next is the instruction for the agent, unmet the short statement of what is missing that a
// person reads when the gate gives up.
export function decide({ run, has, head = '', debug = { rounds: 0, open: [], hasRootCause: false }, build = null, root = null }) {
	const qa = (sub) => qaCommand(root ? `${sub} --worktree "${root}"` : sub);
	if (run.role === 'reviewer') {
		return {
			finished: has(`review/${head}-${run.axis}.json`),
			next: `Finish by recording the ${run.axis} review: ${qa('review record')} --axis ${run.axis} --head ${head.slice(0, 12)} --summary "..." --findings '[...]'.`,
			unmet: `no ${run.axis} review recorded at ${head.slice(0, 9)}`,
		};
	}
	if (run.role === 'promoter') {
		return {
			finished: has('blocked.json') || has('promote.done'),
			next: `Finish: ${qa('promote check')} must pass, then push, open the draft PR and write .dev-factory/promote.done containing the PR URL, or write .dev-factory/blocked.json {"reason","decision"}.`,
			unmet: 'no promote.done',
		};
	}
	if (run.role === 'improver') {
		return {
			finished: has('blocked.json') || has('improve.done'),
			next: 'Finish: run the tests, Prettier, the vocabulary lint (on the worktree) and claude plugin validate, push the branch, open the draft PR, then write .dev-factory/improve.done containing the PR URL, or write .dev-factory/blocked.json {"reason","decision"}.',
			unmet: 'no improve.done',
		};
	}
	if (run.role === 'researcher') {
		return {
			finished: has('blocked.json') || has(`../docs/plans/${run.key}/research.md`),
			next: `Write docs/plans/${run.key}/research.md (Summary, Sources, Gaps, Confidence), or write .dev-factory/blocked.json {"reason","decision"}.`,
			unmet: `no docs/plans/${run.key}/research.md`,
		};
	}
	if (run.role === 'debugger') {
		const recorded = debug.recordedAll ?? debug.recorded;
		const stillOpen = debug.openAll ?? debug.open;
		const done = recorded > (run.debugBefore ?? 0) && stillOpen.length === 0;
		return {
			finished: has('blocked.json') || done,
			next: `Finish the debug round: ${qa('debug open')}, run a red-capable loop with ${qa('debug run')}, then ${qa('debug record')} (root cause, evidence, fix plan), or ${qa('debug block')} --reason "...".`,
			unmet: 'no debug round recorded',
		};
	}
	if (run.until === 'build') {
		const bugNeedsCause = run.kind === 'bug' && !debug.hasRootCause;
		const problems = build?.problems ?? [];
		const buildDone = has('build.done') && !bugNeedsCause && problems.length === 0;
		const setAside = `It was set aside as .dev-factory/${REFUSED}`;
		let next = `Finish the environment, implement and qa phases, commit, then write .dev-factory/build.done containing the QA head and check it with ${qa('build-ready')}, or write .dev-factory/needs_debug.json (stuck, bug ticket) or .dev-factory/blocked.json {"reason","decision"}.`;
		let unmet = 'no build.done';
		if (bugNeedsCause && has('build.done')) {
			next = `This is a bug ticket: build.done is not accepted until a root cause is recorded (${qa('debug status')}). ${setAside}. Write .dev-factory/needs_debug.json {"test","attempts","lastError"} so the scheduler can run the debugger, or write blocked.json.`;
			unmet = 'a bug ticket with no recorded root cause';
		} else if (has('build.done') && problems.length) {
			next = `build.done is not accepted yet: ${problems.join('; ')}. ${setAside}: fix that, write .dev-factory/build.done again with the QA head and check it with ${qa('build-ready')}, or write .dev-factory/blocked.json {"reason","decision"} if it cannot be fixed.`;
			unmet = problems.join('; ');
		}
		return { finished: has('blocked.json') || has('needs_debug.json') || buildDone, next, unmet };
	}
	return {
		finished: has('blocked.json') || has('ship.done'),
		next: `Finish the ship phase: push, open the draft PR (or push to the existing one), attach the QA screenshots as evidence on the PR, run ${qa('verify')} --require-review true, then write .dev-factory/ship.done, or write .dev-factory/blocked.json {"reason","decision"}.`,
		unmet: 'no ship.done',
	};
}
