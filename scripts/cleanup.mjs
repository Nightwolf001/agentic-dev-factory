// Tears down what a run leaves behind, so the next run starts from nothing: its compose project, its dev server, the
// simulator it booted, its locks. With the takeover toggle (cleanup.takeover, DF_TAKEOVER=1 or --takeover) it also stops
// whatever stands in the way: processes and containers holding the ports the run needs, and the Playwright and Maestro
// sessions a run opens.
//
//   cleanup.mjs [--worktree DIR] [--takeover] [--ports 3000,1337] [--dry-run]
//
// Default scope (always): the compose project and Metro of the worktree (through e2e-env.sh and mobile-env.sh), a simulator
//   the factory booted, stale locks and orphaned stacks. Nothing here belongs to anyone else.
// Takeover scope: the above, plus
//   - the listener on each port the run publishes or serves on (a container is stopped, any other process gets TERM and
//     then KILL), the ports being those of the compose file, mobile.metroPort, the web address, and cleanup.ports
//   - browsers started by Playwright and drivers started by Maestro (their MCP servers stay: the session uses them)
//   - the simulator recorded for the run
// Never touched, even in takeover: this process and its parents, Claude itself, shells and terminals, system services.
//
// Prints one JSON object: { takeover, done: [...], left: [...] }. Exit 0 when it finished, 1 on a usage error.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';

const SELF = path.dirname(fileURLToPath(import.meta.url));

// The first word of a command line (a program path, or a login shell such as -zsh) that is never stopped.
export const PROTECTED_PROGRAM =
	/(^|\/)(-?(zsh|bash|fish|sh)|claude|Claude|anthropic|launchd|sshd|WindowServer|loginwindow|Finder|Dock|SystemUIServer|Terminal|iTerm2?|tmux|screen|login)$|Claude\.app|^\/System\/|^\/usr\/libexec\//;
export const DOCKER_NAMES = /docker|com\.docker|vpnkit|OrbStack|colima|lima|rancher/i;
const PLAYWRIGHT_BROWSER = /playwright_chromiumdev_profile|ms-playwright\/|playwright-mcp-profile|mcp-chrome-/;
const PLAYWRIGHT_SERVER = /@playwright\/mcp|playwright-mcp\/cli|playwright.*\bmcp\b/;
const MAESTRO_PROCESS = /maestro(-driver|\.cli|\.android|\.ios)|dev\.mobile\.maestro|maestro[^ ]* (test|studio|record)\b|maestro-driver-ios/i;

export const defaultRun = (cmd, args, opts = {}) => {
	const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 60000 });
	return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// `ps` as { pid, ppid, command } rows
export function processes(run = defaultRun) {
	return run('ps', ['-axo', 'pid=,ppid=,command='])
		.stdout.split('\n')
		.map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
		.filter(Boolean)
		.map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}

// This process and every parent of it: they run the session and must outlive the cleanup.
export function lineage(procs, pid = process.pid) {
	const byPid = new Map(procs.map((p) => [p.pid, p]));
	const out = new Set();
	for (let p = pid; p > 1 && !out.has(p); p = byPid.get(p)?.ppid ?? 0) out.add(p);
	return out;
}

export function protectedReason(proc, keep) {
	if (proc.pid <= 1) return 'a system process';
	if (keep.has(proc.pid)) return 'this session or one of its parents';
	const program = proc.command.split(' ')[0];
	if (PROTECTED_PROGRAM.test(program) || /\bclaude\b/.test(proc.command.split(' ').slice(0, 2).join(' ')))
		return 'Claude, a shell, a terminal or a system service';
	return null;
}

// Listeners on a TCP port: [{ pid, name }]
export function listeners(port, run = defaultRun) {
	const found = [];
	for (const line of run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']).stdout.split('\n')) {
		if (line.startsWith('p')) found.push({ pid: Number(line.slice(1)), name: '' });
		else if (line.startsWith('c') && found.length) found[found.length - 1].name = line.slice(1);
	}
	return found;
}

