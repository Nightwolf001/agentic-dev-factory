// PreToolUse hook entry. Active only inside a factory run: DF_ACTIVE=1 or .dev-factory/run.json
// in the session's cwd. Elsewhere it allows everything, so interactive sessions are unaffected.
//
// A dispatched factory agent (its event carries agent_type and agent_id) is judged by the run it bound itself to. Its bind command,
// `node "<this plugin>/scripts/run-context.mjs" bind --worktree DIR` exactly, is checked and recorded here, before anything else;
// until it has bound, every other command is refused with the command to run. Where this hook fails on a factory agent's event it
// refuses (exit 2) rather than crash into allowing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from './config.mjs';
import { evaluate } from './guard-lib.mjs';
import { takeoverOn } from './takeover.mjs';
import { FACTORY_AGENT, bindAgent, judgedRole, parseBindCommand, resolveRun, unboundReason } from './run-context.mjs';

// The run-context.mjs beside this hook. The bind command runs once this hook allows it, so the script it names must be this file:
// any other file of that name would run unchecked.
const OWN_RUN_CONTEXT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-context.mjs');
const realOrNull = (p) => {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
};
const isOwnRunContext = (script) => {
	if (typeof script !== 'string' || !path.isAbsolute(script)) return false;
	const mine = realOrNull(OWN_RUN_CONTEXT);
	return mine !== null && realOrNull(script) === mine;
};

const refuse = (reason) => {
	process.stderr.write(reason + '\n');
	process.exit(2);
};

function judge(evt, factory) {
	const cwd = evt.cwd || process.cwd();
	const command = evt.tool_input?.command;
	if (factory && typeof command === 'string') {
		const bind = parseBindCommand(command);
		if (bind) {
			const { script } = bind;
			if (!isOwnRunContext(script))
				refuse(
					`dev-factory guard: the bind names ${JSON.stringify(script)}, which is not this plugin's own run-context.mjs (${OWN_RUN_CONTEXT}); bind with that file, by its absolute path.`,
				);
			const r = bindAgent({ agentId: evt.agent_id, agentType: evt.agent_type, worktree: bind.worktree });
			if (!r.ok) refuse(`dev-factory guard: the bind was refused: ${r.reason}`);
			process.exit(0);
		}
	}
	const resolved = resolveRun({ cwd, agentType: evt.agent_type, agentId: evt.agent_id });
	if (factory && resolved.unbound) refuse(unboundReason());
	const { run } = resolved;
	if (process.env.DF_ACTIVE !== '1' && !run) process.exit(0);
	if (typeof command !== 'string') process.exit(0);
	let environment = {};
	try {
		environment = get('environment') ?? {};
	} catch {
		/* no readable config: fall back to the strictest reading below */
	}
	const containerOnly = environment.type === 'compose';
	let noAttribution = true;
	try {
		noAttribution = get('git.agentAttribution') !== true;
	} catch {
		/* no readable config: keep the strict reading */
	}
	// hosts of the task tracker beyond the built-in ones: the Jira site, and whatever the repository lists
	let trackerHosts = [];
	try {
		trackerHosts = [get('sources.jira.site'), ...(get('guard.trackerHosts') ?? [])].filter((h) => typeof h === 'string' && h);
	} catch {
		/* no readable config: the built-in hosts still apply */
	}
	const verdict = evaluate(command, {
		cwd,
		trackerHosts,
		branch: run?.branch,
		key: run?.key,
		role: factory && run ? judgedRole(run) : run?.role,
		containerOnly,
		service: environment.service,
		noAttribution,
		takeover: takeoverOn(),
	});
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
		const factory = typeof evt?.agent_type === 'string' && FACTORY_AGENT.test(evt.agent_type);
		try {
			judge(evt, factory);
		} catch (e) {
			if (!factory) throw e;
			refuse(`dev-factory guard: the guard could not judge this command (${e?.message ?? e}), so it is refused.`);
		}
	});
