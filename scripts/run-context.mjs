// Which factory run a hook event belongs to. A hook's `cwd` is the directory the session was started in,
// never the directory a Bash call moved to, and a dispatched agent runs in the scheduler's session. So the
// worktree cannot be read from `cwd`. What a hook does see inside a subagent is `agent_id` (unique to that
// agent) and `agent_type`; the main session carries neither. So each factory agent binds itself: its first
// command names its worktree (`bind --worktree DIR`), the Bash hook checks it and records
// $DF_STATE_DIR/agents/<agent_id>.json, and every later event of that agent resolves through its own record.
//
// One machine-wide pointer (active-run.json) used to stand in for this. It is no longer read: with two agents
// alive at once both resolved to it, and an agent whose pointer was lost was taken for the scheduler, with no
// role limits. A factory agent with no usable binding now resolves as `unbound`, which the hooks refuse.
//
//   run-context.mjs bind --worktree DIR    a factory agent's first command; the Bash hook records the binding, this prints one line
//   run-context.mjs clear                  forget every binding (and a leftover pointer)
//   run-context.mjs write --worktree DIR --json '{"key":"APP-1","role":"builder"}'
//                                          create DIR's .dev-factory/run.json, or merge these fields into it (null removes one)
//   run-context.mjs set --worktree DIR     no longer used; kept for one release, does nothing
//
// `write` exists because the edit hook and the shell hook protect run.json from every tool call once a scheduled pass is active
// (DF_ACTIVE=1), the scheduler's own session included: the file is how a run's role and limits are recorded, so only this command, which
// a factory agent is not allowed to run (scripts/guard-lib.mjs), changes it. A `write` that sets a role starts a new stage, so it drops
// that worktree's bindings: the next agent binds afresh and never meets its predecessor's record.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const FACTORY_AGENT = /(^|:)factory-(builder|reviewer|debugger|researcher|improver|promoter)$/;
// The role of a factory agent type, or null. The same reading as agentRoleOf in stop-gate-lib.mjs, kept here because that file
// imports this one.
const roleOf = (agentType) => (typeof agentType === 'string' ? FACTORY_AGENT.exec(agentType)?.[2] ?? null : null);
const stateDir = (env) => env.DF_STATE_DIR || path.join(os.homedir(), '.dev-factory');
export const pointerFile = (env = process.env) => path.join(stateDir(env), 'active-run.json');
export const bindingsDir = (env = process.env) => path.join(stateDir(env), 'agents');
// An agent id becomes a file name, so only these characters, and not too many of them, are accepted.
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const validId = (agentId) => typeof agentId === 'string' && AGENT_ID.test(agentId);
// One name for a folder however it was written: a symlink, /tmp for /private/tmp, or another case on case-insensitive storage all
// name the same worktree, and bindings compare worktrees by this name. A folder that cannot be resolved keeps its written form.
const canon = (p) => {
	const abs = path.resolve(p);
	try {
		return fs.realpathSync.native(abs);
	} catch {
		try {
			return fs.realpathSync(abs);
		} catch {
			return abs;
		}
	}
};
// The names a path may be stored or given under, so a binding written before paths were resolved is still found.
const pathNames = (p) => new Set([path.resolve(p), canon(p)]);
const sameFolder = (a, b) => {
	const nb = pathNames(b);
	return [...pathNames(a)].some((n) => nb.has(n));
};
const here = (cwd) => (typeof cwd === 'string' && cwd ? cwd : process.cwd());
// A run with no role is a builder's, as the stop gate's ownsRun reads it.
const runRoleOf = (run) => run.role ?? 'builder';

