// PreToolUse hook entry for the Sentry and Axiom MCP tools.
import { load } from './config.mjs';
import { evaluateMcp } from './mcp-guard-lib.mjs';

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
		const verdict = evaluateMcp({ toolName: evt.tool_name, toolInput: evt.tool_input, config });
		if (verdict.deny) {
			process.stderr.write(verdict.reason + '\n');
			process.exit(2);
		}
		process.exit(0);
	});
