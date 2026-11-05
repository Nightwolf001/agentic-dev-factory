import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkCopy, installedCopies, latestOffered, pruneCandidates, update } from '../scripts/update.mjs';

const OLD = Date.now() - 72 * 3600_000;

// A plugins folder: installed_plugins.json, cache/<marketplace>/<plugin>/<version>, marketplaces/<m>/.claude-plugin/marketplace.json
function plugins({ installed = {}, cached = [], offered = {} } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-plug-'));
	for (const [m, p, v, complete = true, age = OLD] of cached) {
		const d = path.join(dir, 'cache', m, p, v);
		fs.mkdirSync(path.join(d, '.claude-plugin'), { recursive: true });
		fs.writeFileSync(path.join(d, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: p, version: v }));
		if (complete && p === 'dev-factory')
			for (const f of ['bin/dev-factory', 'scripts/cli.mjs', 'hooks/hooks.json', 'config.json']) {
				fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
				fs.writeFileSync(path.join(d, f), 'x');
			}
		fs.utimesSync(d, new Date(age), new Date(age));
	}
	const j = { version: 2, plugins: {} };
	for (const [id, copies] of Object.entries(installed))
		j.plugins[id] = copies.map((c) => ({ scope: 'user', ...c, installPath: path.join(dir, 'cache', ...c.path) }));
	fs.writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify(j));
	for (const [id, v] of Object.entries(offered)) {
		const [n, m] = id.split('@');
		fs.mkdirSync(path.join(dir, 'marketplaces', m, '.claude-plugin'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'marketplaces', m, '.claude-plugin', 'marketplace.json'),
			JSON.stringify({ plugins: [{ name: n, version: v }] }),
		);
	}
	return dir;
}
const rec = (m, p, v) => ({ version: v, path: [m, p, v] });
const ok = () => ({ status: 0, stdout: '', stderr: '' });

test('every installed copy is found, one per scope, and other plugins are not', () => {
	const dir = plugins({
		installed: {
			'dev-factory@dev-factory': [
				{ ...rec('dev-factory', 'dev-factory', '0.8.0'), scope: 'user' },
				{ ...rec('dev-factory', 'dev-factory', '0.8.0'), scope: 'local' },
			],
			'superpowers@claude-plugins-official': [rec('claude-plugins-official', 'superpowers', '5.0.0')],
		},
		cached: [['dev-factory', 'dev-factory', '0.8.0']],
	});
	assert.deepEqual(
		installedCopies(dir).map((c) => `${c.id}:${c.scope}`),
		['dev-factory@dev-factory:user', 'dev-factory@dev-factory:local'],
	);
});

test('a copy is checked on disk: the folder, the version in its manifest and the files the launcher and hooks run', () => {
	const dir = plugins({
		installed: { 'dev-factory@dev-factory': [rec('dev-factory', 'dev-factory', '0.8.0')] },
		cached: [['dev-factory', 'dev-factory', '0.8.0']],
	});
	const [copy] = installedCopies(dir);
	assert.deepEqual(checkCopy(copy), { ok: true, problems: [] });
	fs.rmSync(path.join(copy.installPath, 'hooks/hooks.json'));
	fs.writeFileSync(path.join(copy.installPath, '.claude-plugin/plugin.json'), JSON.stringify({ version: '0.7.0' }));
	const bad = checkCopy(copy);
	assert.equal(bad.ok, false);
	assert.match(bad.problems.join('\n'), /missing hooks\/hooks\.json/);
	assert.match(bad.problems.join('\n'), /record says 0\.8\.0 but the folder holds 0\.7\.0/);
	assert.match(checkCopy({ ...copy, installPath: '/nope/x' }).problems[0], /is missing/);
});

test('only versions nothing refers to are pruned: installed ones, the newest of each plugin and recent ones stay, in every marketplace', () => {
	const dir = plugins({
		installed: {
			'dev-factory@dev-factory': [rec('dev-factory', 'dev-factory', '0.8.0')],
			'superpowers@claude-plugins-official': [rec('claude-plugins-official', 'superpowers', '5.0.0')],
		},
		cached: [
			['dev-factory', 'dev-factory', '0.6.0'],
			['dev-factory', 'dev-factory', '0.7.0'],
			['dev-factory', 'dev-factory', '0.8.0'],
			['dev-factory', 'dev-factory', '0.9.0'], // newest, not installed yet: kept
			['dev-factory', 'dev-factory', '0.7.5', true, Date.now() - 3600_000], // an hour old: a session may run from it
			['claude-plugins-official', 'superpowers', '4.0.0'],
			['claude-plugins-official', 'superpowers', '5.0.0'],
			['claude-plugins-official', 'other-plugin', '1.0.0'], // alone: it is the newest
			['claude-plugins-official', 'other-plugin', '0.9.0'],
		],
	});
	const gone = pruneCandidates({ dir })
		.map((c) => `${c.marketplace}/${c.plugin}/${c.version}`)
		.sort();
	assert.deepEqual(gone, [
		'claude-plugins-official/other-plugin/0.9.0',
		'claude-plugins-official/superpowers/4.0.0',
		'dev-factory/dev-factory/0.6.0',
		'dev-factory/dev-factory/0.7.0',
	]);
});

