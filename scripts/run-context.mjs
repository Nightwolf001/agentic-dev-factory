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
//   run-context.mjs clear                  forget every binding (and a leftover pointer), every session's: a person's tool, not a pass's
//   run-context.mjs write --worktree DIR --json '{"key":"APP-1","role":"builder"}'
//                                          create DIR's .dev-factory/run.json, or merge these fields into it (null removes one)
//   run-context.mjs set --worktree DIR     no longer used; kept for one release, does nothing
//
// A binding goes when the scheduler's role write starts the worktree's next stage, when the stop gate lets its agent stop, and when
// it is older than MAX_BINDING_AGE_MS (twelve hours). A pass does not clear them: interactive builds share the state folder and take
// no lock, so a pass that wiped the folder would unbind a live agent of another session.
//
// `write` exists because the edit hook and the shell hook protect run.json from every tool call once a scheduled pass is active
// (DF_ACTIVE=1), the scheduler's own session included: the file is how a run's role and limits are recorded, so only this command, which
// a factory agent is not allowed to run (scripts/guard-lib.mjs), changes it. A `write` that sets a role starts a new stage, so it drops
// that worktree's bindings: the next agent binds afresh and never meets its predecessor's record.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
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
// The role whose limits the hooks apply to a factory agent working in `run`: the same reading, so a builder in a run with no role is
// held to the builder limits rather than to none.
export const judgedRole = (run) => runRoleOf(run);

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

// A pass does not clear the bindings, because interactive sessions share the state folder and take no lock: a binding left by an
// agent that died (no stop, no role write after it) instead stops counting after this long. An agent's stage is far shorter.
export const MAX_BINDING_AGE_MS = 12 * 60 * 60 * 1000;
// Whether a binding is past its age, or carries no time that can be read: either way it is no binding.
const expired = (b) => {
	const t = Date.parse(b?.at);
	return !Number.isFinite(t) || Date.now() - t > MAX_BINDING_AGE_MS;
};

// Every binding on record as [agentId, { worktree, role, at }]; unreadable or malformed files are skipped, and so are expired ones
// unless `all` asks for them (the clean-up paths remove those too).
function bindings(env, { all = false } = {}) {
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
		if (isObject(b) && typeof b.worktree === 'string' && path.isAbsolute(b.worktree) && typeof b.role === 'string' && (all || !expired(b)))
			out.push([id, b]);
	}
	return out;
}

// Removes the expired bindings and their claims. Never throws.
function pruneExpired(env) {
	for (const [id, b] of bindings(env, { all: true })) {
		if (!expired(b)) continue;
		dropClaim(b.worktree, b.role, id, env);
		try {
			fs.rmSync(path.join(bindingsDir(env), `${id}.json`), { force: true });
		} catch {
			// it is still skipped as expired wherever bindings are read
		}
	}
}

// The binding of one agent, used only when it was made for the agent's own role, is not past its age, its worktree still holds a
// run, and that run is still for this role (a binding from before a role change is never used, even if nothing removed it).
function boundRun(agentId, agentType, env) {
	if (!validId(agentId)) return null;
	const b = readJson(path.join(bindingsDir(env), `${agentId}.json`));
	if (!isObject(b) || typeof b.worktree !== 'string' || !path.isAbsolute(b.worktree) || expired(b)) return null;
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
	// bindings past their age are removed here, where a bind looks at every other one anyway
	pruneExpired(env);
	// one agent works in one run: a live binding of its own to another worktree is not moved by a second bind
	const current = liveBinding(agentId, role, env);
	if (current && current.root !== dir)
		return {
			ok: false,
			reason: `This agent is already bound to ${current.root}, and an agent works in one run: it does not bind to ${dir} as well.`,
		};
	if (holderOf(agentId, role, dir, env)) return alreadyBound(role, dir);
	const binding = { worktree: dir, role, at: new Date().toISOString() };
	const file = path.join(bindingsDir(env), `${agentId}.json`);
	// a binding of its own that no longer resolves (its run moved on) gives up its claim before the agent claims anew
	const previous = readJson(file);
	if (isObject(previous) && typeof previous.worktree === 'string' && typeof previous.role === 'string' && !sameFolder(previous.worktree, dir))
		dropClaim(previous.worktree, previous.role, agentId, env);
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
	// Two agents of one role binding to one worktree at the same moment can both pass the check above before either writes, so the
	// claim, created exclusively, settles it: the first to create it wins, whatever the clocks say (this replaces a look-again that
	// ordered the bindings by time). The binding is written before the claim, so a claim on record names an agent whose binding was
	// written first, and one whose binding is gone left its claim behind.
	const claimed = claim(agentId, role, dir, env);
	if (claimed.ok) return { ok: true, binding };
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// a binding left behind without its claim still meets the holder check of the next bind
	}
	return claimed;
}

