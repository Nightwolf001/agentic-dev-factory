import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const PLUGIN = path.resolve(import.meta.dirname, '..');
const loaded = (dir, state, name) =>
	spawnSync('bash', ['-c', `DIR="${dir}"; . "${PLUGIN}/scripts/runtime.sh"; df_load_env; printf '%s' "\${${name}:-unset}"`], {
		encoding: 'utf8',
		env: { ...process.env, DF_STATE_DIR: state, LEAK: '' },
	}).stdout;

test('secrets come from the state folder only, never from a file inside the plugin directory', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-plugin-'));
	const state = fs.mkdtempSync(path.join(os.tmpdir(), 'df-state-'));
	fs.writeFileSync(path.join(dir, '.env.local'), 'PLANTED=from-plugin\nLEAK=from-plugin\n');
	assert.equal(loaded(dir, state, 'PLANTED'), 'unset', 'a run in a clone of the plugin could write this file');
	fs.writeFileSync(path.join(state, '.env.local'), 'OWNER_TOKEN=from-state\n');
	assert.equal(loaded(dir, state, 'OWNER_TOKEN'), 'from-state');
	assert.equal(loaded(dir, state, 'PLANTED'), 'unset');
});

test('the tick interval from the environment is a whole number of minutes from 1 to 1440; anything else is the default', () => {
	const interval = (value) =>
		spawnSync('bash', ['-c', `DIR="${PLUGIN}"; . "${PLUGIN}/scripts/runtime.sh"; df_interval_minutes`], {
			encoding: 'utf8',
			env: { ...process.env, DF_SCHEDULER_INTERVAL_MINUTES: value, DF_CONFIG: '/nonexistent' },
		}).stdout;
	assert.equal(interval('5'), '5');
	assert.equal(interval('08'), '8', 'a leading zero is not octal (it was an arithmetic error in the installer)');
	assert.equal(interval('0010'), '10');
	assert.equal(interval('1440'), '1440');
	for (const bad of ['0', '00', '1441', '99999', '-3', 'abc', '5m', '2.5', '']) assert.equal(interval(bad), '5', JSON.stringify(bad));
	const install = fs.readFileSync(path.join(PLUGIN, 'scripts/install.sh'), 'utf8');
	assert.match(install, /\$\(\(INTERVAL \* 60\)\)/, 'and the installer does arithmetic with the checked value');
});
