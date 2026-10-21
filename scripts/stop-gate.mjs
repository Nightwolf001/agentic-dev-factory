// SubagentStop hook for the factory agents. run.json in the worktree says who is running:
//   role builder (default), until "build": may stop at build.done (environment, implementation and QA finished)
//   role builder, until "ship":            may stop at ship.done (PR open, QA and review verified)
//   role reviewer, axis spec|standards:    may stop once a review record exists for that axis at HEAD
//   role debugger:                         may stop once a new debug round is recorded, or blocked.json exists
//   a bug ticket (kind bug) may not stop at build.done without a recorded root cause; needs_debug.json always lets a builder stop
// blocked.json always lets a builder stop. Counts refusals and gives up after MAX so a genuinely
// stuck run still ends.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { status } from './debug-lib.mjs';
import { decide } from './stop-gate-lib.mjs';
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
		const { finished, next } = decide({ run, has, head, debug });
		if (finished) process.exit(0);
		const counter = path.join(dir, 'stop-nudges');
		const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
		fs.writeFileSync(counter, String(n));
		if (n > MAX) process.exit(0);
		process.stderr.write(`dev-factory: the run is not finished (${n}/${MAX}). ${next}\n`);
		process.exit(2);
	});
