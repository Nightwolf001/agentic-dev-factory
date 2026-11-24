import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const LOCK = new URL('../scripts/lock.sh', import.meta.url).pathname;
const sh = (script) => spawnSync('bash', ['-c', `. ${LOCK}; ${script}`], { encoding: 'utf8' });

function dirs() {
	const state = fs.mkdtempSync(path.join(os.tmpdir(), 'df-lock-'));
	return { state, log: path.join(state, 'log') };
}

// Interactive builds share the state folder and take no lock, so a pass never removes the agent bindings: a live interactive agent
// would lose its own. A binding goes with a role write, the stop gate or its age (scripts/run-context.mjs).
test('a free lock is taken and released, and release forgets the pointer but keeps every agent binding', () => {
	const { state, log } = dirs();
	fs.writeFileSync(path.join(state, 'active-run.json'), '{}');
	fs.mkdirSync(path.join(state, 'agents'));
	fs.writeFileSync(path.join(state, 'agents', 'x.json'), '{}');
	assert.equal(sh(`df_lock_acquire ${state} ${log} pass; test -d ${state}/tick.lock && df_lock_release ${state}`).status, 0);
	assert.equal(fs.existsSync(path.join(state, 'tick.lock')), false);
	assert.equal(fs.existsSync(path.join(state, 'active-run.json')), false);
	assert.equal(fs.readFileSync(path.join(state, 'agents', 'x.json'), 'utf8'), '{}');
});

test('a pass and an improve pass forget the pointer and leave the agent bindings alone', () => {
	for (const f of ['tick.sh', 'improve.sh', 'lock.sh']) {
		const text = fs.readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
		if (f !== 'lock.sh') assert.match(text, /rm -f "\$STATE\/active-run\.json"/, f);
		assert.doesNotMatch(text, /\/agents\b/, f);
	}
});

test('a lock left by a dead pass is recovered (the improve pass used to be blocked forever)', () => {
	const { state, log } = dirs();
	fs.mkdirSync(path.join(state, 'tick.lock'));
	fs.writeFileSync(path.join(state, 'tick.lock/pid'), '99999999');
	fs.writeFileSync(path.join(state, 'tick.lock/started'), 'Mon Jan  1 00:00:00 2001');
	assert.equal(sh(`df_lock_acquire ${state} ${log} improve`).status, 0);
});

test('a lock whose pid was recycled by another process is not a live holder', () => {
	const { state, log } = dirs();
	const sleeper = spawn('sleep', ['30']);
	fs.mkdirSync(path.join(state, 'tick.lock'));
	fs.writeFileSync(path.join(state, 'tick.lock/pid'), String(sleeper.pid));
	fs.writeFileSync(path.join(state, 'tick.lock/started'), 'not the real start time');
	const r = sh(`df_lock_acquire ${state} ${log} pass`);
	sleeper.kill();
	assert.equal(r.status, 0);
});

test('a live holder with the matching start time keeps the lock and one line is logged', () => {
	const { state, log } = dirs();
	const sleeper = spawn('sleep', ['30']);
	const started = spawnSync('ps', ['-o', 'lstart=', '-p', String(sleeper.pid)], { encoding: 'utf8' }).stdout.trim();
	fs.mkdirSync(path.join(state, 'tick.lock'));
	fs.writeFileSync(path.join(state, 'tick.lock/pid'), String(sleeper.pid));
	fs.writeFileSync(path.join(state, 'tick.lock/started'), started);
	const r = sh(`df_lock_acquire ${state} ${log} improve`);
	sleeper.kill();
	assert.equal(r.status, 75);
	assert.match(fs.readFileSync(log, 'utf8'), /improve skip: pass \d+ still running/);
});

const acquire = (state, log, holdSeconds) =>
	new Promise((resolve) => {
		const p = spawn('bash', [
			'-c',
			`. ${LOCK}; df_lock_acquire ${state} ${log} pass && { echo got >> ${state}/winners; sleep ${holdSeconds}; df_lock_release ${state}; }`,
		]);
		p.on('exit', (code) => resolve(code));
	});
const winners = (state) =>
	fs.existsSync(path.join(state, 'winners')) ? fs.readFileSync(path.join(state, 'winners'), 'utf8').trim().split('\n').length : 0;

test('a process that arrives between mkdir and the pid write sees a lock being taken, not a stale one', async () => {
	const { state, log } = dirs();
	const sleeper = spawn('sleep', ['30']);
	fs.mkdirSync(path.join(state, 'tick.lock'));
	const arrival = acquire(state, log, 0);
	await new Promise((r) => setTimeout(r, 500));
	const started = spawnSync('ps', ['-o', 'lstart=', '-p', String(sleeper.pid)], { encoding: 'utf8' }).stdout.trim();
	fs.writeFileSync(path.join(state, 'tick.lock/started'), started);
	fs.writeFileSync(path.join(state, 'tick.lock/pid'), String(sleeper.pid));
	const code = await arrival;
	sleeper.kill();
	assert.equal(code, 75, 'the second pass skips instead of stealing the lock');
	assert.equal(fs.existsSync(path.join(state, 'tick.lock/pid')), true, 'the winner keeps its lock');
});

test('a lock directory its owner never filled in is recovered once it is old enough', async () => {
	const { state, log } = dirs();
	const lock = path.join(state, 'tick.lock');
	fs.mkdirSync(lock);
	const old = new Date(Date.now() - 60_000);
	fs.utimesSync(lock, old, old);
	assert.equal(await acquire(state, log, 0), 0);
});