// Another agent's binding of `role` to the folder `dir`, as [agentId, binding], or undefined.
const holderOf = (agentId, role, dir, env) => bindings(env).find(([id, b]) => id !== agentId && b.role === role && sameFolder(b.worktree, dir));
const alreadyBound = (role, dir) => ({
	ok: false,
	reason: `Another ${role} agent is already bound to ${dir}, and one run has one agent of each role.`,
});

// The agent's own binding while it still resolves (its run is still for its role), as { root, run }, or null.
const liveBinding = (agentId, role, env) => {
	try {
		return boundRun(agentId, `factory-${role}`, env);
	} catch {
		return null;
	}
};

// One claim per worktree and role: <state>/agents/claims/<sha256 of the canonical worktree>.<role>, holding the agent id.
const claimsDir = (env) => path.join(bindingsDir(env), 'claims');
const worktreeHash = (dir) => crypto.createHash('sha256').update(dir).digest('hex');
const claimFile = (dir, role, env) => path.join(claimsDir(env), `${worktreeHash(canon(dir))}.${role}`);
const readClaim = (f) => {
	try {
		return fs.readFileSync(f, 'utf8').trim();
	} catch {
		return null;
	}
};
// Whether the claim's holder still has a binding of that role to that worktree; a claim without one was left behind.
const holdsClaim = (holder, role, dir, env) => {
	if (!validId(holder)) return false;
	const b = readJson(path.join(bindingsDir(env), `${holder}.json`));
	return isObject(b) && !expired(b) && b.role === role && typeof b.worktree === 'string' && sameFolder(b.worktree, dir);
};
// Exclusive and whole: the id is written to a file of its own and linked into place, which fails if the name exists, so no reader
// ever meets a claim that is there but still empty.
const createClaim = (f, agentId) => {
	const tmp = `${f}.${agentId}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, agentId, { flag: 'w' });
	try {
		fs.linkSync(tmp, f);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
};

const TAKEOVER_STALE_MS = 10_000;
const BUSY = (role, dir) => `Another bind of the ${role} of the run in ${dir} is being recorded; retry once in a few seconds.`;
// Removes a takeover file older than TAKEOVER_STALE_MS (by mtime). -> whether it was stale (and is gone). It is renamed to a name of
// this process's own before anything else: a fresh takeover another agent created just after the age was read would otherwise be
// removed with it. Only one rename of the stale file succeeds; the renamed file is checked again and put back if it is fresh.
const removeStaleTakeover = (takeover) => {
	try {
		if (Date.now() - fs.statSync(takeover).mtimeMs <= TAKEOVER_STALE_MS) return false;
		const mine = `${takeover}.${process.pid}.${Date.now()}.stale`;
		fs.renameSync(takeover, mine);
		if (Date.now() - fs.statSync(mine).mtimeMs <= TAKEOVER_STALE_MS) {
			// a fresh one was moved: back under its name unless another took its place meanwhile
			try {
				fs.linkSync(mine, takeover);
			} catch {
				// the name is taken again, by a takeover that is fresh in its turn
			}
			fs.rmSync(mine, { force: true });
			return false;
		}
		fs.rmSync(mine, { force: true });
		return true;
	} catch {
		return false;
	}
};

// -> { ok: true } or a refusal. A claim left behind is replaced only under a takeover file, itself created exclusively, so two agents
// that find the same leftover claim cannot both remove it and both win; the one that loses is refused and may bind again.
function claim(agentId, role, dir, env) {
	const f = claimFile(dir, role, env);
	const lost = (reason = alreadyBound(role, dir).reason) => ({ ok: false, reason });
	try {
		fs.mkdirSync(claimsDir(env), { recursive: true });
		createClaim(f, agentId);
		return { ok: true };
	} catch (e) {
		if (e.code !== 'EEXIST') return lost(`The claim on ${dir} could not be recorded in ${claimsDir(env)} (${e.code || e.message}).`);
	}
	const holder = readClaim(f);
	if (holder === agentId) return { ok: true };
	if (holder === null) return lost(`The claim for the ${role} of the run in ${dir} could not be read, so this bind did not take.`);
	if (holdsClaim(holder, role, dir, env)) return lost();
	const takeover = `${f}.takeover`;
	try {
		createClaim(takeover, agentId);
	} catch {
		// a takeover is over in milliseconds, so one older than TAKEOVER_STALE_MS was left by a hook that died: it is removed and the
		// takeover tried once more
		if (!removeStaleTakeover(takeover)) return lost(BUSY(role, dir));
		try {
			createClaim(takeover, agentId);
		} catch {
			return lost(BUSY(role, dir));
		}
	}
	try {
		if (readClaim(f) !== holder) return lost();
		fs.rmSync(f, { force: true });
		createClaim(f, agentId);
		return { ok: true };
	} catch {
		return lost();
	} finally {
		try {
			fs.rmSync(takeover, { force: true });
		} catch {
			// a takeover file left behind goes with the worktree's other claims when its stage ends (unbindWorktree)
		}
	}
}

// Removes the claim on `worktree` for `role` when `agentId` holds it. Never throws.
function dropClaim(worktree, role, agentId, env) {
	try {
		const f = claimFile(worktree, role, env);
		if (readClaim(f) === agentId) fs.rmSync(f, { force: true });
	} catch {
		// a claim that cannot be removed is replaced at a later bind once its holder's binding is gone
	}
}

// Drops every binding to `worktree`, however either path was written, and every claim on it whatever the role.
export function unbindWorktree(worktree, env = process.env) {
	for (const [id, b] of bindings(env, { all: true }))
		if (sameFolder(b.worktree, worktree)) fs.rmSync(path.join(bindingsDir(env), `${id}.json`), { force: true });
	let names;
	try {
		names = fs.readdirSync(claimsDir(env));
	} catch {
		return;
	}
	const hashes = new Set([...pathNames(worktree)].map(worktreeHash));
	for (const name of names) if (hashes.has(name.split('.')[0])) fs.rmSync(path.join(claimsDir(env), name), { force: true });
}

export const clearBindings = (env = process.env) => fs.rmSync(bindingsDir(env), { recursive: true, force: true });

// Forgets one agent's binding: the stop gate calls it when it lets a factory agent stop, so a finished agent never leaves a binding
// for workRoot to count. Never throws; an id that cannot name a binding file, or a binding already gone, leaves nothing to do.
export function unbindAgent(agentId, env = process.env) {
	if (!validId(agentId)) return;
	try {
		const file = path.join(bindingsDir(env), `${agentId}.json`);
		const b = readJson(file);
		// the claim goes first: while the binding is still on record, no other agent takes the claim for one left behind
		if (isObject(b) && typeof b.worktree === 'string' && typeof b.role === 'string') dropClaim(b.worktree, b.role, agentId, env);
		fs.rmSync(file, { force: true });
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
// hook judges it like any other command. -> { worktree, script } (the script path as written) or null.
const SHELL_SPECIAL = /[;|&<>$`()\\\n\r*?[\]{}!#~]/;
const BIND_FORM = /^node[ \t]+"([^"]*\/run-context\.mjs)"[ \t]+bind[ \t]+--worktree[ \t]+(?:'([^']+)'|"([^"]+)"|([^\s'"]+))$/;
export function parseBindCommand(command) {
	if (typeof command !== 'string' || SHELL_SPECIAL.test(command)) return null;
	const m = BIND_FORM.exec(command.replace(/^[ \t]+|[ \t]+$/g, ''));
	if (!m) return null;
	const worktree = m[2] ?? m[3] ?? m[4];
	return path.isAbsolute(worktree) ? { worktree, script: m[1] } : null;
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
