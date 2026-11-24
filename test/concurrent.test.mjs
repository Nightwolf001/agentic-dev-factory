import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkAll, handedOff, parseFor, waitAny } from '../scripts/handoff.mjs';
import { parseTarget } from '../scripts/port-proxy.mjs';
import { engineNamesContainers, portsMode } from '../scripts/ports-mode.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfg = (environment = {}, caps = {}) => ({
	environment: { ports: 'auto', webBaseUrl: null, ...environment },
	caps: { maxConcurrent: 1, ...caps },
});
const env = {};

// ---- which ports a task's stack starts with ----

test('auto: direct wherever the engine names containers, so tasks of this repository and others never wait on the ports lock', () => {
	const web = { webBaseUrl: 'http://localhost:3000' };
	const orb = () => true;
	const other = () => false;
	assert.equal(portsMode({ cfg: cfg(web), namesContainers: orb }), 'direct', 'even one task at a time');
	assert.equal(portsMode({ cfg: cfg(web), device: true, namesContainers: orb }), 'direct', 'a device task too');
	assert.equal(portsMode({ cfg: cfg(web), namesContainers: other }), 'canonical', 'an engine without names keeps canonical ports');
	assert.equal(
		portsMode({ cfg: cfg(web, { maxConcurrent: 3 }), device: true, namesContainers: other }),
		'direct',
		'above 1 the person chose concurrency',
	);
	assert.equal(portsMode({ cfg: cfg({}, { maxConcurrent: 3 }), namesContainers: orb }), 'none', 'no address to open');
	assert.equal(
		portsMode({ cfg: cfg({}, { maxConcurrent: 3 }), device: true, namesContainers: orb }),
		'canonical',
		'a device always needs the backend',
	);
	assert.equal(portsMode({ cfg: cfg({}), namesContainers: orb }), 'canonical');
});

test('environment.ports set by hand wins, and none is never used for a device task', () => {
	const web = { webBaseUrl: 'http://localhost:3000' };
	assert.equal(portsMode({ cfg: cfg({ ...web, ports: 'canonical' }), namesContainers: () => true }), 'canonical');
	assert.equal(portsMode({ cfg: cfg({ ports: 'direct' }), namesContainers: () => false }), 'direct');
	assert.equal(portsMode({ cfg: cfg({ ports: 'none' }) }), 'none');
	assert.equal(portsMode({ cfg: cfg({ ports: 'none' }), device: true }), 'canonical');
});

test("the engine is OrbStack when the Docker client's context says so, else when docker info does", () => {
	const none = () => {
		throw new Error('no file');
	};
	const info =
		(out, status = 0) =>
		() => ({ status, stdout: out });
	assert.equal(engineNamesContainers(info('Docker Desktop'), { DOCKER_CONTEXT: 'orbstack' }, none), true);
	assert.equal(engineNamesContainers(info('OrbStack'), { DOCKER_CONTEXT: 'desktop-linux' }, none), false, 'the context wins');
	assert.equal(
		engineNamesContainers(info(''), { HOME: '/h' }, () => '{"currentContext":"orbstack"}'),
		true,
	);
	assert.equal(engineNamesContainers(info('OrbStack\n'), { HOME: '/h' }, none), true);
	assert.equal(
		engineNamesContainers(info('Docker Desktop\n'), { HOME: '/h' }, () => '{}'),
		false,
	);
	assert.equal(engineNamesContainers(info('', 1), { HOME: '/h' }, none), false);
});

test('environment.ports is validated', () => {
	const r = spawnSync('node', [path.join(ROOT, 'scripts/config.mjs'), 'validate'], {
		encoding: 'utf8',
		cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'df-ports-')),
		env: { ...process.env, DF_CONFIG: writeConfig({ environment: { ports: 'sometimes' } }) },
	});
	assert.equal(r.status, 1);
	assert.match(r.stdout + r.stderr, /environment\.ports must be auto, canonical, direct or none/);
});

function writeConfig(c) {
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'df-cfg-')), 'config.json');
	fs.writeFileSync(f, JSON.stringify(c));
	return f;
}

// ---- one wait for every task in flight ----

