import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { load, merge } from '../scripts/config.mjs';
import { evaluateEdit } from '../scripts/guard-lib.mjs';
import { isPluginRepo, resolveTarget } from '../scripts/factory-target.mjs';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

function repo({ plugin = false, vendored = false } = {}) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-target-')));
	spawnSync('git', ['init', '-q'], { cwd: dir });
	const manifest = (where) => {
		fs.mkdirSync(path.join(where, '.claude-plugin'), { recursive: true });
		fs.writeFileSync(path.join(where, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'dev-factory' }));
	};
	if (plugin) manifest(dir);
	if (vendored) manifest(path.join(dir, 'dev-factory'));
	return dir;
}

test('the factory repository itself is mode self, with the whole repository as its folder', () => {
	const dir = repo({ plugin: true });
	assert.deepEqual(resolveTarget({ cfg: load(), cwd: dir, env: {} }), { mode: 'self', repo: dir, prefix: '' });
	assert.equal(isPluginRepo(ROOT), true);
});

test('a plugin copied into the repository is vendored, and its folder is dev-factory/', () => {
	const dir = repo({ vendored: true });
	assert.deepEqual(resolveTarget({ cfg: load(), cwd: dir, env: {} }), { mode: 'vendored', repo: dir, prefix: 'dev-factory/' });
});

test('an installed plugin, with no checkout of its source, allows no improvement PR and says what to do', () => {
	const r = resolveTarget({ cfg: load(), cwd: repo(), env: {} });
	assert.equal(r.mode, 'none');
	assert.match(r.reason, /improvement\.factoryRepo/);
	assert.match(r.reason, /DF_FACTORY_REPO/);
	assert.equal(resolveTarget({ cfg: load(), cwd: os.tmpdir(), env: {} }).mode, 'none');
});

test('improvement.factoryRepo, or DF_FACTORY_REPO, points any project at a checkout of the factory source', () => {
	const checkout = repo({ plugin: true });
	const project = repo();
	const viaConfig = resolveTarget({ cfg: merge(load(), { improvement: { factoryRepo: checkout } }), cwd: project, env: {} });
	assert.deepEqual([viaConfig.mode, viaConfig.repo, viaConfig.prefix], ['clone', checkout, '']);
	const viaEnv = resolveTarget({ cfg: load(), cwd: project, env: { DF_FACTORY_REPO: checkout } });
	assert.equal(viaEnv.mode, 'clone');
	assert.equal(
		resolveTarget({ cfg: merge(load(), { improvement: { factoryRepo: project } }), cwd: project, env: {} }).mode,
		'none',
		'a checkout of something else is refused',
	);
	assert.match(
		resolveTarget({ cfg: merge(load(), { improvement: { factoryRepo: '/no/such/dir' } }), cwd: project, env: {} }).reason,
		/not a git checkout/,
	);
});

test('the CLI prints the target as JSON', () => {
	const r = spawnSync('node', [path.join(ROOT, 'scripts/factory-target.mjs')], { cwd: ROOT, encoding: 'utf8' });
	assert.equal(JSON.parse(r.stdout).mode, 'self');
});

// ---- what the improver may edit in each layout ----

const improver = (filePath, factoryPrefix, text = '') =>
	evaluateEdit({ filePath, text, root: '/w', active: true, run: { role: 'improver', key: 'APP-5', factoryPrefix } });

test('an improver in the factory repository edits the factory but not what enforces its limits', () => {
	for (const ok of ['skills/qa/SKILL.md', 'README.md', 'test/new.test.mjs', 'scripts/sources/github.mjs', 'commands/tick.md'])
		assert.equal(improver(ok, '').deny, false, ok);
	for (const no of [
		'scripts/guard-lib.mjs',
		'scripts/plugin-root.mjs',
		'bin/qa.mjs',
		'hooks/hooks.json',
		'settings.factory.json',
		'config.json',
		'plugins.json',
		'.github/workflows/ci.yml',
		'.claude/settings.json',
		'../elsewhere/x.md',
	])
		assert.equal(improver(no, '').deny, true, no);
});

test('an improver in a vendored copy stays inside dev-factory/, as before', () => {
	assert.equal(improver('dev-factory/skills/qa/SKILL.md', 'dev-factory/').deny, false);
	assert.equal(improver('src/app.js', 'dev-factory/').deny, true);
	assert.equal(improver('dev-factory/scripts/guard-lib.mjs', 'dev-factory/').deny, true);
	assert.equal(
		evaluateEdit({ filePath: 'dev-factory/skills/qa/SKILL.md', root: '/w', active: true, run: { role: 'improver', key: 'APP-5' } }).deny,
		false,
		'no prefix recorded means vendored',
	);
});

test('the forbidden vocabulary is refused everywhere in the factory repository, for an improver', () => {
	const word = ['night', 'shift'].join('');
	assert.equal(improver('README.md', '', `the ${word} crew`).deny, true);
	assert.equal(improver('README.md', '', 'plain text').deny, false);
});

test('the vocabulary lint checks the folder it is given, so a worktree of the factory is linted, not the installed copy', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-lint-'));
	fs.writeFileSync(path.join(dir, 'x.md'), `the ${['night', 'shift'].join('')} crew\n`);
	const bad = spawnSync('bash', [path.join(ROOT, 'scripts/lint-vocabulary.sh'), dir], { encoding: 'utf8' });
	assert.equal(bad.status, 1);
	assert.equal(spawnSync('bash', [path.join(ROOT, 'scripts/lint-vocabulary.sh')], { encoding: 'utf8' }).status, 0);
});

test('improve.md finds the target first, works in that checkout and records the folder prefix for the guards', () => {
	const t = fs.readFileSync(path.join(ROOT, 'commands/improve.md'), 'utf8');
	assert.match(t, /factory-target\.mjs/);
	assert.match(t, /git -C <repo> worktree add/);
	assert.match(t, /"factoryPrefix"/);
	assert.match(t, /`none`/);
});