const readJson = (f) => {
	try {
		return JSON.parse(fs.readFileSync(f, 'utf8'));
	} catch {
		return null;
	}
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readRun = (worktree) => {
	const run = readJson(path.join(worktree, '.dev-factory', 'run.json'));
	return isObject(run) ? run : null;
};

const gitRoot = (cwd) => {
	try {
		return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return cwd;
	}
};

// Every binding on record as [agentId, { worktree, role, at }]; unreadable or malformed files are skipped.
function bindings(env) {
	let names;
	try {
		names = fs.readdirSync(bindingsDir(env));
	} catch {
		return [];
	}
	const out = [];
	for (const name of names) {
		if (!name.endsWith('.json')) continue;
		const id = name.slice(0, -'.json'.length);
		if (!validId(id)) continue;
		const b = readJson(path.join(bindingsDir(env), name));
		if (isObject(b) && typeof b.worktree === 'string' && path.isAbsolute(b.worktree) && typeof b.role === 'string') out.push([id, b]);
	}
	return out;
}

// The binding of one agent, used only when it was made for the agent's own role, its worktree still holds a run, and that run is
// still for this role (a binding from before a role change is never used, even if nothing removed it).
function boundRun(agentId, agentType, env) {
	if (!validId(agentId)) return null;
	const b = readJson(path.join(bindingsDir(env), `${agentId}.json`));
	if (!isObject(b) || typeof b.worktree !== 'string' || !path.isAbsolute(b.worktree)) return null;
	if (b.role !== roleOf(agentType)) return null;
	const root = canon(b.worktree);
	const run = readRun(root);
	if (!run || runRoleOf(run) !== b.role) return null;
	return { root, run };
}

// -> { root, run, via, unbound? } where run is null when the event is not part of a factory run. A factory agent that has no usable
// binding is marked `unbound`, so the hooks can refuse it rather than take it for the scheduler. Never throws; a missing cwd is the
// process directory.
export function resolveRun({ cwd, agentType = null, agentId = null, env = process.env } = {}) {
	cwd = here(cwd);
	const inCwd = readJson(path.join(cwd, '.dev-factory', 'run.json'));
	if (inCwd) return { root: cwd, run: inCwd, via: 'cwd' };
	if (roleOf(agentType)) {
		let found = null;
		try {
			found = boundRun(agentId, agentType, env);
		} catch {
			found = null;
		}
		if (found) return { ...found, via: 'binding' };
		return { root: gitRoot(cwd), run: null, via: 'none', unbound: true };
	}
	return { root: gitRoot(cwd), run: null, via: 'none' };
}

// Records that factory agent `agentId` works in `worktree`, after checking it may. -> { ok: true, binding } or { ok: false, reason }.
// The run's role was written by the scheduler and an agent cannot change it, so requiring the agent's own role keeps an agent from
// adopting another stage's run; refusing a second agent of the same role keeps two agents from sharing one run by mistake.
export function bindAgent({ agentId, agentType, worktree, env = process.env }) {
	const role = roleOf(agentType);
	if (!role) return { ok: false, reason: `Only a factory agent binds to a run, and ${JSON.stringify(agentType ?? null)} is not one.` };
	if (agentId === undefined || agentId === null || agentId === '')
		return { ok: false, reason: 'The bind needs the agent id that the hook event carries, and this event has none.' };
	if (!validId(agentId))
		return {
			ok: false,
			reason: 'The agent id may hold only letters, digits, "_" and "-", at most 128 of them, since it names the binding file.',
		};
	if (typeof worktree !== 'string' || !path.isAbsolute(worktree))
		return { ok: false, reason: 'The worktree must be an absolute path: pass the one your dispatch names.' };
	const run = readRun(path.resolve(worktree));
	if (!run) return { ok: false, reason: `There is no .dev-factory/run.json in ${path.resolve(worktree)}, so it is not a run to bind to.` };
	// the folder exists now, so its canonical name is the one every comparison uses
	const dir = canon(worktree);
	const runRole = runRoleOf(run);
	if (runRole !== role)
		return {
			ok: false,
			reason: `The run in ${dir} is for the ${runRole} role, and this agent is a ${role}: an agent binds only to a run of its own role.`,
		};
	if (holderOf(agentId, role, dir, env)) return alreadyBound(role, dir);
	const binding = { worktree: dir, role, at: new Date().toISOString() };
	const file = path.join(bindingsDir(env), `${agentId}.json`);
	// written beside the file and renamed over it, so a hook never reads half of it
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		fs.mkdirSync(bindingsDir(env), { recursive: true });
		fs.writeFileSync(tmp, JSON.stringify(binding) + '\n');
		fs.renameSync(tmp, file);
	} catch (e) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// nothing more can be done about a folder that cannot be written
		}
		return { ok: false, reason: `The binding could not be recorded in ${bindingsDir(env)} (${e.code || e.message}).` };
	}
	const settled = settleBinding(agentId, env);
	return settled.ok ? { ok: true, binding } : settled;
}

