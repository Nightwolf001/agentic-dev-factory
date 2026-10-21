// Which factory run a hook event belongs to. A hook's `cwd` is the directory the session was started in,
// never the directory a Bash call moved to, and a dispatched agent runs in the scheduler's session. So the
// worktree cannot be read from `cwd`: the scheduler records the worktree it is dispatching into
// ($DF_STATE_DIR/active-run.json), and a hook trusts that pointer only for events raised by a factory agent
// (the hook input carries `agent_type` inside a subagent and no agent fields in the main session).
//
//   run-context.mjs set --worktree DIR     point hooks at DIR's .dev-factory/run.json
//   run-context.mjs clear                  forget the pointer
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

if (isMain(import.meta.url)) {
	const [cmd, flag, value] = process.argv.slice(2);
	try {
		if (cmd === 'set' && flag === '--worktree') setPointer(value);
		else if (cmd === 'clear') clearPointer();
		else throw new Error('usage: run-context.mjs set --worktree DIR | clear');
	} catch (e) {
		console.error(`run-context: ${e.message}`);
		process.exit(3);
	}
}