export function containersOn(port, run = defaultRun) {
	return run('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}'])
		.stdout.split('\n')
		.filter(Boolean)
		.map((l) => {
			const [id, name, project] = l.split('\t');
			return { id, name, project };
		});
}

// Ports the run needs: the compose file's published ports, Metro, the web address, and cleanup.ports.
export function portsFor({ cfg, worktree, extra = [], run = defaultRun }) {
	const ports = new Set(extra.map(Number));
	for (const p of get('cleanup.ports', { config: cfg }) ?? []) ports.add(Number(p));
	const metro = get('mobile.metroPort', { config: cfg });
	if (get('mobile.appDir', { config: cfg }) && metro) ports.add(Number(metro));
	const web = get('environment.webBaseUrl', { config: cfg });
	if (web) {
		try {
			const u = new URL(web);
			ports.add(Number(u.port || (u.protocol === 'https:' ? 443 : 80)));
		} catch {
			/* not a URL */
		}
	}
	const compose = get('environment.composeFile', { config: cfg });
	if (get('environment.type', { config: cfg }) === 'compose' && compose) {
		const file = path.resolve(worktree ?? '.', compose);
		if (fs.existsSync(file)) {
			try {
				const j = JSON.parse(run('docker', ['compose', '-f', file, 'config', '--format', 'json']).stdout || '{}');
				for (const s of Object.values(j.services ?? {}))
					for (const p of s.ports ?? []) ports.add(Number(typeof p === 'object' ? p.published : String(p).split(':').slice(-2)[0]));
			} catch {
				/* compose not answering */
			}
		}
	}
	return [...ports].filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => defaultRun('kill', ['-0', String(pid)]).status === 0;

// TERM, wait up to `wait` ms for the process to go, then KILL.
export async function stopProcess(pid, { run = defaultRun, wait = 3000, alive = isAlive } = {}) {
	run('kill', ['-TERM', String(pid)]);
	for (let t = 0; t < wait; t += 250) {
		if (!alive(pid)) return 'stopped';
		await sleep(250);
	}
	if (!alive(pid)) return 'stopped';
	run('kill', ['-KILL', String(pid)]);
	return 'killed';
}

export async function cleanup({
	worktree,
	takeover = false,
	ports: extraPorts = [],
	dryRun = false,
	cfg = load(),
	env = process.env,
	run = defaultRun,
	stop = stopProcess,
	state = env.DF_STATE_DIR || path.join(os.homedir(), '.dev-factory'),
} = {}) {
	const done = [];
	const left = [];
	const act = (what, target, fn) => done.push({ what, target, result: dryRun ? 'would run' : fn() });
	const envJson = worktree ? path.join(worktree, '.dev-factory', 'env.json') : null;
	const recorded = envJson && fs.existsSync(envJson) ? JSON.parse(fs.readFileSync(envJson, 'utf8')) : {};

	// ---- what the factory started ----
	if (worktree && recorded.project)
		act('compose project down', recorded.project, () =>
			run('bash', [path.join(SELF, 'e2e-env.sh'), 'down', '--worktree', worktree], { timeout: 300000 }).status === 0 ? 'down' : 'failed',
		);
	if (worktree && fs.existsSync(path.join(worktree, '.dev-factory', 'metro.pid')))
		act('dev server stop', 'Metro', () =>
			run('bash', [path.join(SELF, 'mobile-env.sh'), 'down', '--worktree', worktree]).status === 0 ? 'stopped' : 'failed',
		);
	const udid = recorded.device?.udid;
	if (udid && (recorded.device.bootedByFactory || takeover))
		act('simulator shutdown', udid, () => (run('xcrun', ['simctl', 'shutdown', udid]).status === 0 ? 'shut down' : 'already off'));
	else if (udid)
		left.push({
			what: 'simulator',
			target: udid,
			why: 'it was already running before the factory started (set cleanup.takeover to shut it down)',
		});
	act('orphaned stacks swept', 'df-* projects with no live owner', () =>
		run('bash', [path.join(SELF, 'e2e-env.sh'), 'sweep']).status === 0 ? 'swept' : 'failed',
	);

	// ---- whatever stands in the way ----
	const ports = portsFor({ cfg, worktree, extra: extraPorts, run });
	const procs = processes(run);
	const keep = lineage(procs);
	for (const port of ports) {
		const holders = listeners(port, run);
		const containers = containersOn(port, run);
		if (!holders.length && !containers.length) continue;
		if (!takeover) {
			const who = [...containers.map((c) => `container ${c.name}`), ...holders.map((h) => `${h.name} (pid ${h.pid})`)].join(', ');
			left.push({ what: 'port', target: String(port), why: `held by ${who}; not started by the factory (set cleanup.takeover to stop it)` });
			continue;
		}
		for (const c of containers)
			act('container stop', `${c.name} (port ${port})`, () =>
				run('docker', ['stop', c.id], { timeout: 120000 }).status === 0 ? 'stopped' : 'failed',
			);
		for (const h of holders) {
			const proc = procs.find((p) => p.pid === h.pid) ?? { pid: h.pid, command: h.name };
			if (containers.length && DOCKER_NAMES.test(`${h.name} ${proc.command}`)) continue; // the container's own proxy goes with the container
			const why = protectedReason(proc, keep);
			if (why) left.push({ what: 'port', target: String(port), why: `pid ${h.pid} ${h.name} is ${why}` });
			else
				done.push({
					what: 'process stop',
					target: `${h.name} (pid ${h.pid}, port ${port})`,
					result: dryRun ? 'would run' : await stop(h.pid, { run }),
				});
		}
	}

	if (takeover) {
		for (const [what, re, exclude] of [
			['Playwright browser stop', PLAYWRIGHT_BROWSER, PLAYWRIGHT_SERVER],
			['Maestro session stop', MAESTRO_PROCESS, /\bmcp\b/],
		]) {
			for (const p of procs.filter((q) => re.test(q.command) && !exclude.test(q.command))) {
				if (protectedReason(p, keep)) continue;
				done.push({
					what,
					target: `pid ${p.pid} ${p.command.slice(0, 60)}`,
					result: dryRun ? 'would run' : await stop(p.pid, { run, wait: 2000 }),
				});
			}
		}
	} else {
		const sessions = procs.filter(
			(q) =>
				(PLAYWRIGHT_BROWSER.test(q.command) && !PLAYWRIGHT_SERVER.test(q.command)) ||
				(MAESTRO_PROCESS.test(q.command) && !/\bmcp\b/.test(q.command)),
		);
		if (sessions.length)
			left.push({
				what: 'browser or Maestro sessions',
				target: `${sessions.length} process(es)`,
				why: 'the session may still be using them (set cleanup.takeover to stop them)',
			});
	}

	// ---- locks ----
	const lock = path.join(state, 'ports.lock');
	if (fs.existsSync(lock)) {
		const owner = Number(fs.readFileSync(path.join(lock, 'owner'), 'utf8').trim() || 0);
		const dead = !owner || run('kill', ['-0', String(owner)]).status !== 0;
		if (dead || takeover) act('ports lock released', lock, () => (fs.rmSync(lock, { recursive: true, force: true }), 'released'));
		else left.push({ what: 'ports lock', target: lock, why: `held by running pid ${owner}` });
	}
	return { takeover, done, left };
}

if (isMain(import.meta.url)) {
	const argv = process.argv.slice(2);
	const val = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
	let cfg;
	try {
		cfg = load();
	} catch (e) {
		console.error(`cleanup: ${e.message}`);
		process.exit(1);
	}
	const toggle = get('cleanup.takeover', { config: cfg }) === true || argv.includes('--takeover');
	const worktree = val('worktree') ? path.resolve(val('worktree')) : undefined;
	const ports = (val('ports') ?? '').split(',').filter(Boolean);
	cleanup({ worktree, takeover: toggle, ports, dryRun: argv.includes('--dry-run'), cfg })
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error(`cleanup: ${e.message}`);
			process.exit(1);
		});
}
