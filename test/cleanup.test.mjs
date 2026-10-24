import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cleanup, lineage, listeners, portsFor, processes, protectedReason, stopProcess } from '../scripts/cleanup.mjs';
import { load, merge, validate } from '../scripts/config.mjs';
import { takeoverOn } from '../scripts/takeover.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'df-cleanup-'));

// A scripted machine: `ps` rows, `lsof` listeners, docker containers; every other command is recorded.
function machine({ ps = [], ports = {}, containers = {}, alive = [] } = {}) {
	const calls = [];
	const run = (cmd, args) => {
		calls.push([cmd, ...args]);
		if (cmd === 'ps') return { status: 0, stdout: ps.map((p) => `${p.pid} ${p.ppid} ${p.command}`).join('\n'), stderr: '' };
		if (cmd === 'lsof') {
			const port = /TCP:(\d+)/.exec(args.join(' '))[1];
			return { status: 0, stdout: (ports[port] ?? []).map((h) => `p${h.pid}\nc${h.name}`).join('\n'), stderr: '' };
		}
		if (cmd === 'docker' && args[0] === 'ps') {
			const port = /publish=(\d+)/.exec(args.join(' '))[1];
			return { status: 0, stdout: (containers[port] ?? []).map((c) => `${c.id}\t${c.name}\t`).join('\n'), stderr: '' };
		}
		if (cmd === 'kill' && args[0] === '-0') return { status: alive.includes(Number(args[1])) ? 0 : 1, stdout: '', stderr: '' };
		return { status: 0, stdout: '', stderr: '' };
	};
	const stopped = [];
	const stop = async (pid) => (stopped.push(pid), 'stopped');
	return { run, calls, stop, stopped };
}
const noWorktreeState = () => ({ state: tmp(), cfg: load() });

test('processes and lineage read ps rows and walk up to the session', () => {
	const m = machine({
		ps: [
			{ pid: 10, ppid: 1, command: '/bin/zsh -l' },
			{ pid: 20, ppid: 10, command: 'claude --resume' },
			{ pid: 30, ppid: 20, command: 'node cleanup.mjs' },
		],
	});
	const procs = processes(m.run);
	assert.equal(procs.length, 3);
	assert.deepEqual([...lineage(procs, 30)].sort(), [10, 20, 30]);
});

test('protected programs are never stopped: shells, Claude, terminals, system services, the session itself', () => {
	const keep = new Set([77]);
	const why = (command, pid = 500) => protectedReason({ pid, command }, keep);
	for (const c of [
		'-zsh',
		'/bin/bash -c x',
		'/usr/local/bin/claude --x',
		'/Applications/Claude.app/Contents/MacOS/Claude',
		'/System/Library/CoreServices/Finder.app/x',
		'/usr/libexec/launchd',
		'/usr/bin/tmux new',
		'login -pf me',
	])
		assert.ok(why(c), c);
	assert.ok(why('node server.js', 77), 'a parent of the session');
	assert.ok(why('anything', 1), 'pid 1');
	assert.equal(why('node server.js'), null);
	assert.equal(why('/usr/local/bin/node /app/node_modules/.bin/next dev'), null);
});

test('listeners parses lsof field output', () => {
	const m = machine({ ports: { 3000: [{ pid: 4242, name: 'node' }] } });
	assert.deepEqual(listeners(3000, m.run), [{ pid: 4242, name: 'node' }]);
	assert.deepEqual(listeners(3001, m.run), []);
});

test('portsFor collects the config ports, Metro (only with an app), the web address and the compose ports', () => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, 'compose.yml'), 'services: {}\n');
	const cfg = merge(load(), {
		cleanup: { ports: [9229] },
		mobile: { appDir: 'app', metroPort: 8089 },
		environment: { type: 'compose', composeFile: 'compose.yml', webBaseUrl: 'http://localhost:3000' },
	});
	const run = (cmd, args) => ({
		status: 0,
		stderr: '',
		stdout: args.includes('config') ? JSON.stringify({ services: { web: { ports: [{ published: 3000 }, '1337:1337'] } } }) : '',
	});
	assert.deepEqual(
		portsFor({ cfg, worktree: dir, extra: [5555], run }).sort((a, b) => a - b),
		[1337, 3000, 5555, 8089, 9229],
	);
	assert.deepEqual(portsFor({ cfg: load(), worktree: dir, run }), [], 'nothing configured, nothing to free');
});

