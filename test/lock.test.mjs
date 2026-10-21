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

test('a free lock is taken and released, and release also forgets the pointer', () => {
	const { state, log } = dirs();
	fs.writeFileSync(path.join(state, 'active-run.json'), '{}');
	assert.equal(sh(`df_lock_acquire ${state} ${log} pass; test -d ${state}/tick.lock && df_lock_release ${state}`).status, 0);
	assert.equal(fs.existsSync(path.join(state, 'tick.lock')), false);
	assert.equal(fs.existsSync(path.join(state, 'active-run.json')), false);
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
