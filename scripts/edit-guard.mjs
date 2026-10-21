// PreToolUse hook for Edit, Write, MultiEdit and NotebookEdit. Vocabulary is enforced for everyone
// editing dev-factory/. Path protection applies only inside a factory run (DF_ACTIVE=1 or .dev-factory/run.json).
import { evaluateEdit } from './guard-lib.mjs';
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
		const { root, run } = resolveRun({ cwd, agentType: evt.agent_type });
		const ti = evt.tool_input || {};
		const text = [ti.content, ti.new_string, ti.new_source, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string) : [])]
			.filter(Boolean)
			.join('\n');
		const verdict = evaluateEdit({ filePath: ti.file_path || ti.notebook_path, text, root, active: process.env.DF_ACTIVE === '1' || !!run, run });
		if (verdict.deny) {
			process.stderr.write(verdict.reason + '\n');
			process.exit(2);
		}
		process.exit(0);
	});
