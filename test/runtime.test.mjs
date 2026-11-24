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

// HOME is a temporary folder, so ~/.dev-factory is too
const inRepo = (home, cwd, script, extra = {}) =>
	spawnSync('bash', ['-c', `DIR="${PLUGIN}"; . "${PLUGIN}/scripts/runtime.sh"; ${script}`], {
		encoding: 'utf8',
		cwd,
		env: { PATH: process.env.PATH, HOME: home, ...extra },
	});
const gitRepo = (dir) => {
	fs.mkdirSync(dir, { recursive: true });
	for (const args of [
		['init', '-q'],
		['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'],
	])
		assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
};

test('every repository has a state folder of its own, so two repositories never share a pass lock; a worktree uses its repository', () => {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-home-')));
	const a = path.join(home, 'work', 'app-a');
	const b = path.join(home, 'work', 'app-b');
	gitRepo(a);
	gitRepo(b);
	const stateOf = (cwd) => inRepo(home, cwd, 'df_state_dir').stdout;
	const machine = path.join(home, '.dev-factory');
	assert.equal(path.dirname(stateOf(a)), machine);
	assert.match(path.basename(stateOf(a)), /^app-a-\d+$/);
	assert.notEqual(stateOf(a), stateOf(b));
	const wt = path.join(home, 'work', '.worktrees', 'TASK-1');
	assert.equal(spawnSync('git', ['worktree', 'add', '-q', '-b', 'task/TASK-1', wt], { cwd: a }).status, 0);
	assert.equal(stateOf(wt), stateOf(a), "a worktree's passes and scripts share its repository's folder");
	assert.equal(inRepo(home, home, 'df_state_dir').stdout, machine, 'outside a repository it is the machine folder');
	assert.equal(inRepo(home, a, 'df_state_dir', { DF_STATE_DIR: '/s' }).stdout, '/s', 'an explicit folder wins');
});

test("a repository's own folder links the machine's secrets and launcher, and the secrets load even before it does", () => {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-home-')));
	const repo = path.join(home, 'app');
	gitRepo(repo);
	const machine = path.join(home, '.dev-factory');
	fs.mkdirSync(path.join(machine, 'bin'), { recursive: true });
	fs.writeFileSync(path.join(machine, '.env.local'), 'OWNER_TOKEN=from-machine\n');
	const own = inRepo(home, repo, 'df_state_dir').stdout;
	assert.equal(inRepo(home, repo, 'df_load_env; printf %s "$OWNER_TOKEN"').stdout, 'from-machine', 'no link yet: read from the machine folder');
	assert.equal(inRepo(home, repo, `df_ensure_state_dir "${own}"`).status, 0);
	assert.equal(fs.readlinkSync(path.join(own, '.env.local')), '../.env.local');
	assert.equal(fs.readlinkSync(path.join(own, 'bin')), '../bin');
	assert.equal(fs.existsSync(path.join(own, 'plugin-dir')), false, 'only what the machine has is linked');
	// a pass exports DF_STATE_DIR on its own folder: the machine folder is still the one above it
	assert.equal(inRepo(home, repo, 'df_machine_dir', { DF_STATE_DIR: own }).stdout, machine);
	assert.equal(inRepo(home, repo, 'df_load_env; printf %s "$OWNER_TOKEN"', { DF_STATE_DIR: own }).stdout, 'from-machine');
});
