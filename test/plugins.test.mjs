import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readManaged, writeManaged } from '../scripts/mcp-scope.mjs';
import { applyPlugins, desiredPlugins, planPlugins, pluginCatalog, userKept } from '../scripts/plugins.mjs';

const SCRIPT = new URL('../scripts/plugins.mjs', import.meta.url).pathname;
const SP = 'superpowers@claude-plugins-official';
const FD = 'frontend-design@claude-plugins-official';
const CS = 'code-simplifier@claude-plugins-official';

const L = (user = {}, project = {}) => [
	{ name: 'defaults', file: 'config.json', data: {} },
	{ name: 'user', file: 'u.json', data: user },
	{ name: 'project', file: 'p.json', data: project },
];
const enabled = (map) => ({ plugins: { enabled: map } });
const brief = (list) => list.map((w) => `${w.id}@${w.scope}${w.off ? `:off-${w.off}` : ''}`).sort();
const empty = () => ({ mcp: { user: [], local: {} }, plugins: { user: [], local: {} } });
const entry = (id, scope = 'user', more = {}) => ({ id, scope, enabled: true, ...more });

// A stand-in for `claude` that logs its arguments and where it ran, answers `plugin list --json` with DF_FAKE_LIST,
// and exits 1 for a plugin named in DF_FAKE_FAIL (or, with DF_FAKE_GONE, for every uninstall: not installed).
function fakeClaude() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-fake-claude-'));
	const bin = path.join(dir, 'claude');
	fs.writeFileSync(
		bin,
		`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.DF_FAKE_LOG) fs.appendFileSync(process.env.DF_FAKE_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'plugin' && args[1] === 'list') { console.log(process.env.DF_FAKE_LIST || '[]'); process.exit(0); }
if ((process.env.DF_FAKE_FAIL || '').split(',').includes(args[2])) { console.error('boom ' + args[2]); process.exit(1); }
if (process.env.DF_FAKE_GONE && args[1] === 'uninstall') { console.error('Plugin ' + args[2] + ' is not installed'); process.exit(1); }
`,
		{ mode: 0o755 },
	);
	const log = path.join(dir, 'log.jsonl');
	const calls = () =>
		fs.existsSync(log)
			? fs
					.readFileSync(log, 'utf8')
					.trim()
					.split('\n')
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
	const changes = () => calls().filter((c) => !(c.args[0] === 'plugin' && c.args[1] === 'list'));
	return { bin, calls, changes, env: { DF_CLAUDE_BIN: bin, DF_FAKE_LOG: log } };
}

const stateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'df-plug-state-'));
const repoDir = () => {
	const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-plug-repo-')));
	spawnSync('git', ['init', '-q'], { cwd: repo });
	return repo;
};

test('the catalog names a default scope for every plugin, all user today', () => {
	const cat = pluginCatalog();
	assert.ok(cat.marketplaces['claude-plugins-official']);
	for (const p of cat.plugins) assert.equal(p.defaultScope, 'user', p.id);
	assert.equal(cat.plugins.find((p) => p.id === SP).required, true);
});

test('required plugin always wanted at user scope', () => {
	const cat = pluginCatalog();
	for (const w of [desiredPlugins(L(), cat, {}), desiredPlugins(L(enabled({ [FD]: true })), cat, { DF_INSTALL_OPTIONAL: '0' })]) {
		const sp = w.find((x) => x.id === SP);
		assert.deepEqual([sp.scope, sp.required], ['user', true]);
	}
});

test('optional plugins are wanted at their default scope unless DF_INSTALL_OPTIONAL=0, and a layer that names one wins', () => {
	const cat = pluginCatalog();
	const sorted = (...xs) => xs.sort();
	assert.deepEqual(brief(desiredPlugins(L(), cat, {})), sorted(`${CS}@user`, `${FD}@user`, `${SP}@user`));
	assert.deepEqual(brief(desiredPlugins(L(), cat, { DF_INSTALL_OPTIONAL: '0' })), [`${SP}@user`]);
	// named by a layer: wanted whatever the switch says
	assert.deepEqual(brief(desiredPlugins(L(enabled({ [FD]: true })), cat, { DF_INSTALL_OPTIONAL: '0' })), sorted(`${FD}@user`, `${SP}@user`));
	assert.deepEqual(brief(desiredPlugins(L({}, enabled({ [FD]: true })), cat, { DF_INSTALL_OPTIONAL: '0' })), sorted(`${FD}@project`, `${SP}@user`));
	// user false drops it, unless the project turns it on for itself
	const off = enabled({ [FD]: false, [CS]: false });
	assert.deepEqual(brief(desiredPlugins(L(off), cat, {})), [`${SP}@user`]);
	assert.deepEqual(brief(desiredPlugins(L(off, enabled({ [FD]: true })), cat, {})), sorted(`${FD}@project`, `${SP}@user`));
	// user true beats a project true: it is already on everywhere
	assert.deepEqual(
		brief(desiredPlugins(L(enabled({ [FD]: true, [CS]: false }), enabled({ [FD]: true })), cat, {})),
		sorted(`${FD}@user`, `${SP}@user`),
	);
});

