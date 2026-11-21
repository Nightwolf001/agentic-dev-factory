// PreToolUse hook for Edit, Write, MultiEdit and NotebookEdit. Vocabulary is enforced for everyone
// editing dev-factory/. Path protection applies only inside a factory run (DF_ACTIVE=1 or .dev-factory/run.json).
// A dispatched factory agent is judged by the run it bound itself to, and refused every edit until it has bound: it binds with
// Bash, except the researcher, which has no Bash tool and is bound by its first Write (to the nearest folder above the file that
// holds a run). Where this hook fails on a factory agent's event it refuses rather than crash into allowing.
import fs from 'node:fs';
import path from 'node:path';
import { evaluateEdit } from './guard-lib.mjs';
import { FACTORY_AGENT, bindAgent, judgedRole, resolveRun, unboundReason } from './run-context.mjs';

const refuse = (reason) => {
	process.stderr.write(reason + '\n');
	process.exit(2);
};

// The nearest folder above `file` that holds .dev-factory/run.json, by real path, or null. The path is resolved first (so `..` is
// judged by where it leads), its deepest existing folder is taken by its real name, and the walk ends at the file system root.
function runFolderAbove(file) {
	let dir = path.dirname(path.resolve(file));
	while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
	try {
		// the native call also settles the case of each name, the form the binding records and the later writes are judged against
		dir = fs.realpathSync.native(dir);
	} catch {
		return null;
	}
	for (;;) {
		if (fs.existsSync(path.join(dir, '.dev-factory', 'run.json'))) return dir;
		const up = path.dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

// A researcher has no Bash tool, so its refusal names the one way it binds.
const RESEARCHER_UNBOUND =
	"dev-factory guard: this researcher is not bound to a run, and a run's limits must be known before any edit is allowed. A researcher is bound by its first Write, which must name an absolute path inside the worktree your dispatch names (its research.md).";

const readRunAt = (worktree) => {
	try {
		const run = JSON.parse(fs.readFileSync(path.join(worktree, '.dev-factory', 'run.json'), 'utf8'));
		return run !== null && typeof run === 'object' && !Array.isArray(run) ? run : null;
	} catch {
		return null;
	}
};

// A researcher's first Write binds it, but only a Write its limits allow under the run it would bind to: the write is judged under
// that run first, with nothing recorded, so a misdirected first Write is refused and leaves the agent unbound (bound to the wrong
// run, it could neither reach its own run nor let that run's researcher bind). -> nothing when bound, or refuses.
function bindResearcherByWrite(evt, filePath, verdictUnder) {
	if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) refuse(RESEARCHER_UNBOUND);
	const worktree = runFolderAbove(filePath);
	if (!worktree)
		refuse(`dev-factory guard: the bind was refused: no folder above ${filePath} holds a .dev-factory/run.json, so it is not in a run.`);
	const run = readRunAt(worktree);
	if (!run) refuse(`dev-factory guard: the bind was refused: the run file in ${worktree} could not be read.`);
	const runRole = judgedRole(run);
	if (runRole !== 'researcher')
		refuse(
			`dev-factory guard: the bind was refused: the run in ${worktree} is for the ${runRole} role, and this agent is a researcher: an agent binds only to a run of its own role.`,
		);
	const verdict = verdictUnder(worktree, { ...run, role: 'researcher' });
	if (verdict.deny) refuse(`${verdict.reason} (nothing was bound: a researcher is bound by a first Write its limits allow)`);
	const r = bindAgent({ agentId: evt.agent_id, agentType: evt.agent_type, worktree });
	if (!r.ok) refuse(`dev-factory guard: the bind was refused: ${r.reason}`);
}

function judge(evt, factory) {
	const cwd = evt.cwd || process.cwd();
	const ti = evt.tool_input || {};
	const filePath = ti.file_path || ti.notebook_path;
	const text = [ti.content, ti.new_string, ti.new_source, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string) : [])]
		.filter(Boolean)
		.join('\n');
	const verdictUnder = (root, run) => evaluateEdit({ filePath, text, root, active: process.env.DF_ACTIVE === '1' || !!run, run });
	const who = { cwd, agentType: evt.agent_type, agentId: evt.agent_id };
	let resolved = resolveRun(who);
	if (factory && resolved.unbound) {
		const researcher = FACTORY_AGENT.exec(evt.agent_type)?.[2] === 'researcher';
		if (!researcher) refuse(unboundReason('Bind first with the Bash tool'));
		if (evt.tool_name !== 'Write') refuse(RESEARCHER_UNBOUND);
		bindResearcherByWrite(evt, filePath, verdictUnder);
		// judged again under the run now bound, as every later write is
		resolved = resolveRun(who);
		if (resolved.unbound) refuse(RESEARCHER_UNBOUND);
	}
	const run = factory && resolved.run ? { ...resolved.run, role: judgedRole(resolved.run) } : resolved.run;
	const verdict = verdictUnder(resolved.root, run);
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
			refuse(`dev-factory guard: the guard could not judge this edit (${e?.message ?? e}), so it is refused.`);
		}
	});
