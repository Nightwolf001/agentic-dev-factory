// PreToolUse hook entry. Active only inside a factory run: DF_ACTIVE=1 or .dev-factory/run.json
// in the session's cwd. Elsewhere it allows everything, so interactive sessions are unaffected.
import { evaluate } from './guard-lib.mjs';
import { resolveRun } from './run-context.mjs';

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
		const cwd = evt.cwd || process.cwd();
		const { run } = resolveRun({ cwd, agentType: evt.agent_type });
		if (process.env.DF_ACTIVE !== '1' && !run) process.exit(0);
		const command = evt.tool_input?.command;
		if (typeof command !== 'string') process.exit(0);
		const verdict = evaluate(command, { branch: run?.branch, role: run?.role });
		if (verdict.deny) {
			process.stderr.write(verdict.reason + '\n');
			process.exit(2);
		}
		process.exit(0);
	});
