import './isolate-state.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { noDockerBin } from './no-docker.mjs';
import { defaultRun } from '../scripts/cleanup.mjs';

// The factory is live on the machine that runs the suite: a test must never reach the real docker, whatever it runs.

test('docker on the PATH of a test is the fake', () => {
	const r = spawnSync('docker', ['ps'], { encoding: 'utf8' });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /Cannot connect to the Docker daemon/);
});

test('a script a test runs sees the fake too', () => {
	const r = spawnSync('bash', ['-c', 'command -v docker'], { encoding: 'utf8' });
	assert.ok(r.stdout.trim().startsWith(noDockerBin()), r.stdout);
});

test('the default runner of cleanup reaches the fake', () => {
	assert.equal(defaultRun('docker', ['ps']).status, 1);
});
