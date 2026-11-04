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