test('stopProcess terms, waits, then kills what is still alive', async () => {
	const sent = [];
	const run = (c, a) => (sent.push(a.join(' ')), { status: 0, stdout: '', stderr: '' });
	assert.equal(await stopProcess(5, { run, wait: 250, alive: () => false }), 'stopped');
	assert.deepEqual(sent, ['-TERM 5']);
	sent.length = 0;
	assert.equal(await stopProcess(6, { run, wait: 250, alive: () => true }), 'killed');
	assert.deepEqual(sent, ['-TERM 6', '-KILL 6']);
});

test('without takeover the run tears down only its own and reports what else holds a port', async () => {
	const m = machine({
		ps: [{ pid: 900, ppid: 1, command: 'node dev.js' }],
		ports: { 3000: [{ pid: 900, name: 'node' }] },
		containers: { 3000: [{ id: 'abc', name: 'mine-db' }] },
	});
	const { state } = noWorktreeState();
	const r = await cleanup({ takeover: false, ports: [3000], run: m.run, stop: m.stop, state, cfg: load() });
	assert.deepEqual(m.stopped, []);
	assert.ok(!m.calls.some((c) => c[0] === 'docker' && c[1] === 'stop'));
	const held = r.left.find((l) => l.what === 'port');
	assert.match(held.why, /container mine-db/);
	assert.match(held.why, /cleanup\.takeover/);
});

test('with takeover it stops the container and the process on the port, never a protected one', async () => {
	const m = machine({
		ps: [
			{ pid: 900, ppid: 1, command: 'node dev.js' },
			{ pid: 901, ppid: 1, command: '/bin/zsh' },
			{ pid: 902, ppid: 1, command: 'com.docker.backend proxy' },
		],
		ports: {
			3000: [
				{ pid: 900, name: 'node' },
				{ pid: 902, name: 'com.docker.backend' },
			],
			4000: [{ pid: 901, name: 'zsh' }],
		},
		containers: { 3000: [{ id: 'abc', name: 'old-web' }] },
	});
	const { state } = noWorktreeState();
	const r = await cleanup({ takeover: true, ports: [3000, 4000], run: m.run, stop: m.stop, state, cfg: load() });
	assert.deepEqual(m.stopped, [900], 'the node server only: the docker proxy goes with its container, the shell is protected');
	assert.ok(m.calls.some((c) => c.join(' ') === 'docker stop abc'));
	assert.match(r.left.find((l) => l.target === '4000').why, /Claude, a shell/);
});

test('dry run changes nothing and says what it would do', async () => {
	const m = machine({ ps: [{ pid: 900, ppid: 1, command: 'node dev.js' }], ports: { 3000: [{ pid: 900, name: 'node' }] } });
	const { state } = noWorktreeState();
	const r = await cleanup({ takeover: true, dryRun: true, ports: [3000], run: m.run, stop: m.stop, state, cfg: load() });
	assert.deepEqual(m.stopped, []);
	assert.ok(r.done.every((d) => d.result === 'would run'));
	assert.ok(r.done.some((d) => d.what === 'process stop'));
});

test('browser and Maestro sessions: reported by default, stopped with takeover, MCP servers kept', async () => {
	const ps = [
		{ pid: 601, ppid: 1, command: '/x/ms-playwright/chromium-1/chrome --user-data-dir=/tmp/playwright_chromiumdev_profile-abc' },
		{ pid: 602, ppid: 1, command: 'node /x/@playwright/mcp/cli.js' },
		{ pid: 603, ppid: 1, command: 'java -jar maestro-driver-ios.jar' },
		{ pid: 604, ppid: 1, command: 'maestro mcp' },
	];
	const { state } = noWorktreeState();
	const off = machine({ ps });
	const r0 = await cleanup({ takeover: false, run: off.run, stop: off.stop, state, cfg: load() });
	assert.deepEqual(off.stopped, []);
	assert.match(r0.left.find((l) => l.what === 'browser or Maestro sessions').target, /2 process/);
	const on = machine({ ps });
	await cleanup({ takeover: true, run: on.run, stop: on.stop, state, cfg: load() });
	assert.deepEqual(on.stopped.sort(), [601, 603]);
});

