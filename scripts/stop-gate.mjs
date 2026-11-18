// SubagentStop hook for the factory agents. run.json in the worktree says who is running:
//   role builder (default), until "build": may stop at build.done (environment, implementation and QA finished)
//   role builder, until "ship":            may stop at ship.done (PR open, QA and review verified)
//   role reviewer, axis spec|standards:    may stop once a review record exists for that axis at HEAD
//   role debugger:                         may stop once a new debug round is recorded, or blocked.json exists
//   a bug ticket (kind bug) may not stop at build.done without a recorded root cause; needs_debug.json always lets a builder stop
// blocked.json always lets a builder stop. A build.done is only accepted when the tree is committed, QA passed at HEAD and the file
// names the QA head (qa.mjs buildReadiness). Counts refusals and gives up after MAX so a genuinely stuck run still ends; giving up
// writes a blocked.json naming what was unmet, so the scheduler hears about it at once instead of waiting out its stall window.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildReadiness } from '../bin/qa.mjs';
import { status } from './debug-lib.mjs';
import { checksBuild, decide, mayRecordBlock } from './stop-gate-lib.mjs';
import { resolveRun } from './run-context.mjs';

const MAX = Number(process.env.DF_STOP_GATE_MAX || 6);
let input = '';
process.stdin
	.on('data', (d) => (input += d))
	.on('end', () => {
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
		let head = '';
		if (run.role === 'reviewer') {
			try {
				head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
			} catch {
				process.exit(0);
			}
		}
		const debug = status(cwd);
		// build.done is checked against the repository, but only once it exists: until then the next step is already clear. A check
		// that itself fails (git unreadable) accepts the file, because the nudge cap and the block below still end a stuck run.
		let build = null;
		if (checksBuild(run) && has('build.done')) {
			try {
				build = { problems: buildReadiness({ root: cwd, key: run.key, doneText: fs.readFileSync(path.join(dir, 'build.done'), 'utf8') }) };
			} catch (e) {
				process.stderr.write(`dev-factory: build.done could not be checked (${e.message}); accepting it.\n`);
			}
		}
		const { finished, next } = decide({ run, has, head, debug, build });
		if (finished) process.exit(0);
		const counter = path.join(dir, 'stop-nudges');
		const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
		fs.writeFileSync(counter, String(n));
		if (n > MAX) {
			if (mayRecordBlock(run) && !has('blocked.json'))
				fs.writeFileSync(
					path.join(dir, 'blocked.json'),
					JSON.stringify({
						reason: `the stop gate let the run go after ${MAX} refusals with it unfinished: ${next}`,
						decision: 'Finish what the reason names by hand and resume the ticket, or close it.',
					}),
				);
			process.exit(0);
		}
		process.stderr.write(`dev-factory: the run is not finished (${n}/${MAX}). ${next}\n`);
		process.exit(2);
	});