test('a project false on a user-level plugin keeps it at user scope and marks it off for the project', () => {
	const cat = pluginCatalog();
	const w = desiredPlugins(L(enabled({ [FD]: true, [CS]: false }), enabled({ [FD]: false })), cat, {});
	assert.deepEqual(brief(w), [`${FD}@user:off-project`, `${SP}@user`].sort());
	// the default makes it user-level too
	assert.ok(brief(desiredPlugins(L({}, enabled({ [CS]: false })), cat, {})).includes(`${CS}@user:off-project`));
	// nothing user-level to turn off when the switch says optional plugins are not wanted
	assert.ok(!brief(desiredPlugins(L({}, enabled({ [CS]: false })), cat, { DF_INSTALL_OPTIONAL: '0' })).some((x) => x.startsWith(CS)));
});

test('userKept lists the ids the user layer has not turned off, plus the managed ones', () => {
	const cat = pluginCatalog();
	const kept = userKept(L(enabled({ [FD]: true, [CS]: false })), cat, ['legacy@x']);
	assert.ok(kept.includes(FD) && kept.includes(SP) && kept.includes('legacy@x') && !kept.includes(CS));
});

test('planPlugins installs what is wanted and not there, at the right scope', () => {
	const repo = repoDir();
	const want = [
		{ id: SP, scope: 'user', required: true },
		{ id: FD, scope: 'project', required: false },
		{ id: CS, scope: 'user', required: false },
	];
	assert.deepEqual(planPlugins({ want, managed: empty(), installed: [entry(CS, 'user')], repo, userIds: [] }), {
		install: [
			{ id: SP, scope: 'user' },
			{ id: FD, scope: 'local' },
		],
		disable: [],
		uninstall: [],
	});
	// a plugin the user has at user scope and enabled is used as it is for a project that asks for it
	const projectFd = [{ id: FD, scope: 'project', required: false }];
	assert.deepEqual(planPlugins({ want: projectFd, managed: empty(), installed: [entry(FD, 'user')], repo, userIds: [] }).install, []);
	// ... but one that is disabled there gets its own local install
	const disabled = [entry(FD, 'user', { enabled: false })];
	assert.deepEqual(planPlugins({ want: projectFd, managed: empty(), installed: disabled, repo, userIds: [] }).install, [
		{ id: FD, scope: 'local' },
	]);
	// already installed locally for this repository
	assert.deepEqual(planPlugins({ want: projectFd, managed: empty(), installed: [entry(FD, 'local', { projectPath: repo })], repo }).install, []);
});

test('planPlugins disables a user-level plugin for the project that turns it off, only when it is installed', () => {
	const repo = repoDir();
	const want = [{ id: FD, scope: 'user', required: false, off: 'project' }];
	const plan = (installed) => planPlugins({ want, managed: empty(), installed, repo, userIds: [FD] });
	assert.deepEqual(plan([entry(FD, 'user')]).disable, [{ id: FD, scope: 'local' }]);
	assert.deepEqual(plan([]).disable, []);
	assert.deepEqual(plan([]).install, [{ id: FD, scope: 'user' }]);
});

test('an unmanaged plugin is never uninstalled', () => {
	const repo = repoDir();
	const installed = [entry(FD, 'user'), entry(CS, 'local')];
	assert.deepEqual(planPlugins({ want: [], managed: empty(), installed, repo, userIds: [] }), { install: [], disable: [], uninstall: [] });
});