test('its own scope: the recorded stack is brought down, a simulator only when the run booted it', async () => {
	const wt = tmp();
	fs.mkdirSync(path.join(wt, '.dev-factory'));
	fs.writeFileSync(
		path.join(wt, '.dev-factory', 'env.json'),
		JSON.stringify({ project: 'df-app-1', device: { udid: 'U-1', bootedByFactory: true } }),
	);
	const { state } = noWorktreeState();
	const m = machine();
	const r = await cleanup({ worktree: wt, run: m.run, stop: m.stop, state, cfg: load() });
	assert.ok(m.calls.some((c) => c[0] === 'bash' && c.includes('down') && c[1].endsWith('e2e-env.sh')));
	assert.ok(m.calls.some((c) => c.join(' ') === 'xcrun simctl shutdown U-1'));
	assert.ok(r.done.some((d) => d.what === 'compose project down'));

	fs.writeFileSync(
		path.join(wt, '.dev-factory', 'env.json'),
		JSON.stringify({ project: 'df-app-1', device: { udid: 'U-2', bootedByFactory: false } }),
	);
	const m2 = machine();
	const r2 = await cleanup({ worktree: wt, run: m2.run, stop: m2.stop, state, cfg: load() });
	assert.ok(!m2.calls.some((c) => c[0] === 'xcrun'), 'a simulator that was already running stays up');
	assert.match(r2.left.find((l) => l.what === 'simulator').why, /already running/);
	const m3 = machine();
	await cleanup({ worktree: wt, takeover: true, run: m3.run, stop: m3.stop, state, cfg: load() });
	assert.ok(m3.calls.some((c) => c.join(' ') === 'xcrun simctl shutdown U-2'));
});

test('the ports lock goes when its owner is gone, stays while the owner runs, goes with takeover', async () => {
	const lockOf = (owner) => {
		const state = tmp();
		fs.mkdirSync(path.join(state, 'ports.lock'));
		fs.writeFileSync(path.join(state, 'ports.lock', 'owner'), String(owner));
		return state;
	};
	const dead = lockOf(321);
	await cleanup({ run: machine({ alive: [] }).run, state: dead, cfg: load() });
	assert.equal(fs.existsSync(path.join(dead, 'ports.lock')), false);
	const live = lockOf(322);
	const r = await cleanup({ run: machine({ alive: [322] }).run, state: live, cfg: load() });
	assert.equal(fs.existsSync(path.join(live, 'ports.lock')), true);
	assert.match(r.left.find((l) => l.what === 'ports lock').why, /pid 322/);
	await cleanup({ takeover: true, run: machine({ alive: [322] }).run, state: live, cfg: load() });
	assert.equal(fs.existsSync(path.join(live, 'ports.lock')), false);
});

test('a real process holding a port is left by default and stopped with takeover', async () => {
	const child = spawn(
		process.execPath,
		['-e', "require('net').createServer().listen(0,'127.0.0.1',function(){console.log(this.address().port)});setInterval(()=>{},1000)"],
		{ stdio: ['ignore', 'pipe', 'ignore'] },
	);
	try {
		const port = await new Promise((res) => child.stdout.once('data', (d) => res(Number(String(d).trim()))));
		const { state, cfg } = noWorktreeState();
		const left = await cleanup({ takeover: false, ports: [port], state, cfg });
		assert.ok(
			left.left.some((l) => l.target === String(port)),
			JSON.stringify(left),
		);
		assert.equal(child.exitCode, null, 'still running');
		const taken = await cleanup({ takeover: true, ports: [port], state, cfg });
		assert.ok(
			taken.done.some((d) => d.what === 'process stop' && d.target.includes(`port ${port}`)),
			JSON.stringify(taken),
		);
		await new Promise((res) => (child.exitCode !== null || child.signalCode ? res() : child.once('exit', res)));
		assert.ok(child.exitCode !== null || child.signalCode);
		await new Promise((res, rej) =>
			net
				.createServer()
				.once('error', rej)
				.listen(port, '127.0.0.1', function () {
					this.close(res);
				}),
		);
	} finally {
		child.kill('SIGKILL');
	}
});

test('cleanup settings are validated and the toggle reads the config and DF_TAKEOVER', () => {
	assert.equal(load().cleanup.takeover, false);
	assert.deepEqual(load().cleanup.ports, []);
	assert.deepEqual(validate(merge(load(), { cleanup: { takeover: true, ports: [3000] } })), []);
	assert.match(validate(merge(load(), { cleanup: { takeover: 'yes' } })).join('\n'), /cleanup\.takeover must be true or false/);
	assert.match(validate(merge(load(), { cleanup: { ports: ['x'] } })).join('\n'), /cleanup\.ports must be a list of port numbers/);
	assert.equal(takeoverOn({ cfg: load(), env: {} }), false);
	assert.equal(takeoverOn({ cfg: merge(load(), { cleanup: { takeover: true } }), env: {} }), true);
	assert.equal(takeoverOn({ cfg: load(), env: { DF_TAKEOVER: '1' } }), true);
	assert.equal(takeoverOn({ cfg: merge(load(), { cleanup: { takeover: true } }), env: { DF_TAKEOVER: '0' } }), false);
});
