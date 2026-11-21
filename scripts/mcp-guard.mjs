// PreToolUse hook entry for the Sentry and Axiom MCP tools, and for GitHub's inside a run.
// A dispatched factory agent is judged by the run it bound itself to, and refused every call until it has bound (it binds with
// Bash; this hook has no bind command). Where this hook fails on a factory agent's event it refuses rather than crash into allowing.
import { load } from './config.mjs';
import { evaluateMcp } from './mcp-guard-lib.mjs';
import { FACTORY_AGENT, judgedRole, resolveRun, unboundReason } from './run-context.mjs';

const refuse = (reason) => {
	process.stderr.write(reason + '\n');
	process.exit(2);
};

function judge(evt, factory) {
	let config = {};
	try {
		config = load();
	} catch {
		/* a missing config falls back to the defaults in the library */
	}
	// a claude.ai connector is guarded only inside a factory run, never in the person's own sessions (resolveRun never throws)
	const resolved = resolveRun({ cwd: evt.cwd || process.cwd(), agentType: evt.agent_type, agentId: evt.agent_id });
	if (factory && resolved.unbound) refuse(unboundReason('Bind first with the Bash tool'));
	const { run } = resolved;
	const inRun = process.env.DF_ACTIVE === '1' || !!run;
	const role = factory && run ? judgedRole(run) : run?.role;
	const verdict = evaluateMcp({ toolName: evt.tool_name, toolInput: evt.tool_input, config, inRun, role });
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
		// null, a list or a bare value is no event either
		if (evt === null || typeof evt !== 'object' || Array.isArray(evt)) process.exit(0);
		const factory = typeof evt.agent_type === 'string' && FACTORY_AGENT.test(evt.agent_type);
		try {
			judge(evt, factory);
		} catch (e) {
			if (!factory) throw e;
			refuse(`dev-factory guard: the guard could not judge this call (${e?.message ?? e}), so it is refused.`);
		}
	});