test('only a managed plugin that is no longer wanted is uninstalled, at user scope only with userIds that no longer hold it', () => {
	const repo = repoDir();
	const managed = empty();
	managed.plugins.user = [FD, CS];
	managed.plugins.local[repo] = [SP];
	const installed = [entry(FD, 'user'), entry(CS, 'user'), entry(SP, 'local')];
	// no userIds: no user-scope uninstall, the local one still goes
	assert.deepEqual(planPlugins({ want: [], managed, installed, repo }).uninstall, [{ id: SP, scope: 'local' }]);
	// the user layer still has FD on: it stays; CS goes
	assert.deepEqual(planPlugins({ want: [], managed, installed, repo, userIds: [FD] }).uninstall, [
		{ id: CS, scope: 'user' },
		{ id: SP, scope: 'local' },
	]);
	// a wanted plugin is not uninstalled at the scope it is wanted at; another repository's record is not this one's
	const other = empty();
	other.plugins.local[repoDir()] = [FD];
	assert.deepEqual(
		planPlugins({ want: [{ id: FD, scope: 'project', required: false }], managed: other, installed: [], repo, userIds: [] }).uninstall,
		[],
	);
	const keep = [{ id: CS, scope: 'user', required: false }];
	assert.deepEqual(
		planPlugins({ want: keep, managed, installed, repo, userIds: [] }).uninstall.map((u) => u.id),
		[FD, SP],
	);
});

test('a listing that cannot be read plans nothing at all', () => {
	const repo = repoDir();
	const managed = empty();
	managed.plugins.user = [FD];
	for (const installed of [null, undefined, 'nope', { not: 'a list' }])
		assert.deepEqual(planPlugins({ want: [{ id: SP, scope: 'user', required: true }], managed, installed, repo, userIds: [] }), {
			install: [],
			disable: [],
			uninstall: [],
		});
});

test('project true installs at local scope from the repository', () => {
	const f = fakeClaude();
	const repo = repoDir();
	const env = { ...f.env, DF_STATE_DIR: stateDir() };
	const plan = {
		install: [
			{ id: FD, scope: 'local' },
			{ id: SP, scope: 'user' },
		],
		disable: [],
		uninstall: [],
	};
	assert.deepEqual(applyPlugins(plan, { repo, env }).failed, []);
	const log = f.changes();
	assert.deepEqual([log[0].args.join(' '), log[0].cwd], [`plugin install ${FD} --scope local`, repo]);
	assert.equal(log[1].args.join(' '), `plugin install ${SP} --scope user`);
	assert.deepEqual(readManaged(env).plugins, { user: [SP], local: { [repo]: [FD] } });
});

test('project false on a user-level plugin disables it at local scope', () => {
	const f = fakeClaude();
	const repo = repoDir();
	const env = { ...f.env, DF_STATE_DIR: stateDir() };
	const r = applyPlugins({ install: [], disable: [{ id: FD, scope: 'local' }], uninstall: [] }, { repo, env });
	assert.deepEqual(r.done, [{ id: FD, scope: 'local', action: 'disable' }]);
	assert.deepEqual(
		f.changes().map((c) => [c.args.join(' '), c.cwd]),
		[[`plugin disable ${FD} --scope local`, repo]],
	);
	assert.deepEqual(readManaged(env).plugins, { user: [], local: {} }, 'a disable is not an install: nothing is recorded');
});

test('applyPlugins records only what succeeded, keeps the mcp record, and uninstalls only what it recorded', () => {
	const f = fakeClaude();
	const repo = repoDir();
	const env = { ...f.env, DF_STATE_DIR: stateDir(), DF_FAKE_FAIL: FD };
	const seed = empty();
	seed.mcp.user = ['sentry'];
	seed.mcp.local[repo] = ['21st'];
	seed.plugins.user = [CS];
	writeManaged(env, seed);
	const plan = {
		install: [
			{ id: FD, scope: 'user' },
			{ id: SP, scope: 'user' },
		],
		disable: [],
		uninstall: [{ id: CS, scope: 'user' }],
	};
	const r = applyPlugins(plan, { repo, env });
	assert.deepEqual(
		r.failed.map((x) => [x.id, x.action]),
		[[FD, 'install']],
	);
	assert.match(r.failed[0].error, /boom/);
	assert.deepEqual(
		f.changes().map((c) => c.args.join(' ')),
		[`plugin uninstall ${CS} --scope user`, `plugin install ${FD} --scope user`, `plugin install ${SP} --scope user`],
	);
	assert.deepEqual(readManaged(env), { mcp: { user: ['sentry'], local: { [repo]: ['21st'] } }, plugins: { user: [SP], local: {} } });
});

test('a plugin that is already gone counts as uninstalled', () => {
	const f = fakeClaude();
	const repo = repoDir();
	const env = { ...f.env, DF_STATE_DIR: stateDir(), DF_FAKE_GONE: '1' };
	const seed = empty();
	seed.plugins.local[repo] = [FD];
	writeManaged(env, seed);
	const r = applyPlugins({ install: [], disable: [], uninstall: [{ id: FD, scope: 'local' }] }, { repo, env });
	assert.deepEqual(r.failed, []);
	assert.deepEqual(readManaged(env).plugins.local[repo], []);
});

