import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { load, validate } from '../scripts/config.mjs';
import { marketplaceRepo, mergeSettings, renderWorkflow } from '../scripts/cloud.mjs';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

test('the marketplace repository comes from the argument, else the plugin repository URL', () => {
	assert.equal(marketplaceRepo('acme/tools'), 'acme/tools');
	assert.equal(
		marketplaceRepo(undefined, { repository: 'https://github.com/Nightwolf001/agentic-dev-factory' }),
		'Nightwolf001/agentic-dev-factory',
	);
	assert.equal(marketplaceRepo(undefined, { repository: 'git@github.com:o/r.git' }), 'o/r');
	assert.throws(() => marketplaceRepo(undefined, {}), /--marketplace OWNER\/REPO/);
});

test('project settings gain the marketplace and the enabled plugins without losing anything else', () => {
	const before = {
		permissions: { allow: ['Bash(ls)'] },
		enabledPlugins: { 'other@x': true },
		extraKnownMarketplaces: { x: { source: { source: 'github', repo: 'a/b' } } },
	};
	const after = mergeSettings(before, 'o/r');
	assert.deepEqual(after.permissions, before.permissions);
	assert.equal(after.enabledPlugins['other@x'], true);
	assert.equal(after.enabledPlugins['dev-factory@dev-factory'], true);
	assert.equal(after.enabledPlugins['superpowers@claude-plugins-official'], true);
	assert.deepEqual(after.extraKnownMarketplaces['dev-factory'], { source: { source: 'github', repo: 'o/r' } });
	assert.equal(after.extraKnownMarketplaces.x.source.repo, 'a/b');
	assert.ok(after.extraKnownMarketplaces['claude-plugins-official']);
	assert.deepEqual(mergeSettings(after, 'o/r'), after, 'idempotent');
});

test('cloud init writes the settings and the workflow, and the workflow carries the right plumbing', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-cloud-'));
	const r = spawnSync('node', [path.join(ROOT, 'scripts/cloud.mjs'), 'init', '--marketplace', 'o/r', '--github-actions', '--routine'], {
		cwd: dir,
		encoding: 'utf8',
	});
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /\/schedule/);
	const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
	assert.equal(settings.enabledPlugins['dev-factory@dev-factory'], true);
	const wf = fs.readFileSync(path.join(dir, '.github/workflows/dev-factory-tick.yml'), 'utf8');
	assert.match(wf, /claude plugin marketplace add o\/r/);
	assert.doesNotMatch(wf, /__MARKETPLACE__/);
	for (const needle of [
		'DF_RUNTIME: cloud',
		'concurrency:',
		'cancel-in-progress: false',
		'DF_GH_TOKEN',
		'CLAUDE_CODE_OAUTH_TOKEN',
		'DF_GIT_NAME',
		'actions/cache',
		'timeout-minutes',
	])
		assert.ok(wf.includes(needle), needle);
	assert.doesNotMatch(wf, /Co-Authored-By|generated with/i, 'the person is the author');
});

test('runtime settings validate: mode, scheduler, sandbox switch and worktree folder', () => {
	const c = load();
	assert.deepEqual(validate(c), []);
	assert.deepEqual([c.runtime.mode, c.runtime.scheduler, c.sandbox.enabled, c.git.worktreeRoot], ['auto', 'auto', null, '../.worktrees']);
	for (const [patch, expect] of [
		[(x) => (x.runtime.mode = 'moon'), /runtime\.mode must be auto, local or cloud/],
		[(x) => (x.runtime.scheduler = 'cron'), /runtime\.scheduler must be one of/],
		[(x) => (x.sandbox.enabled = 'yes'), /sandbox\.enabled must be true, false or null/],
		[(x) => (x.git.worktreeRoot = ''), /git\.worktreeRoot must be a folder path/],
	]) {
		const x = structuredClone(c);
		patch(x);
		assert.ok(
			validate(x).some((p) => expect.test(p)),
			String(expect),
		);
	}
});

// ---- runtime.sh ----

const sh = (script, env = {}) => {
	const r = spawnSync('bash', ['-c', `DIR="${ROOT}"; . "${ROOT}/scripts/runtime.sh"; ${script}`], {
		encoding: 'utf8',
		env: { PATH: process.env.PATH, HOME: '/home/u', ...env },
	});
	return { ...r, stdout: r.stdout.trim() };
};

test('the runtime is detected from the environment and can be forced', () => {
	assert.equal(sh('df_runtime').stdout, 'local');
	assert.equal(sh('df_runtime', { CLAUDE_CODE_REMOTE: 'true' }).stdout, 'cloud');
	assert.equal(sh('df_runtime', { GITHUB_ACTIONS: 'true' }).stdout, 'cloud');
	assert.equal(sh('df_runtime', { GITHUB_ACTIONS: 'true', DF_RUNTIME: 'local' }).stdout, 'local');
});

test('state, log and repository locations follow the runtime and the overrides', () => {
	assert.equal(sh('df_state_dir').stdout, '/home/u/.dev-factory');
	assert.equal(sh('df_state_dir', { DF_STATE_DIR: '/s' }).stdout, '/s');
	assert.equal(sh('df_log_file tick', { DF_LOG: '/l.log' }).stdout, '/l.log');
	assert.equal(sh('df_log_file tick', { DF_RUNTIME: 'cloud', DF_STATE_DIR: '/s' }).stdout, '/s/logs/tick.log', 'no macOS log folder in the cloud');
	assert.equal(sh('df_repo', { DF_REPO: '/r' }).stdout, '/r');
});

test('secrets are read from the machine state folder', () => {
	const state = fs.mkdtempSync(path.join(os.tmpdir(), 'df-env-'));
	fs.writeFileSync(path.join(state, '.env.local'), 'NOTION_TOKEN=abc\n');
	assert.equal(sh('df_load_env; printf %s "$NOTION_TOKEN"', { DF_STATE_DIR: state }).stdout, 'abc');
});

test('tick.sh and improve.sh refuse to run outside a repository, and use no path above the plugin', () => {
	const out = spawnSync('bash', [path.join(ROOT, 'scripts/tick.sh')], {
		cwd: os.tmpdir(),
		encoding: 'utf8',
		env: { PATH: process.env.PATH, HOME: os.tmpdir(), DF_STATE_DIR: path.join(os.tmpdir(), 'df-none') },
	});
	assert.notEqual(out.status, 0);
	for (const f of ['tick.sh', 'improve.sh'])
		assert.doesNotMatch(
			fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8'),
			/\$DIR\/\.\./.source === '' ? /^$/ : /REPO="\$\(cd "\$DIR\/\.\."/,
			f,
		);
});

test('the sandbox can be switched off for a cloud environment that supplies its own', async () => {
	const { build } = await import('../scripts/factory-settings.mjs');
	const { merge } = await import('../scripts/config.mjs');
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'df-sb-')), '.mcp.json');
	assert.equal(build({ cfg: load(), mcpFile: file }).sandbox.enabled, true);
	assert.equal(build({ cfg: merge(load(), { sandbox: { enabled: false } }), mcpFile: file }).sandbox.enabled, false);
});

test('the worktree folder is configurable and resolves beside the repository by default', () => {
	const r = spawnSync('node', [path.join(ROOT, 'scripts/worktree.mjs'), 'root', '--repo', ROOT], { encoding: 'utf8', cwd: ROOT });
	assert.equal(r.stdout.trim(), path.resolve(ROOT, '../.worktrees'));
});
