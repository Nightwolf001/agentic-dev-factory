// Tears down what a run leaves behind, so the next run starts from nothing: its compose project, its dev server, the
// simulator it booted, its locks. With the takeover toggle (DF_TAKEOVER=1 in the owner's environment, see takeover.mjs) it
// also stops whatever stands in the way: processes and containers holding the ports the run needs, and the Playwright and
// Maestro sessions a run opens. The toggle is not a flag: `--takeover` is refused, so it cannot be set from a command line.
//
//   cleanup.mjs [--worktree DIR] [--ports 3000,1337] [--dry-run]
//   cleanup.mjs --restore [--dry-run]     give back what takeover stopped: restart the containers it recorded in
//                                         <state>/takeover-stopped.json; processes cannot be restarted and are only listed
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
import { takeoverOn } from './takeover.mjs';

const SELF = path.dirname(fileURLToPath(import.meta.url));

// The first word of a command line (a program path, or a login shell such as -zsh) that is never stopped.
export const PROTECTED_PROGRAM =
	/(^|\/)(-?(zsh|bash|fish|sh)|claude|Claude|anthropic|launchd|sshd|WindowServer|loginwindow|Finder|Dock|SystemUIServer|Terminal|iTerm2?|tmux|screen|login)$|Claude\.app|^\/System\/|^\/usr\/libexec\//;
export const DOCKER_NAMES = /docker|com\.docker|vpnkit|OrbStack|colima|lima|rancher/i;
const PLAYWRIGHT_BROWSER = /playwright_chromiumdev_profile|ms-playwright\/|playwright-mcp-profile|mcp-chrome-/;
const PLAYWRIGHT_SERVER = /@playwright\/mcp|playwright-mcp\/cli|playwright.*\bmcp\b/;
const MAESTRO_PROCESS = /maestro(-driver|\.cli|\.android|\.ios)|dev\.mobile\.maestro|maestro[^ ]* (test|studio|record)\b|maestro-driver-ios/i;

// adb from the PATH, else from the Android SDK
export const adbBin = (env = process.env) => {
	const sdk = env.ANDROID_SDK_ROOT || env.ANDROID_HOME;
	return sdk && fs.existsSync(path.join(sdk, 'platform-tools', 'adb')) ? path.join(sdk, 'platform-tools', 'adb') : 'adb';
};

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

// A host that is this machine. A deployed address (staging, a vendor) names a port on somebody else's machine, never one to free here.
export const isLocalHost = (host) => /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[?::1\]?|[^/]+\.(local|localhost|test))$/i.test(host);