function worktree() {
	const w = fs.mkdtempSync(path.join(os.tmpdir(), 'df-handoff-'));
	fs.mkdirSync(path.join(w, '.dev-factory', 'review'), { recursive: true });
	fs.mkdirSync(path.join(w, '.dev-factory', 'debug'), { recursive: true });
	return w;
}
const put = (w, f, text = '{}') => {
	fs.mkdirSync(path.dirname(path.join(w, f)), { recursive: true });
	fs.writeFileSync(path.join(w, f), text);
};

test('--for takes a worktree and a phase it knows; anything else is refused', () => {
	assert.deepEqual(parseFor('/w/TASK-1=build'), { worktree: '/w/TASK-1', phase: 'build' });
	assert.equal(parseFor('/w/TASK-1=review:spec').phase, 'review:spec');
	assert.equal(parseFor('/w/TASK-1=debug:2').phase, 'debug:2');
	assert.equal(parseFor('/w/TASK-1=research:TASK-1').phase, 'research:TASK-1');
	for (const bad of ['/w/TASK-1', '=build', '/w=deploy', '/w=review:', '/w=debug:x', '/w=research:$(x)']) assert.equal(parseFor(bad), null, bad);
});

test('each phase ends on its own file, a build only once build-ready accepts it, and a block always wins', () => {
	const w = worktree();
	const ready = { ready: () => true, headOf: () => 'abc' };
	assert.equal(handedOff({ worktree: w, phase: 'build' }, ready), null);
	put(w, '.dev-factory/build.done');
	assert.equal(handedOff({ worktree: w, phase: 'build' }, { ...ready, ready: () => false }), null, 'build-ready refuses it: not a hand-off');
	assert.equal(handedOff({ worktree: w, phase: 'build' }, ready), 'done');
	put(w, '.dev-factory/needs_debug.json');
	assert.equal(handedOff({ worktree: w, phase: 'build' }, ready), 'needs_debug');
	assert.equal(handedOff({ worktree: w, phase: 'review:spec' }, ready), null);
	put(w, '.dev-factory/review/abc-spec.json');
	assert.equal(handedOff({ worktree: w, phase: 'review:spec' }, ready), 'done');
	assert.equal(handedOff({ worktree: w, phase: 'review:standards' }, ready), null);
	assert.equal(
		handedOff({ worktree: w, phase: 'review:spec' }, { ...ready, headOf: () => 'def' }),
		null,
		'a review of an older commit does not count',
	);
	put(w, '.dev-factory/debug/1.json', '{"status": "recorded"}');
	assert.equal(handedOff({ worktree: w, phase: 'debug:1' }, ready), null);
	assert.equal(handedOff({ worktree: w, phase: 'debug:0' }, ready), 'done');
	assert.equal(handedOff({ worktree: w, phase: 'ship' }, ready), null);
	put(w, '.dev-factory/ship.done');
	assert.equal(handedOff({ worktree: w, phase: 'ship' }, ready), 'done');
	put(w, 'docs/plans/TASK-1/research.md', '# notes');
	assert.equal(handedOff({ worktree: w, phase: 'research:TASK-1' }, ready), 'done');
	put(w, '.dev-factory/blocked.json');
	for (const phase of ['build', 'ship', 'review:spec', 'debug:9', 'research:TASK-1'])
		assert.equal(handedOff({ worktree: w, phase }, ready), 'blocked', phase);
});

test('the wait ends as soon as any task hands off and names only those that did', async () => {
	const a = worktree();
	const b = worktree();
	const opts = { ready: () => true, headOf: () => 'abc', interval: 0.01, seconds: 5 };
	let slept = 0;
	const sleep = async () => {
		if (++slept === 3) put(b, '.dev-factory/ship.done');
	};
	const out = await waitAny(
		[
			{ worktree: a, phase: 'build' },
			{ worktree: b, phase: 'ship' },
		],
		{ ...opts, sleep },
	);
	assert.deepEqual(out, [{ worktree: b, phase: 'ship', result: 'done' }]);
	assert.equal(slept, 3);
	assert.deepEqual(await waitAny([{ worktree: a, phase: 'build' }], { ...opts, seconds: 0, sleep }), [], 'nothing within the time');
	assert.deepEqual(checkAll([{ worktree: a, phase: 'ship' }], opts), []);
});