// Another agent's binding of `role` to the folder `dir`, as [agentId, binding], or undefined.
const holderOf = (agentId, role, dir, env) => bindings(env).find(([id, b]) => id !== agentId && b.role === role && sameFolder(b.worktree, dir));
const alreadyBound = (role, dir) => ({
	ok: false,
	reason: `Another ${role} agent is already bound to ${dir}, and one run has one agent of each role.`,
});
const earlier = ([idA, a], [idB, b]) => String(a.at ?? '') < String(b.at ?? '') || (String(a.at ?? '') === String(b.at ?? '') && idA < idB);

// The check after a binding is in place: two agents of one role binding to one worktree at the same moment can both pass the check
// before the write, so each looks again, and the one that bound later (by time, then agent id) removes its own record and is
// refused. Exported for its test; bindAgent calls it. -> { ok: true } or the refusal.
export function settleBinding(agentId, env = process.env) {
	if (!validId(agentId)) return { ok: false, reason: 'The agent id may hold only letters, digits, "_" and "-", at most 128 of them.' };
	const all = bindings(env);
	const mine = all.find(([id]) => id === agentId);
	if (!mine) return { ok: false, reason: 'The binding is no longer on record, so the bind did not take.' };
	const first = all.find(
		([id, b]) => id !== agentId && b.role === mine[1].role && sameFolder(b.worktree, mine[1].worktree) && earlier([id, b], mine),
	);
	if (!first) return { ok: true };
	try {
		fs.rmSync(path.join(bindingsDir(env), `${agentId}.json`), { force: true });
	} catch {
		// a record left behind is still the later one, so it loses the same check again
	}
	return alreadyBound(mine[1].role, canon(mine[1].worktree));
}

// Drops every binding to `worktree`, however either path was written.
export function unbindWorktree(worktree, env = process.env) {
	for (const [id, b] of bindings(env)) if (sameFolder(b.worktree, worktree)) fs.rmSync(path.join(bindingsDir(env), `${id}.json`), { force: true });
}

export const clearBindings = (env = process.env) => fs.rmSync(bindingsDir(env), { recursive: true, force: true });

// Forgets one agent's binding: the stop gate calls it when it lets a factory agent stop, so a finished agent never leaves a binding
// for workRoot to count. Never throws; an id that cannot name a binding file, or a binding already gone, leaves nothing to do.
export function unbindAgent(agentId, env = process.env) {
	if (!validId(agentId)) return;
	try {
		fs.rmSync(path.join(bindingsDir(env), `${agentId}.json`), { force: true });
	} catch {
		// a file that cannot be removed is still checked on every use: its role and run must match again
	}
}

// The hooks' refusal for a factory agent with no usable binding. The command named is this plugin's own script (this file), so it
// can be run as given; `how` says where to run it from, for the hooks that have no bind command of their own.
const OWN_SCRIPT = fileURLToPath(import.meta.url);
export const bindCommand = (worktree = '<the absolute worktree path your dispatch names>') => `node "${OWN_SCRIPT}" bind --worktree ${worktree}`;
export const unboundReason = (how = 'Run it now') =>
	`dev-factory guard: this factory agent is not bound to a run, and a run's limits must be known before any command or edit is allowed. ${how}, as your first command: ${bindCommand()}`;

// Root for a factory tool (qa.mjs, coverage.mjs) run from a dispatched agent. Such a tool has no agent identity, and a subagent's
// Bash call always starts in the session directory, so without --worktree: a run.json in the cwd wins, then the worktree of the
// only live binding; with live bindings to two or more worktrees the tool cannot tell which is meant and stops.
export function workRoot({ cwd, env = process.env } = {}) {
	cwd = here(cwd);
	if (fs.existsSync(path.join(cwd, '.dev-factory', 'run.json'))) return gitRoot(cwd);
	const live = [...new Set(bindings(env).map(([, b]) => canon(b.worktree)))].filter((w) => readRun(w));
	if (live.length === 1) return live[0];
	if (live.length > 1)
		throw new Error(
			`${live.length} worktrees have a factory agent bound to them, so the worktree cannot be told from here: pass --worktree <the absolute worktree path>`,
		);
	return gitRoot(cwd);
}