test('a symlinked version that leads outside the cache is never removed', () => {
	const dir = plugins({
		installed: { 'dev-factory@dev-factory': [rec('dev-factory', 'dev-factory', '0.8.0')] },
		cached: [
			['dev-factory', 'dev-factory', '0.8.0'],
			['dev-factory', 'dev-factory', '0.9.0'],
		],
	});
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'df-outside-'));
	fs.writeFileSync(path.join(outside, 'precious'), 'x');
	fs.symlinkSync(outside, path.join(dir, 'cache', 'dev-factory', 'dev-factory', '0.1.0'));
	assert.equal(
		pruneCandidates({ dir }).some((c) => c.version === '0.1.0'),
		false,
	);
	update({ dir, run: ok });
	assert.ok(fs.existsSync(path.join(outside, 'precious')));
});

test('update refreshes the marketplaces, updates each installed copy in its own scope, checks the result and prunes', () => {
	const dir = plugins({
		installed: {
			'dev-factory@dev-factory': [
				{ ...rec('dev-factory', 'dev-factory', '0.9.0'), scope: 'user' },
				{ ...rec('dev-factory', 'dev-factory', '0.9.0'), scope: 'local' },
			],
		},
		cached: [
			['dev-factory', 'dev-factory', '0.8.0'],
			['dev-factory', 'dev-factory', '0.9.0'],
		],
		offered: { 'dev-factory@dev-factory': '0.9.0' },
	});
	const calls = [];
	const r = update({ dir, run: (c, a) => (calls.push([c, ...a].join(' ')), ok()) });
	assert.deepEqual(calls, [
		'claude plugin marketplace update',
		'claude plugin update dev-factory@dev-factory --scope user',
		'claude plugin update dev-factory@dev-factory --scope local',
	]);
	assert.deepEqual(r.removed, ['dev-factory/dev-factory/0.8.0']);
	assert.equal(fs.existsSync(path.join(dir, 'cache/dev-factory/dev-factory/0.8.0')), false);
	assert.equal(fs.existsSync(path.join(dir, 'cache/dev-factory/dev-factory/0.9.0')), true);
	assert.equal(
		r.copies.every((c) => c.ok && !c.behind),
		true,
	);
	assert.deepEqual(r.problems, []);
});

test('--check changes nothing: no command runs and nothing is removed, and it says what is behind', () => {
	const dir = plugins({
		installed: { 'dev-factory@dev-factory': [rec('dev-factory', 'dev-factory', '0.8.0')] },
		cached: [
			['dev-factory', 'dev-factory', '0.7.0'],
			['dev-factory', 'dev-factory', '0.8.0'],
		],
		offered: { 'dev-factory@dev-factory': '0.9.0' },
	});
	const calls = [];
	const r = update({ check: true, dir, run: (...a) => (calls.push(a), ok()) });
	assert.deepEqual(calls, []);
	assert.equal(fs.existsSync(path.join(dir, 'cache/dev-factory/dev-factory/0.7.0')), true);
	assert.deepEqual(r.removed, ['dev-factory/dev-factory/0.7.0'], 'it reports what would go');
	assert.equal(r.copies[0].behind, true);
	assert.equal(r.copies[0].offered, '0.9.0');
	assert.equal(latestOffered(dir, 'dev-factory@dev-factory'), '0.9.0');
	assert.equal(latestOffered(dir, 'dev-factory@missing'), null);
});

test('a failed update or a broken copy prunes nothing and is reported', () => {
	const dir = plugins({
		installed: { 'dev-factory@dev-factory': [rec('dev-factory', 'dev-factory', '0.8.0')] },
		cached: [
			['dev-factory', 'dev-factory', '0.7.0'],
			['dev-factory', 'dev-factory', '0.8.0'],
		],
	});
	const r = update({
		dir,
		run: (c, a) => ({ status: a[1] === 'update' ? 1 : 0, stdout: '', stderr: 'network down' }),
	});
	assert.match(r.problems.join('\n'), /update of dev-factory@dev-factory \(user\) failed: network down/);
	assert.deepEqual(r.removed, []);
	assert.equal(fs.existsSync(path.join(dir, 'cache/dev-factory/dev-factory/0.7.0')), true);
	assert.throws(() => update({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'df-empty-')), run: ok }), /cannot read/);
	const none = plugins({ installed: { 'other@m': [rec('m', 'other', '1.0.0')] }, cached: [['m', 'other', '1.0.0']] });
	assert.throws(() => update({ dir: none, run: ok }), /no installed copy of dev-factory/);
});

test('the CLI is a dev-factory subcommand and exits 1 when nothing is installed', () => {
	assert.match(fs.readFileSync(new URL('../scripts/cli.mjs', import.meta.url), 'utf8'), /update: \['node', 'scripts\/update\.mjs'\]/);
	const r = spawnSync(process.execPath, [new URL('../scripts/update.mjs', import.meta.url).pathname, '--check'], {
		encoding: 'utf8',
		env: { ...process.env, DF_PLUGINS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'df-none-')) },
	});
	assert.equal(r.status, 1);
	assert.match(r.stderr, /cannot read/);
});
