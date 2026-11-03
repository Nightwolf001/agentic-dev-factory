// PreToolUse hook entry for the Sentry and Axiom MCP tools.
import { load } from './config.mjs';
import { evaluateMcp } from './mcp-guard-lib.mjs';
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
		let config = {};
		try {
			config = load();
		} catch {
			/* a missing config falls back to the defaults in the library */
		}
		// a claude.ai connector is guarded only inside a factory run, never in the person's own sessions
		let run = null;
		try {
			run = resolveRun({ cwd: evt.cwd || process.cwd(), agentType: evt.agent_type }).run;
		} catch {
			/* not in a run */
		}
		const inRun = process.env.DF_ACTIVE === '1' || !!run;
		const verdict = evaluateMcp({ toolName: evt.tool_name, toolInput: evt.tool_input, config, inRun, role: run?.role });
		if (verdict.deny) {
			process.stderr.write(verdict.reason + '\n');
			process.exit(2);
		}
		process.exit(0);
	});