// The bind command, exactly: node "<...>/run-context.mjs" bind --worktree <absolute path>, the path bare or in single or double
// quotes. Anything else (a chain, a pipe, a redirect, a substitution, a glob, an extra flag or word) is not the bind command, so the
// hook judges it like any other command. -> { worktree } or null.
const SHELL_SPECIAL = /[;|&<>$`()\\\n\r*?[\]{}!#~]/;
const BIND_FORM = /^node[ \t]+"[^"]*\/run-context\.mjs"[ \t]+bind[ \t]+--worktree[ \t]+(?:'([^']+)'|"([^"]+)"|([^\s'"]+))$/;
export function parseBindCommand(command) {
	if (typeof command !== 'string' || SHELL_SPECIAL.test(command)) return null;
	const m = BIND_FORM.exec(command.replace(/^[ \t]+|[ \t]+$/g, ''));
	if (!m) return null;
	const worktree = m[1] ?? m[2] ?? m[3];
	return path.isAbsolute(worktree) ? { worktree } : null;
}

// Kept for one release so an older caller still loads; nothing reads the pointer any more.
export function setPointer(worktree, env = process.env) {
	if (!worktree || !path.isAbsolute(worktree)) throw new Error('set needs an absolute --worktree');
	if (!fs.existsSync(path.join(worktree, '.dev-factory', 'run.json'))) throw new Error(`no .dev-factory/run.json in ${worktree}`);
	fs.mkdirSync(path.dirname(pointerFile(env)), { recursive: true });
	fs.writeFileSync(pointerFile(env), JSON.stringify({ worktree, at: new Date().toISOString() }) + '\n');
}

export const clearPointer = (env = process.env) => fs.rmSync(pointerFile(env), { force: true });

export const ROLES = ['builder', 'reviewer', 'debugger', 'researcher', 'improver', 'promoter'];

// Create <worktree>/.dev-factory/run.json from `patch`, or merge `patch` into the file already there; a null value removes a field.
// The result must name a key and, when it names a role, one the hooks know, or nothing is written. A patch that names a role drops
// the worktree's bindings.
export function writeRun(worktree, patch, env = process.env) {
	if (!worktree || !path.isAbsolute(worktree)) throw new Error('write needs an absolute --worktree');
	if (!fs.existsSync(worktree) || !fs.statSync(worktree).isDirectory()) throw new Error(`no such worktree: ${worktree}`);
	if (!patch || typeof patch !== 'object' || Array.isArray(patch))
		throw new Error('write needs --json with an object, such as \'{"role":"reviewer"}\'');
	const dir = path.join(worktree, '.dev-factory');
	const file = path.join(dir, 'run.json');
	const merged = { ...(readJson(file) ?? {}), ...patch };
	for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
	if (typeof merged.key !== 'string' || !merged.key) throw new Error('run.json needs a key (the task key): none given and none in the file');
	if (merged.role !== undefined && !ROLES.includes(merged.role))
		throw new Error(`role must be one of ${ROLES.join(', ')} (got ${JSON.stringify(merged.role)})`);
	// before the new role is on disk, so no agent of the old stage ever resolves to the new one
	if (Object.hasOwn(patch, 'role')) unbindWorktree(worktree, env);
	fs.mkdirSync(dir, { recursive: true });
	// written beside the file and renamed over it, so a hook never reads half of it
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(merged) + '\n');
	fs.renameSync(tmp, file);
	return merged;
}

const USAGE = 'usage: run-context.mjs bind --worktree DIR | clear | write --worktree DIR --json OBJECT';

if (isMain(import.meta.url)) {
	const [cmd, ...rest] = process.argv.slice(2);
	const flags = {};
	for (let i = 0; i < rest.length; i += 2) flags[rest[i]] = rest[i + 1];
	try {
		if (cmd === 'bind') {
			const worktree = flags['--worktree'];
			if (!worktree || rest.length !== 2) throw new Error(USAGE);
			if (!path.isAbsolute(worktree)) throw new Error('bind needs an absolute --worktree');
			console.log(`run-context: the guard records this agent's binding to ${worktree} when it sees this command; nothing else to do.`);
		} else if (cmd === 'set') {
			console.error('run-context: set is no longer used: the pointer is gone, and each factory agent binds itself with bind --worktree DIR.');
		} else if (cmd === 'clear') {
			clearBindings();
			clearPointer();
		} else if (cmd === 'write' && flags['--worktree'] && flags['--json'] !== undefined) {
			let patch;
			try {
				patch = JSON.parse(flags['--json']);
			} catch {
				throw new Error('--json is not valid JSON');
			}
			writeRun(flags['--worktree'], patch);
		} else throw new Error(USAGE);
	} catch (e) {
		console.error(`run-context: ${e.message}`);
		process.exit(3);
	}
}