test('the CLI prints one JSON line per hand-off, or STILL_WAITING with exit 10', () => {
	const a = worktree();
	const run = (...args) =>
		spawnSync('node', [path.join(ROOT, 'scripts/handoff.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
	const none = run('check', '--for', `${a}=ship`);
	assert.equal(none.status, 10);
	assert.equal(none.stdout.trim(), 'STILL_WAITING');
	put(a, '.dev-factory/ship.done');
	const one = run('wait', '--for', `${a}=ship`, '--seconds', '1', '--interval', '1');
	assert.equal(one.status, 0, one.stderr);
	assert.deepEqual(JSON.parse(one.stdout), { worktree: a, phase: 'ship', result: 'done' });
	assert.equal(run('wait', '--for', `${a}=deploy`).status, 3);
	assert.equal(run('wait').status, 3);
});

// ---- the proxy to a task's container port ----

test('the proxy forwards only to a plain host and port', () => {
	assert.deepEqual(parseTarget('192.168.97.2:1337'), { host: '192.168.97.2', port: 1337 });
	assert.deepEqual(parseTarget('api.df-a.orb.local:80'), { host: 'api.df-a.orb.local', port: 80 });
	for (const bad of ['192.168.97.2', ':1337', 'h:0', 'h:70000', 'h:1;rm', '$(x):1', 'a b:1']) assert.equal(parseTarget(bad), null, bad);
	const r = spawnSync('node', [path.join(ROOT, 'scripts/port-proxy.mjs'), '--to', 'x'], { encoding: 'utf8' });
	assert.equal(r.status, 3);
});

// ---- the sandbox lets the scheduler's own scripts out when their path is quoted ----

test('every script the sandbox lets out is let out by its quoted path too, the form the commands use', async () => {
	const { withQuotedForms, build } = await import('../scripts/factory-settings.mjs');
	assert.deepEqual(withQuotedForms(['node *open-prs.mjs*', 'git *']), [
		'node *open-prs.mjs*',
		'git *',
		'node "*open-prs.mjs"',
		'node "*open-prs.mjs" *',
	]);
	const { load } = await import('../scripts/config.mjs');
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'df-sb-')), '.mcp.json');
	const ex = build({ cfg: load(), mcpFile: file, want: [] }).sandbox.excludedCommands;
	for (const p of ['node "*open-prs.mjs"', 'node "*automerge.mjs" *', 'bash "*e2e-env.sh" *']) assert.ok(ex.includes(p), p);
});

test("the pass may write in its tasks' worktrees, which live outside the repository", async () => {
	const { build } = await import('../scripts/factory-settings.mjs');
	const { load } = await import('../scripts/config.mjs');
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'df-sb-')), '.mcp.json');
	const allow = build({ cfg: load(), mcpFile: file, want: [], state: '/s', worktreeFolders: ['/r/.worktrees/app', '/r/.worktrees/TASK-1'] }).sandbox
		.filesystem.allowWrite;
	for (const p of ['/s', '/r/.worktrees/app', '/r/.worktrees/TASK-1']) assert.ok(allow.includes(p), p);
});

test("the pass's sandbox reaches the direct stacks' own addresses and lets tests open a local port", async () => {
	const { build } = await import('../scripts/factory-settings.mjs');
	const { load, merge } = await import('../scripts/config.mjs');
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'df-sb-')), '.mcp.json');
	const sb = (environment) => build({ cfg: merge(load(), { environment }), mcpFile: file, want: [], worktreeFolders: [] }).sandbox.network;
	assert.ok(sb({ type: 'compose' }).allowedDomains.includes('*.orb.local'), 'the default {service}.{project}.orb.local');
	assert.ok(sb({ type: 'compose', directHost: 'web.{project}.dev.test' }).allowedDomains.includes('*.dev.test'));
	assert.equal(sb({ type: 'none' }).allowedDomains.includes('*.orb.local'), false, 'no stack, no stack address');
	assert.equal(sb({ type: 'compose' }).allowLocalBinding, true);
});
