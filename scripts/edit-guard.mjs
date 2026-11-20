// PreToolUse hook for Edit, Write, MultiEdit and NotebookEdit. Vocabulary is enforced for everyone
// editing dev-factory/. Path protection applies only inside a factory run (DF_ACTIVE=1 or .dev-factory/run.json).
// A dispatched factory agent is judged by the run it bound itself to, and refused every edit until it has bound (it binds with
// Bash; this hook has no bind command). Where this hook fails on a factory agent's event it refuses rather than crash into allowing.
import { evaluateEdit } from './guard-lib.mjs';
import { FACTORY_AGENT, resolveRun, unboundReason } from './run-context.mjs';

const refuse = (reason) => {
	process.stderr.write(reason + '\n');
	process.exit(2);
};

function judge(evt, factory) {
	const cwd = evt.cwd || process.cwd();
	const resolved = resolveRun({ cwd, agentType: evt.agent_type, agentId: evt.agent_id });
	if (factory && resolved.unbound) refuse(unboundReason('Bind first with the Bash tool'));
	const { root } = resolved;
	// a factory agent's run with no role is a builder's, as the binding and the stop gate read it, so it gets the builder limits
	const run = factory && resolved.run ? { ...resolved.run, role: resolved.run.role ?? 'builder' } : resolved.run;
	const ti = evt.tool_input || {};
	const text = [ti.content, ti.new_string, ti.new_source, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string) : [])]
		.filter(Boolean)
		.join('\n');
	const verdict = evaluateEdit({ filePath: ti.file_path || ti.notebook_path, text, root, active: process.env.DF_ACTIVE === '1' || !!run, run });
	if (verdict.deny) refuse(verdict.reason);
	process.exit(0);
}

let input = '';
process.stdin
	.on('data', (d) => (input += d))
	.on('end', () => {
		let evt = {};
		try {
			evt = JSON.parse(input);
		} catch {
			// nothing to judge, and no way to tell whose event it was
			process.exit(0);
		}
		const factory = typeof evt?.agent_type === 'string' && FACTORY_AGENT.test(evt.agent_type);
		try {
			judge(evt, factory);
		} catch (e) {
			if (!factory) throw e;
			refuse(`dev-factory guard: the guard could not judge this edit (${e?.message ?? e}), so it is refused.`);
		}
	});