test('eight passes racing for a free lock: exactly one wins, every round', async () => {
	for (let round = 0; round < 6; round++) {
		const { state, log } = dirs();
		const codes = await Promise.all(Array.from({ length: 8 }, () => acquire(state, log, 1)));
		assert.equal(winners(state), 1, `round ${round}: winners`);
		assert.equal(codes.filter((c) => c === 0).length, 1);
		assert.equal(codes.filter((c) => c === 75).length, 7);
	}
});

test('eight passes racing to reclaim the same dead lock: exactly one wins, every round', async () => {
	for (let round = 0; round < 6; round++) {
		const { state, log } = dirs();
		fs.mkdirSync(path.join(state, 'tick.lock'));
		fs.writeFileSync(path.join(state, 'tick.lock/pid'), '99999999');
		fs.writeFileSync(path.join(state, 'tick.lock/started'), 'Mon Jan  1 00:00:00 2001');
		const codes = await Promise.all(Array.from({ length: 8 }, () => acquire(state, log, 1)));
		assert.equal(winners(state), 1, `round ${round}: winners`);
		assert.equal(codes.filter((c) => c === 0).length, 1);
	}
});

// Two repositories on one machine build at the same time: each pass takes the lock in its repository's own state folder, so a pass
// running in one never makes another repository's pass skip.
test("a pass running in one repository does not hold back a pass in another: each takes its own repository's lock", () => {
	const TICK = new URL('../scripts/tick.sh', import.meta.url).pathname;
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-two-repos-')));
	const repos = ['app-a', 'app-b'].map((n) => path.join(home, n));
	for (const r of repos) {
		fs.mkdirSync(r);
		spawnSync('git', ['init', '-q'], { cwd: r });
	}
	const env = { PATH: process.env.PATH, HOME: home, DF_LOG: path.join(home, 'tick.log'), DF_PREFLIGHT: 'off' };
	const stateOf = (r) =>
		spawnSync('bash', ['-c', `DIR="${path.dirname(path.dirname(TICK))}"; . "$DIR/scripts/runtime.sh"; df_state_dir`], {
			encoding: 'utf8',
			cwd: r,
			env,
		}).stdout;
	const [a, b] = repos.map(stateOf);
	assert.notEqual(a, b);
	// repository A's pass is running: its lock is held by a live process
	fs.mkdirSync(path.join(a, 'tick.lock'), { recursive: true });
	fs.writeFileSync(
		path.join(a, 'tick.lock', 'started'),
		String(spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout ?? '').trim(),
	);
	fs.writeFileSync(path.join(a, 'tick.lock', 'pid'), String(process.pid));
	const r = spawnSync('bash', [TICK], { encoding: 'utf8', cwd: repos[1], env, timeout: 60000 });
	const log = fs.readFileSync(env.DF_LOG, 'utf8');
	assert.notEqual(r.status, 75, log);
	assert.doesNotMatch(log, /skip: pass/);
	assert.match(log, /pass start/, "B's pass got past the lock");
	assert.equal(fs.existsSync(path.join(home, '.dev-factory', 'tick.lock')), false, 'no lock in the machine folder');
	assert.equal(fs.existsSync(path.join(b, 'tick.lock')), false, "B's own lock was released when its pass ended");
	assert.ok(fs.existsSync(path.join(a, 'tick.lock', 'pid')), "A's lock is untouched");
});

// A job rendered by an install before 0.26.0 names the machine folder in DF_STATE_DIR. Honoured, that pin would put every such
// repository's lock in one shared folder again, so a pass started that way takes its repository's own lock.
test("a job that pins DF_STATE_DIR to the machine folder still takes its repository's own lock", () => {
	const TICK = new URL('../scripts/tick.sh', import.meta.url).pathname;
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-old-job-')));
	const repo = path.join(home, 'app');
	fs.mkdirSync(repo);
	spawnSync('git', ['init', '-q'], { cwd: repo });
	const machine = path.join(home, '.dev-factory');
	fs.mkdirSync(machine, { recursive: true });
	// another repository's pass holds the machine folder's lock, as a pass of an old install would
	fs.mkdirSync(path.join(machine, 'tick.lock'));
	fs.writeFileSync(path.join(machine, 'tick.lock', 'started'), 'x');
	fs.writeFileSync(path.join(machine, 'tick.lock', 'pid'), String(process.pid));
	const env = { PATH: process.env.PATH, HOME: home, DF_LOG: path.join(home, 'tick.log'), DF_PREFLIGHT: 'off', DF_STATE_DIR: machine };
	spawnSync('bash', [TICK], { encoding: 'utf8', cwd: repo, env, timeout: 60000 });
	const log = fs.readFileSync(env.DF_LOG, 'utf8');
	assert.doesNotMatch(log, /skip: pass/, 'not held back by the machine folder lock');
	assert.match(log, /pass start/);
	const own = fs.readdirSync(machine).filter((f) => f.startsWith('app-'));
	assert.equal(own.length, 1, 'the repository got its own folder');
	// an explicit folder that is not the machine folder is still used as given
	const custom = path.join(home, 'custom-state');
	spawnSync('bash', [TICK], { encoding: 'utf8', cwd: repo, env: { ...env, DF_STATE_DIR: custom }, timeout: 60000 });
	assert.ok(fs.existsSync(custom), 'DF_STATE_DIR elsewhere is kept');
});