test('applyPlugins without a repository runs no local step', () => {
	const f = fakeClaude();
	const env = { ...f.env, DF_STATE_DIR: stateDir() };
	const r = applyPlugins({ install: [{ id: FD, scope: 'local' }], disable: [], uninstall: [] }, { repo: null, env });
	assert.equal(r.failed.length, 1);
	assert.match(r.failed[0].error, /repository/);
	assert.deepEqual(f.changes(), []);
});

// ---- the command line ----

function cli(args, { cwd, env = {}, f = fakeClaude(), state = stateDir() } = {}) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, ...f.env, DF_STATE_DIR: state, DF_REPO: '', ...env },
	});
	return { ...r, f, state };
}

test('sync from a linked worktree reads the main checkout settings and installs at local scope from the main checkout', () => {
	const repo = repoDir();
	spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
	fs.mkdirSync(path.join(repo, '.devfactory'));
	fs.writeFileSync(path.join(repo, '.devfactory', 'config.json'), JSON.stringify(enabled({ [FD]: true })));
	const wt = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-plug-wt-'))), 'wt');
	assert.equal(spawnSync('git', ['worktree', 'add', '-q', wt, '-b', 'side'], { cwd: repo }).status, 0);
	const state = stateDir();
	fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(enabled({ [CS]: false })));
	const r = cli(['sync'], { cwd: wt, state });
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(
		r.f.changes().map((c) => [c.args.join(' '), c.cwd]),
		[
			[`plugin install ${SP} --scope user`, repo],
			[`plugin install ${FD} --scope local`, repo],
		],
	);
	// the listing was read from the main checkout too
	assert.ok(
		r.f
			.calls()
			.filter((c) => c.args[1] === 'list')
			.every((c) => c.cwd === repo),
	);
	assert.deepEqual(readManaged({ DF_STATE_DIR: state }).plugins, { user: [SP], local: { [repo]: [FD] } });
});

test('sync --dry-run prints the plan and runs nothing; DF_INSTALL_OPTIONAL=0 says which optional plugins are skipped', () => {
	const r = cli(['sync', '--dry-run'], { cwd: repoDir(), env: { DF_INSTALL_OPTIONAL: '0' } });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, new RegExp(`install\\s+${SP}`));
	assert.match(r.stdout, /frontend-design@\S+\s+is optional, skipped \(DF_INSTALL_OPTIONAL=0\)/);
	assert.deepEqual(r.f.changes(), []);
	assert.equal(fs.existsSync(path.join(r.state, 'managed.json')), false);
});

test('sync with a listing it cannot read changes nothing and fails only when applying', () => {
	const f = fakeClaude();
	const repo = repoDir();
	const bad = { DF_FAKE_LIST: 'not json' };
	const dry = cli(['sync', '--dry-run'], { cwd: repo, env: bad, f });
	assert.equal(dry.status, 0);
	assert.match(dry.stderr, /cannot read the installed plugins/);
	const real = cli(['sync'], { cwd: repo, env: bad, f });
	assert.equal(real.status, 1);
	assert.deepEqual(f.changes(), []);
});

test('sync reports a failed install on stderr and exits 1 after trying the rest', () => {
	const f = fakeClaude();
	const r = cli(['sync'], { cwd: repoDir(), env: { DF_FAKE_FAIL: SP }, f });
	assert.equal(r.status, 1);
	assert.match(r.stderr, new RegExp(`FAILED: claude plugin install ${SP}`));
	assert.ok(
		f.changes().some((c) => c.args.includes(FD)),
		'the rest was tried',
	);
});

test('sync works outside a repository for the user-level plugins', () => {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-plug-nogit-')));
	const r = cli(['sync'], { cwd });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.f.changes().length >= 1);
	assert.ok(r.f.changes().every((c) => c.args.at(-1) === 'user'));
});

test('list shows where each plugin is on', () => {
	const r = cli(['list'], { cwd: repoDir() });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, new RegExp(`user\\s+${SP}`));
	assert.match(r.stdout, new RegExp(`user\\s+${FD}`));
});

test('an unknown command prints usage and exits 3', () => {
	const r = cli(['nope'], { cwd: repoDir() });
	assert.equal(r.status, 3);
	assert.match(r.stderr, /usage: plugins\.mjs/);
});
