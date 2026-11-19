import './isolate-state.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { noDockerBin } from './no-docker.mjs';
import { defaultRun } from '../scripts/cleanup.mjs';

// The factory is live on the machine that runs the suite: a test must never reach the real docker, whatever it runs.

test('docker on the PATH of a test is the fake', () => {
	const r = spawnSync('docker', ['ps'], { encoding: 'utf8' });
	assert.equal(r.status, 1);
	// the marker is the fake's own: a real docker with no daemon prints the same first words, and a failed spawn prints nothing
	assert.match(r.stderr, /fake docker of the test suite/);
});

test('a script a test runs sees the fake too', () => {
	const r = spawnSync('bash', ['-c', 'command -v docker'], { encoding: 'utf8' });
	assert.ok(r.stdout.trim().startsWith(noDockerBin()), r.stdout);
});

test('the default runner of cleanup reaches the fake', () => {
	// defaultRun maps a failed spawn to status 1 as well, so the status alone would not show that the fake answered
	const r = defaultRun('docker', ['ps']);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /fake docker of the test suite/);
});

// A test that starts a process inherits the PATH `isolate-state.mjs` sets up, but only when it imports that file; a new test that
// spawns something without it would reach the machine's real docker unnoticed. So every test file that loads child_process must
// import it as its first import (before anything that could run a command at load time).
test('every test file that can spawn a process imports isolate-state first', () => {
	const dir = path.dirname(fileURLToPath(import.meta.url));
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs'));
	assert.ok(files.length > 10, `scanned only ${files.length} test files`);
	const spawners = [];
	const offenders = [];
	for (const f of files) {
		const src = fs.readFileSync(path.join(dir, f), 'utf8');
		if (!/child_process/.test(src)) continue;
		spawners.push(f);
		// the first import statement, comments aside
		const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		const first = code.match(/^\s*import\b[^;]*;/m);
		if (!first || !/^\s*import\s+['"]\.\/isolate-state\.mjs['"]\s*;/.test(first[0])) offenders.push(f);
	}
	assert.ok(spawners.length > 10, `found only ${spawners.length} test files that load child_process`);
	assert.deepEqual(offenders, [], 'these tests load child_process without importing ./isolate-state.mjs first');
});
