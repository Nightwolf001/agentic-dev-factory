// SubagentStop hook for the factory agents. run.json in the worktree says who is running:
//   role builder (default), until "build": may stop at build.done (environment, implementation and QA finished)
//   role builder, until "ship":            may stop at ship.done (PR open, QA and review verified)
//   role reviewer, axis spec|standards:    may stop once a review record exists for that axis at HEAD
//   role debugger:                         may stop once a new debug round is recorded, or blocked.json exists
//   a bug ticket (kind bug) may not stop at build.done without a recorded root cause; needs_debug.json always lets a builder stop
// blocked.json always lets a builder stop. A build.done is only accepted when the tree is committed, QA passed at HEAD and the file
// names the QA head or HEAD (qa.mjs buildReadyProblems, the same check `qa.mjs build-ready` runs for the scheduler). A refused build.done is
// moved to build.refused, so the scheduler's wait loop never takes it for a hand-off. A check that itself breaks refuses: the nudge
// cap below still ends the run. Counts refusals and gives up after MAX so a genuinely stuck run still ends; giving up writes a
// blocked.json naming what was unmet, so the scheduler hears about it at once instead of waiting out its stall window. A clean stop
// clears the count, so one phase's nudges are not charged to the next.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { status } from './debug-lib.mjs';
import { REFUSED, checksBuild, decide, mayRecordBlock } from './stop-gate-lib.mjs';
import { resolveRun } from './run-context.mjs';

const MAX = Number(process.env.DF_STOP_GATE_MAX || 6);
let input = '';
process.stdin
	.on('data', (d) => (input += d))
	.on('end', async () => {
		let evt = {};
		try {
			evt = JSON.parse(input);
		} catch {
			process.exit(0);
		}
		const { root: cwd, run } = resolveRun({ cwd: evt.cwd || process.cwd(), agentType: evt.agent_type });
		if (!run) process.exit(0);
		const dir = path.join(cwd, '.dev-factory');
		const has = (f) => fs.existsSync(path.join(dir, f));
		const counter = path.join(dir, 'stop-nudges');
		let head = '';
		if (run.role === 'reviewer') {
			try {
				head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
			} catch {
				process.exit(0);
			}
		}
		const debug = status(cwd);
		// build.done is checked against the repository, but only once it exists: until then the next step is already clear. qa.mjs is
		// loaded here, for this check alone, so a fault in it cannot touch any other role's stop; and a check that fails for any
		// reason (git unreadable, a corrupt run file, qa.mjs not loading) refuses the file rather than accepting it.
		let build = null;
		if (checksBuild(run) && has('build.done')) {
			try {
				const { buildReadyProblems } = await import('../bin/qa.mjs');
				build = { problems: buildReadyProblems({ root: cwd }) };
			} catch (e) {
				build = { problems: [`build.done could not be checked: ${e.message}`] };
			}
		}
		const { finished, next, unmet } = decide({ run, has, head, debug, build });
		if (finished) {
			fs.rmSync(counter, { force: true });
			process.exit(0);
		}
		// Not finished in a build phase: a build.done still here was refused, and must not be read as a hand-off.
		if (checksBuild(run) && has('build.done')) {
			try {
				fs.renameSync(path.join(dir, 'build.done'), path.join(dir, REFUSED));
			} catch {
				fs.rmSync(path.join(dir, 'build.done'), { force: true });
			}
		}
		const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
		fs.writeFileSync(counter, String(n));
		if (n > MAX) {
			if (mayRecordBlock(run) && !has('blocked.json'))
				fs.writeFileSync(
					path.join(dir, 'blocked.json'),
					JSON.stringify({
						reason: `the stop gate let the run go after ${MAX} refusals with it unfinished: ${unmet}`,
						decision: 'Finish what the reason names by hand and resume the ticket, or close it.',
					}),
				);
			process.exit(0);
		}
		process.stderr.write(`dev-factory: the run is not finished (${n}/${MAX}). ${next}\n`);
		process.exit(2);
	});
