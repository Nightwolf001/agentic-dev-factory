import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const json = (f) => JSON.parse(read(f));
const mdFiles = (dir) =>
	fs
		.readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith('.md'))
		.map((e) => path.join(e.parentPath ?? e.path, e.name));

// ---- the manifests ----

test('the plugin manifest names the plugin, its version, repository and licence', () => {
	const p = json('.claude-plugin/plugin.json');
	assert.equal(p.name, 'dev-factory');
	assert.match(p.version, /^\d+\.\d+\.\d+$/);
	assert.match(p.repository, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
	assert.equal(p.license, 'MIT');
	assert.ok(p.keywords.length > 0);
});

test('the marketplace serves this plugin from the repository root and its version agrees with the manifest', () => {
	const m = json('.claude-plugin/marketplace.json');
	const entry = m.plugins.find((x) => x.name === 'dev-factory');
	assert.equal(entry.source, '.');
	assert.equal(entry.version, json('.claude-plugin/plugin.json').version);
	assert.deepEqual(entry.dependencies, ['superpowers@claude-plugins-official']);
	assert.ok(m.allowCrossMarketplaceDependenciesOn.includes('claude-plugins-official'));
});

test('hooks reach their scripts through CLAUDE_PLUGIN_ROOT, and the shipped executables are executable', () => {
	const hooks = read('hooks/hooks.json');
	assert.ok([...hooks.matchAll(/"command":/g)].length >= 4);
	for (const m of hooks.matchAll(/"command":\s*"(.*)",?$/gm)) assert.match(m[1], /\$\{CLAUDE_PLUGIN_ROOT\}\//, m[1]);
	assert.ok(
		fs.statSync(path.join(ROOT, 'bin/dev-factory')).mode & 0o111,
		'bin/dev-factory is on PATH while the plugin is enabled, so it must be executable',
	);
	for (const f of fs.readdirSync(path.join(ROOT, 'scripts')).filter((n) => /^(guard-bash|edit-guard|stop-gate|mcp-guard)\.sh$/.test(n)))
		assert.ok(fs.statSync(path.join(ROOT, 'scripts', f)).mode & 0o111, f);
});

// ---- no path that only exists when the plugin is copied into a repository ----

test('commands, skills and agents run the plugin through CLAUDE_PLUGIN_ROOT, never through a dev-factory/ folder of the repository', () => {
	const files = [...mdFiles('commands'), ...mdFiles('skills'), ...mdFiles('agents')];
	assert.ok(files.length > 20);
	for (const f of files) {
		const text = fs.readFileSync(f, 'utf8');
		assert.doesNotMatch(text, /\b(node|bash) dev-factory\//, `${f}: runs a script from dev-factory/`);
		assert.doesNotMatch(text, /(?<![.\w~/-])dev-factory\/(bin|scripts|qa|config\.json|\.env)/, `${f}: names a plugin file by a repository path`);
	}
	const withScripts = files.filter((f) => /\$\{CLAUDE_PLUGIN_ROOT\}/.test(fs.readFileSync(f, 'utf8')));
	assert.ok(withScripts.length >= 10, 'the prompts do reference the plugin root');
});

test('QA cases are committed in the repository under .factory, and the plugin is never asked to hold them', () => {
	for (const f of ['skills/qa/SKILL.md', 'commands/quick.md', 'commands/plan.md', 'agents/factory-builder.md']) {
		const t = read(f);
		if (/qa\/cases/.test(t)) assert.match(t, /\.factory\/qa\/cases/, f);
	}
});

// ---- the command line ----

test('dev-factory path and unknown subcommands behave', () => {
	const run = (...a) => spawnSync(path.join(ROOT, 'bin/dev-factory'), a, { encoding: 'utf8', cwd: ROOT });
	assert.equal(run('path').stdout.trim(), ROOT);
	const bad = run('nonsense');
	assert.equal(bad.status, 3);
	assert.match(bad.stderr, /usage: dev-factory doctor\|install\|mcp\|tasks\|config/);
	assert.equal(run('config', 'get', 'tasks.source').stdout.trim(), 'local');
});

// ---- install: a launcher that survives plugin updates ----

test('install --apply writes a launcher that runs the newest cached copy, an env file with mode 600 and nothing in the repository', () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'df-install-'));
	const repo = path.join(home, 'repo');
	const bin = path.join(home, 'fakebin');
	fs.mkdirSync(repo);
	fs.mkdirSync(bin);
	const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
	git('init', '-q');
	git('commit', '-q', '--allow-empty', '-m', 'x');
	// claude and launchctl are not the point: record what would have been asked of them
	for (const n of ['claude', 'launchctl', 'plutil'])
		fs.writeFileSync(path.join(bin, n), '#!/bin/sh\necho "$0 $@" >> "$HOME/calls.log"\nexit 0\n', { mode: 0o755 });
	const env = {
		...process.env,
		HOME: home,
		PATH: `${bin}:${process.env.PATH}`,
		DF_STATE_DIR: path.join(home, 'state'),
		DF_REPO: repo,
		DF_RUNTIME: 'local',
	};
	const r = spawnSync('bash', [path.join(ROOT, 'scripts/install.sh'), '--apply'], { encoding: 'utf8', env, cwd: repo });
	assert.equal(r.status, 0, r.stderr);
	const launcher = path.join(home, 'state/bin/dev-factory');
	assert.ok(fs.statSync(launcher).mode & 0o111);
	assert.equal(fs.statSync(path.join(home, 'state/.env.local')).mode & 0o777, 0o600);
	assert.equal(fs.readFileSync(path.join(home, 'state/plugin-dir'), 'utf8').trim(), ROOT);
	assert.equal(git('status', '--porcelain').stdout.trim(), '', 'install leaves the repository untouched');

	// two cached versions: the newest wins; a missing cache falls back to the recorded directory
	const cache = path.join(home, '.claude/plugins/cache/dev-factory/dev-factory');
	for (const v of ['0.9.0', '0.10.0']) {
		fs.mkdirSync(path.join(cache, v, 'bin'), { recursive: true });
		fs.writeFileSync(path.join(cache, v, 'bin/dev-factory'), `#!/bin/sh\necho "version ${v} $@"\n`, { mode: 0o755 });
	}
	assert.equal(spawnSync(launcher, ['hello'], { encoding: 'utf8', env }).stdout.trim(), 'version 0.10.0 hello');
	fs.rmSync(path.join(home, '.claude'), { recursive: true });
	assert.match(spawnSync(launcher, ['path'], { encoding: 'utf8', env }).stdout, new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the launchd jobs get a label of their own per repository, so two repositories do not replace each other', () => {
	const install = read('scripts/install.sh');
	assert.match(install, /LABEL="com\.dev-factory\.\$SLUG\.\$job"/);
	for (const job of ['tick', 'improve']) {
		const t = read(`launchd/${job}.plist.template`);
		for (const token of ['__LABEL__', '__LAUNCHER__', '__JOB__', '__REPO__', '__STATE__']) assert.ok(t.includes(token), `${job}: ${token}`);
		assert.doesNotMatch(t, /dev-factory\/scripts/, `${job}: no path inside the repository`);
	}
});

test('the builder is told exactly when the commit hook runs in the container, instead of guessing', () => {
	const builder = read('agents/factory-builder.md');
	assert.match(builder, /environment\.preCommit/);
	assert.match(builder, /Never use `-n` otherwise/);
	assert.match(read('commands/setup.md'), /environment\.preCommit/);
	assert.match(read('commands/setup.md'), /claude mcp list/);
});

test('the ship step links the task, and every source file says how it does it', () => {
	for (const f of ['commands/tick.md', 'commands/build.md']) assert.match(read(f), /LINK the task/, f);
	for (const s of ['local', 'github', 'notion', 'jira']) assert.match(read(`skills/task-source/${s}.md`), /LINK/, s);
	assert.match(read('skills/task-source/SKILL.md'), /`LINK key branch pr qaVerdict evidence`/);
	const notion = JSON.parse(read('config.json')).sources.notion.properties;
	for (const k of ['branch', 'pullRequest', 'qaVerdict', 'evidence']) assert.ok(notion[k], `notion property ${k}`);
});
