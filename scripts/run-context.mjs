// Which factory run a hook event belongs to. A hook's `cwd` is the directory the session was started in,
// never the directory a Bash call moved to, and a dispatched agent runs in the scheduler's session. So the
// worktree cannot be read from `cwd`: the scheduler records the worktree it is dispatching into
// ($DF_STATE_DIR/active-run.json), and a hook trusts that pointer only for events raised by a factory agent
// (the hook input carries `agent_type` inside a subagent and no agent fields in the main session).
//
//   run-context.mjs set --worktree DIR     point hooks at DIR's .dev-factory/run.json
//   run-context.mjs clear                  forget the pointer
//   run-context.mjs write --worktree DIR --json '{"key":"APP-1","role":"builder"}'
//                                          create DIR's .dev-factory/run.json, or merge these fields into it (null removes one)
//
// `write` exists because the edit hook and the shell hook protect run.json from every tool call once a scheduled pass is active
// (DF_ACTIVE=1), the scheduler's own session included: the file is how a run's role and limits are recorded, so only this command, which
// a factory agent is not allowed to run (scripts/guard-lib.mjs), changes it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain } from './is-main.mjs';

export const FACTORY_AGENT = /(^|:)factory-(builder|reviewer|debugger|researcher|improver|promoter)$/;
const stateDir = (env) => env.DF_STATE_DIR || path.join(os.homedir(), '.dev-factory');
export const pointerFile = (env = process.env) => path.join(stateDir(env), 'active-run.json');

const readJson = (f) => {
	try {
		return JSON.parse(fs.readFileSync(f, 'utf8'));
	} catch {
		return null;
	}
};

const gitRoot = (cwd) => {
	try {
		return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return cwd;
	}
};

// -> { root, run, via } where run is null when the event is not part of a factory run.
export function resolveRun({ cwd, agentType = null, env = process.env }) {
	const here = readJson(path.join(cwd, '.dev-factory', 'run.json'));
	if (here) return { root: cwd, run: here, via: 'cwd' };
	if (agentType && FACTORY_AGENT.test(agentType)) {
		const worktree = readJson(pointerFile(env))?.worktree;
		const run = worktree && readJson(path.join(worktree, '.dev-factory', 'run.json'));
		if (run) return { root: worktree, run, via: 'pointer' };
	}
	return { root: gitRoot(cwd), run: null, via: 'none' };
}

// Root for a factory tool (qa.mjs) run from a dispatched agent: a subagent's Bash call always starts in the
// session directory (a `cd` does not carry to the next call), so without --worktree the pointer names the
// worktree the scheduler is dispatching into. A run.json in the cwd still wins.
export function workRoot({ cwd, env = process.env }) {
	if (fs.existsSync(path.join(cwd, '.dev-factory', 'run.json'))) return gitRoot(cwd);
	const worktree = readJson(pointerFile(env))?.worktree;
	return worktree && fs.existsSync(path.join(worktree, '.dev-factory', 'run.json')) ? worktree : gitRoot(cwd);
}

export function setPointer(worktree, env = process.env) {
	if (!worktree || !path.isAbsolute(worktree)) throw new Error('set needs an absolute --worktree');
	if (!fs.existsSync(path.join(worktree, '.dev-factory', 'run.json'))) throw new Error(`no .dev-factory/run.json in ${worktree}`);
	fs.mkdirSync(path.dirname(pointerFile(env)), { recursive: true });
	fs.writeFileSync(pointerFile(env), JSON.stringify({ worktree, at: new Date().toISOString() }) + '\n');
}

export const clearPointer = (env = process.env) => fs.rmSync(pointerFile(env), { force: true });

export const ROLES = ['builder', 'reviewer', 'debugger', 'researcher', 'improver', 'promoter'];

// Create <worktree>/.dev-factory/run.json from `patch`, or merge `patch` into the file already there; a null value removes a field.
// The result must name a key and, when it names a role, one the hooks know, or nothing is written.
export function writeRun(worktree, patch) {
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
	fs.mkdirSync(dir, { recursive: true });
	// written beside the file and renamed over it, so a hook never reads half of it
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(merged) + '\n');
	fs.renameSync(tmp, file);
	return merged;
}

if (isMain(import.meta.url)) {
	const [cmd, ...rest] = process.argv.slice(2);
	const flags = {};
	for (let i = 0; i < rest.length; i += 2) flags[rest[i]] = rest[i + 1];
	try {
		if (cmd === 'set' && flags['--worktree']) setPointer(flags['--worktree']);
		else if (cmd === 'clear') clearPointer();
		else if (cmd === 'write' && flags['--worktree'] && flags['--json'] !== undefined) {
			let patch;
			try {
				patch = JSON.parse(flags['--json']);
			} catch {
				throw new Error('--json is not valid JSON');
			}
			writeRun(flags['--worktree'], patch);
		} else throw new Error('usage: run-context.mjs set --worktree DIR | clear | write --worktree DIR --json OBJECT');
	} catch (e) {
		console.error(`run-context: ${e.message}`);
		process.exit(3);
	}
}