// Ports the run needs: the compose file's published ports, Metro, the web address when it is local, and cleanup.ports.
export function portsFor({ cfg, worktree, extra = [], run = defaultRun }) {
	const ports = new Set(extra.map(Number));
	for (const p of get('cleanup.ports', { config: cfg }) ?? []) ports.add(Number(p));
	const metro = get('mobile.metroPort', { config: cfg });
	if (get('mobile.appDir', { config: cfg }) && metro) ports.add(Number(metro));
	const web = get('environment.webBaseUrl', { config: cfg });
	if (web) {
		try {
			const u = new URL(web);
			if (isLocalHost(u.hostname)) ports.add(Number(u.port || (u.protocol === 'https:' ? 443 : 80)));
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
	await sleep(100);
	return alive(pid) ? 'failed' : 'killed';
}

// What takeover stopped, so it can be given back: containers can be started again, processes only listed.
export const stoppedFile = (state) => path.join(state, 'takeover-stopped.json');
function readStopped(state) {
	try {
		const j = JSON.parse(fs.readFileSync(stoppedFile(state), 'utf8'));
		return { containers: Array.isArray(j.containers) ? j.containers : [], processes: Array.isArray(j.processes) ? j.processes : [] };
	} catch {
		return { containers: [], processes: [] };
	}
}
function writeStopped(state, rec) {
	if (!rec.containers.length && !rec.processes.length) return fs.rmSync(stoppedFile(state), { force: true });
	fs.mkdirSync(state, { recursive: true });
	fs.writeFileSync(stoppedFile(state), JSON.stringify(rec, null, 2) + '\n');
}

// Restarts the containers takeover stopped. A container that is gone or will not start stays on the list and is reported.
export function restore({
	dryRun = false,
	run = defaultRun,
	env = process.env,
	state = env.DF_STATE_DIR || path.join(os.homedir(), '.dev-factory'),
} = {}) {
	const rec = readStopped(state);
	const done = [];
	const left = [];
	const keep = { containers: [], processes: [] };
	for (const c of rec.containers) {
		if (dryRun) {
			done.push({ what: 'container start', target: c.name, result: 'would run' });
			continue;
		}
		const ok = run('docker', ['start', c.id], { timeout: 120000 }).status === 0;
		if (ok) done.push({ what: 'container start', target: c.name, result: 'restarted' });
		else {
			keep.containers.push(c);
			left.push({
				what: 'container',
				target: c.name,
				why: 'it would not start again (a port may be taken, or it was removed); start it yourself',
			});
		}
	}
	for (const p of rec.processes)
		left.push({
			what: 'process',
			target: `${p.name} (was pid ${p.pid}, port ${p.port})`,
			why: 'a stopped process cannot be restarted from here; start it yourself',
		});
	if (!dryRun) writeStopped(state, { containers: keep.containers, processes: [] });
	return { restore: true, done, left };
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
	const record = { containers: [], processes: [] };
	// written as each stop happens: a failure later in the run must not lose what was already stopped
	const remember = (kind, item) => {
		record[kind].push(item);
		if (dryRun) return;
		const before = readStopped(state);
		writeStopped(state, {
			containers: kind === 'containers' ? [...before.containers, item] : before.containers,
			processes: kind === 'processes' ? [...before.processes, item].slice(-50) : before.processes,
		});
	};
	const act = (what, target, fn) => done.push({ what, target, result: dryRun ? 'would run' : fn() });
	const envJson = worktree ? path.join(worktree, '.dev-factory', 'env.json') : null;
	let recorded = {};
	try {
		if (envJson && fs.existsSync(envJson)) recorded = JSON.parse(fs.readFileSync(envJson, 'utf8')) ?? {};
	} catch {
		/* an unreadable record must not stop the rest of the clean-up: act on what the machine shows */
	}

	// ---- what the factory started ----
	if (worktree && recorded.project)
		act('compose project down', recorded.project, () =>
			run('bash', [path.join(SELF, 'e2e-env.sh'), 'down', '--worktree', worktree], { timeout: 300000 }).status === 0 ? 'down' : 'failed',
		);
	if (worktree && fs.existsSync(path.join(worktree, '.dev-factory', 'metro.pid')))
		act('dev server stop', 'Metro', () =>
			run('bash', [path.join(SELF, 'mobile-env.sh'), 'down', '--worktree', worktree]).status === 0 ? 'stopped' : 'failed',
		);
	// an Android emulator the run booted is killed (adb emu kill, then the process if it is still ours); one already running stays
	const serial = recorded.device?.platform === 'android' ? recorded.device.serial : null;
	if (serial && (recorded.device.bootedByFactory || takeover)) {
		act('emulator kill', serial, () => {
			const killed = run(adbBin(), ['-s', serial, 'emu', 'kill']).status === 0;
			const pidFile = worktree ? path.join(worktree, '.dev-factory', 'emulator.pid') : null;
			if (pidFile && fs.existsSync(pidFile)) {
				const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
				// a pid file outlives its process: only a process that is still an emulator is stopped
				const command = pid > 1 ? run('ps', ['-p', String(pid), '-o', 'command=']).stdout?.toString() ?? '' : '';
				if (pid > 1 && pid !== process.pid && !killed && /emulator|qemu/i.test(command)) run('kill', ['-TERM', String(pid)]);
				fs.rmSync(pidFile, { force: true });
			}
			return killed ? 'killed' : 'already off';
		});
	} else if (serial)
		left.push({
			what: 'emulator',
			target: serial,
			why: 'it was already running before the factory started (the owner sets DF_TAKEOVER to shut it down)',
		});
	const udid = recorded.device?.platform === 'android' ? null : recorded.device?.udid;
	if (udid && (recorded.device.bootedByFactory || takeover))
		act('simulator shutdown', udid, () => (run('xcrun', ['simctl', 'shutdown', udid]).status === 0 ? 'shut down' : 'already off'));
	else if (udid)
		left.push({
			what: 'simulator',
			target: udid,
			why: 'it was already running before the factory started (the owner sets DF_TAKEOVER to shut it down)',
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
			left.push({
				what: 'port',
				target: String(port),
				why: `held by ${who}; not started by the factory (the owner sets DF_TAKEOVER to stop it)`,
			});
			continue;
		}
		for (const c of containers)
			act('container stop', `${c.name} (port ${port})`, () => {
				const stopped = run('docker', ['stop', c.id], { timeout: 120000 }).status === 0;
				if (stopped) remember('containers', { id: c.id, name: c.name, project: c.project, port, at: new Date().toISOString() });
				return stopped ? 'stopped' : 'failed';
			});
		for (const h of holders) {
			const proc = procs.find((p) => p.pid === h.pid) ?? { pid: h.pid, command: h.name };
			if (containers.length && DOCKER_NAMES.test(`${h.name} ${proc.command}`)) continue; // the container's own proxy goes with the container
			const why = protectedReason(proc, keep);
			if (why) left.push({ what: 'port', target: String(port), why: `pid ${h.pid} ${h.name} is ${why}` });
			else {
				const result = dryRun ? 'would run' : await stop(h.pid, { run });
				if (!dryRun && result !== 'failed')
					remember('processes', { pid: h.pid, name: h.name, command: proc.command.slice(0, 200), port, at: new Date().toISOString() });
				done.push({ what: 'process stop', target: `${h.name} (pid ${h.pid}, port ${port})`, result });
			}
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
				why: 'the session may still be using them (the owner sets DF_TAKEOVER to stop them)',
			});
	}

	// ---- locks ----
	const lock = path.join(state, 'ports.lock');
	if (fs.existsSync(lock)) {
		// a lock with no readable owner was abandoned part-way: nobody is holding it
		let owner = 0;
		try {
			owner = Number(fs.readFileSync(path.join(lock, 'owner'), 'utf8').trim() || 0);
		} catch {
			/* no owner file */
		}
		const dead = !owner || run('kill', ['-0', String(owner)]).status !== 0;
		if (dead || takeover) act('ports lock released', lock, () => (fs.rmSync(lock, { recursive: true, force: true }), 'released'));
		else left.push({ what: 'ports lock', target: lock, why: `held by running pid ${owner}` });
	}
	return { takeover, done, left };
}

if (isMain(import.meta.url)) {
	const argv = process.argv.slice(2);
	const val = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
	if (argv.some((a) => /^--takeover/.test(a))) {
		console.error('cleanup: takeover is not a flag. The machine owner sets DF_TAKEOVER=1 in <state>/.env.local (or the shell that starts a run)');
		process.exit(1);
	}
	if (argv.includes('--restore')) {
		console.log(JSON.stringify(restore({ dryRun: argv.includes('--dry-run') }), null, 2));
		process.exit(0);
	}
	let cfg;
	try {
		cfg = load();
	} catch (e) {
		console.error(`cleanup: ${e.message}`);
		process.exit(1);
	}
	const worktree = val('worktree') ? path.resolve(val('worktree')) : undefined;
	const ports = (val('ports') ?? '').split(',').filter(Boolean);
	cleanup({ worktree, takeover: takeoverOn(), ports, dryRun: argv.includes('--dry-run'), cfg })
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error(`cleanup: ${e.message}`);
			process.exit(1);
		});
}
