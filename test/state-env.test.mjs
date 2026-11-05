import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadTrackerEnv, parseEnvText } from '../scripts/state-env.mjs';

const IMPORT = path.resolve(import.meta.dirname, '../scripts/import-env.sh');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-senv-')));

test('the file is read as text: names, quotes and comments, and nothing is expanded or run', () => {
	const m = parseEnvText(
		[
			'# a comment',
			'',
			'JIRA_EMAIL=me@example.com',
			'export JIRA_API_TOKEN="tok en"',
			"NOTION_TOKEN='n-1'  # trailing",
			'EVIL=$(touch /tmp/pwned-by-env)',
			'HOME_COPY=$HOME',
			'  SPACED = nope',
			'DF_TAKEOVER=1',
		].join('\n'),
	);
	assert.equal(m.get('JIRA_EMAIL'), 'me@example.com');
	assert.equal(m.get('JIRA_API_TOKEN'), 'tok en');
	assert.equal(m.get('NOTION_TOKEN'), 'n-1');
	assert.equal(m.get('EVIL'), '$(touch /tmp/pwned-by-env)', 'literal text');
	assert.equal(m.get('HOME_COPY'), '$HOME');
	assert.equal(m.has('SPACED'), false);
	assert.equal(fs.existsSync('/tmp/pwned-by-env'), false);
});

test('only the tracker credential names are taken, and only when the environment does not have them', () => {
	const dir = tmp();
	fs.writeFileSync(
		path.join(dir, '.env.local'),
		'JIRA_EMAIL=a@b.c\nJIRA_API_TOKEN=tok\nNOTION_TOKEN=n\nDF_TAKEOVER=1\nCLAUDE_CODE_OAUTH_TOKEN=secret\nPATH=/evil\n',
	);
	const env = { NOTION_TOKEN: 'already' };
	assert.deepEqual(loadTrackerEnv({ env, dir }), ['JIRA_EMAIL', 'JIRA_API_TOKEN']);
	assert.deepEqual(env, { NOTION_TOKEN: 'already', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 'tok' }, 'no takeover, no login token, no PATH');
	assert.deepEqual(loadTrackerEnv({ env: {}, dir: path.join(dir, 'nowhere') }), [], 'a missing file is no error');
});

test('a Jira list typed in a terminal finds the credentials in the state folder', () => {
	const root = tmp();
	const state = path.join(root, 'state');
	fs.mkdirSync(state);
	fs.writeFileSync(path.join(state, '.env.local'), 'JIRA_EMAIL=a@b.c\nJIRA_API_TOKEN=tok\n');
	fs.writeFileSync(
		path.join(root, 'dev-factory.config.json'),
		JSON.stringify({ tasks: { source: 'jira' }, sources: { jira: { site: 'example.atlassian.net', cloudId: 'c', projects: ['APP'] } } }),
	);
	const script = path.resolve(import.meta.dirname, '../scripts/tasks.mjs');
	const env = { ...process.env, DF_STATE_DIR: state, JIRA_EMAIL: '', JIRA_API_TOKEN: '', HOME: root };
	const r = spawnSync(process.execPath, [script, 'list', '--state', 'ready'], { cwd: root, encoding: 'utf8', env, timeout: 30000 });
	assert.notEqual(r.status, 21, 'it got past the credentials check and tried the network: ' + r.stderr);
	assert.doesNotMatch(r.stderr, /no Jira API token/);
	const without = spawnSync(process.execPath, [script, 'list', '--state', 'ready'], {
		cwd: root,
		encoding: 'utf8',
		env: { ...env, DF_STATE_DIR: path.join(root, 'empty') },
	});
	assert.equal(without.status, 21);
});

test('loadTrackerEnv also fills an empty JIRA_SITE, and leaves a set one', () => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, '.env.local'), 'JIRA_SITE=from-file.example.atlassian.net\n');
	const env = { JIRA_SITE: '' };
	assert.deepEqual(loadTrackerEnv({ env, dir }), ['JIRA_SITE']);
	assert.equal(env.JIRA_SITE, 'from-file.example.atlassian.net');
	const set = { JIRA_SITE: 'mine.example.atlassian.net' };
	assert.deepEqual(loadTrackerEnv({ env: set, dir }), []);
	assert.equal(set.JIRA_SITE, 'mine.example.atlassian.net');
});

// ---- import-env.sh ----

function setup(extra = {}) {
	const root = tmp();
	const plugin = path.join(root, 'plugin');
	const state = path.join(root, 'state');
	fs.mkdirSync(plugin, { recursive: true });
	const old = path.join(plugin, '.env.local');
	fs.writeFileSync(
		old,
		[
			'# old setup',
			'JIRA_EMAIL=old@example.com',
			'export NOTION_TOKEN="old-notion-secret-value"',
			'CLAUDE_CODE_OAUTH_TOKEN=old-oauth-secret-value',
			'DF_TAKEOVER=1',
			'not a line',
			'',
		].join('\n'),
	);
	const run = (...a) =>
		spawnSync('bash', [IMPORT, ...a], { encoding: 'utf8', env: { ...process.env, DF_STATE_DIR: state, DF_REPO: root, ...extra } });
	return { root, old, state, target: path.join(state, '.env.local'), run };
}
const SECRETS = /old-notion-secret-value|old-oauth-secret-value|old@example\.com/;

test('import-env is a dry run unless told otherwise, and never prints a value', () => {
	const s = setup();
	const r = s.run('--from', s.old);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /would add JIRA_EMAIL/);
	assert.match(r.stdout, /would add NOTION_TOKEN/);
	assert.match(r.stdout, /would add CLAUDE_CODE_OAUTH_TOKEN/);
	assert.match(r.stdout, /dry run, 3 name\(s\) would be added/);
	assert.doesNotMatch(r.stdout + r.stderr, SECRETS);
	assert.equal(fs.existsSync(s.target), false, 'nothing written');
});

test('--apply writes the new names with mode 600, skips DF_TAKEOVER, never overwrites, and still prints no value', () => {
	const s = setup();
	fs.mkdirSync(s.state);
	fs.writeFileSync(s.target, 'JIRA_EMAIL=already@example.com\n');
	fs.chmodSync(s.target, 0o644);
	const r = s.run('--from', s.old, '--apply');
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /keep {2}JIRA_EMAIL \(already in/);
	assert.match(r.stdout, /skip {2}DF_TAKEOVER/);
	assert.match(r.stdout, /added NOTION_TOKEN/);
	assert.doesNotMatch(r.stdout + r.stderr, SECRETS);
	const text = fs.readFileSync(s.target, 'utf8');
	assert.match(text, /^JIRA_EMAIL=already@example\.com$/m, 'the existing value stands');
	assert.doesNotMatch(text, /old@example\.com/);
	assert.match(text, /NOTION_TOKEN="old-notion-secret-value"/);
	assert.match(text, /CLAUDE_CODE_OAUTH_TOKEN=old-oauth-secret-value/);
	assert.doesNotMatch(text, /DF_TAKEOVER/, 'takeover is the owner’s decision in the new place');
	assert.equal(fs.statSync(s.target).mode & 0o777, 0o600);
	const again = s.run('--from', s.old, '--apply');
	assert.match(again.stdout, /0 name\(s\) added/);
	assert.equal(fs.readFileSync(s.target, 'utf8'), text, 'idempotent');
	assert.ok(fs.existsSync(s.old), 'the old file is left for the person to delete');
});

test('a new state file is created with mode 600 from the start, and without --from it looks where an older setup kept it', () => {
	const s = setup();
	assert.equal(s.run('--from', s.old, '--apply').status, 0);
	assert.equal(fs.statSync(s.target).mode & 0o777, 0o600);
	const none = setup();
	fs.rmSync(none.old);
	assert.match(none.run().stdout, /no older \.env\.local found/);
	assert.equal(none.run('--from', path.join(none.root, 'missing')).status, 1);
	assert.equal(none.run('--bogus').status, 3);
	// the plugin directory the script belongs to is searched, and a vendored dev-factory/ folder of the repository
	const vendored = setup();
	fs.mkdirSync(path.join(vendored.root, 'dev-factory'));
	fs.copyFileSync(vendored.old, path.join(vendored.root, 'dev-factory/.env.local'));
	assert.match(vendored.run().stdout, /from .*dev-factory\/\.env\.local/);
	assert.match(fs.readFileSync(new URL('../scripts/cli.mjs', import.meta.url), 'utf8'), /'import-env': \['bash', 'scripts\/import-env\.sh'\]/);
});

test('import-env copies only values the shell reads back as themselves, and keeps the last old line apart from the new one', () => {
	const s = setup();
	const pwned = path.join(s.root, 'pwned');
	fs.writeFileSync(
		s.old,
		[
			'GOOD_PLAIN=abc123',
			"GOOD_SINGLE='a b $c'",
			'GOOD_DOUBLE="a b"',
			`BAD_SUBST=$(touch ${pwned})`,
			`BAD_BACKTICK=\`touch ${pwned}\``,
			`BAD_SEMI=x; touch ${pwned}`,
			`BAD_SPACE=x touch ${pwned}`,
			'BAD_EXPAND="$HOME/x"',
			`BAD_AND=x && touch ${pwned}`,
			'BAD_QUOTE="a"b"',
		].join('\n'),
	);
	fs.mkdirSync(s.state);
	fs.writeFileSync(s.target, 'EXISTING=1');
	const r = s.run('--from', s.old, '--apply');
	assert.equal(r.status, 0, r.stderr);
	for (const n of ['BAD_SUBST', 'BAD_BACKTICK', 'BAD_SEMI', 'BAD_SPACE', 'BAD_EXPAND', 'BAD_AND', 'BAD_QUOTE'])
		assert.match(r.stdout, new RegExp(`skip  ${n} `), n);
	const written = fs.readFileSync(s.target, 'utf8');
	assert.equal(written, 'EXISTING=1\nGOOD_PLAIN=abc123\nGOOD_SINGLE=\'a b $c\'\nGOOD_DOUBLE="a b"\n');
	// what was written is inert when the shell reads it, the way df_load_env does
	const sourced = spawnSync(
		'bash',
		['-c', `set -a; . "${s.target}"; printf '%s|%s|%s|%s' "$EXISTING" "$GOOD_PLAIN" "$GOOD_SINGLE" "$GOOD_DOUBLE"`],
		{ encoding: 'utf8' },
	);
	assert.equal(sourced.stdout, '1|abc123|a b $c|a b');
	assert.equal(fs.existsSync(pwned), false);
});

test('import-env skips the lines of a multi-line value, and a name written twice is taken once', () => {
	const s = setup();
	const pwned = path.join(s.root, 'pwned');
	fs.writeFileSync(
		s.old,
		[
			'PRIVATE_KEY="-----BEGIN KEY-----',
			'INSIDE_THE_VALUE=1',
			`touch ${pwned}`,
			'-----END KEY-----"',
			"NOTE='first line",
			'ALSO_INSIDE=2',
			"last line'",
			'REPEATED=one',
			'REPEATED=two',
			'AFTER=ok',
		].join('\n'),
	);
	const r = s.run('--from', s.old, '--apply');
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /skip {2}PRIVATE_KEY/);
	assert.match(r.stdout, /skip {2}NOTE/);
	assert.match(r.stdout, /skip {2}REPEATED \(named again/);
	assert.doesNotMatch(r.stdout, /INSIDE_THE_VALUE|ALSO_INSIDE/);
	assert.equal(fs.readFileSync(s.target, 'utf8'), 'REPEATED=one\nAFTER=ok\n');
	assert.match(r.stdout, /2 name\(s\) added/);
	assert.equal(fs.existsSync(pwned), false);
});

test('the command line runs a repository with a state folder of its own on that folder', async () => {
	const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
	const { stateDirFor } = await import('../scripts/cli.mjs');
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-cli-')));
	const repo = path.join(home, 'repo');
	fs.mkdirSync(repo);
	const slug = spawnSync('bash', ['-c', `DIR="${ROOT}"; . "${ROOT}/scripts/runtime.sh"; df_slug "${repo}"`], { encoding: 'utf8' }).stdout.trim();
	const env = { PATH: process.env.PATH, HOME: home, DF_REPO: repo };
	assert.equal(stateDirFor(env), null, 'nothing to change while the repository has no folder of its own');
	fs.mkdirSync(path.join(home, '.dev-factory', slug), { recursive: true });
	assert.equal(stateDirFor(env), path.join(home, '.dev-factory', slug));
	assert.equal(stateDirFor({ ...env, DF_STATE_DIR: '/s' }), null, 'an explicit folder is left alone');
});

test("an isolated repository's pass reads the machine's settings for all projects, managed.json and .env.local", async () => {
	const ROOT = path.resolve(import.meta.dirname, '..');
	const { machineDir } = await import('../scripts/state-env.mjs');
	const { userConfigFile, layers } = await import('../scripts/config.mjs');
	const { managedFile, readManaged } = await import('../scripts/mcp-scope.mjs');
	const home = tmp();
	const machine = path.join(home, '.dev-factory');
	const own = path.join(machine, 'app-123456');
	fs.mkdirSync(own, { recursive: true });
	fs.writeFileSync(path.join(machine, 'config.json'), JSON.stringify({ scheduler: { intervalMinutes: 17 } }));
	fs.writeFileSync(path.join(machine, 'managed.json'), JSON.stringify({ mcp: { user: ['context7'] } }));
	fs.writeFileSync(path.join(machine, '.env.local'), 'JIRA_EMAIL=me@example.com\n');
	// the scheduled job of an isolated repository runs with DF_STATE_DIR on the repository's own folder
	const env = { PATH: process.env.PATH, HOME: home, DF_STATE_DIR: own };
	assert.equal(machineDir(env), machine);
	assert.equal(userConfigFile(env), path.join(machine, 'config.json'));
	assert.equal(managedFile(env), path.join(machine, 'managed.json'));
	assert.deepEqual(readManaged(env).mcp.user, ['context7'], 'one record of what the factory added, not a second empty one');
	assert.equal(layers({ from: home, env }).find((l) => l.name === 'user').data.scheduler.intervalMinutes, 17);
	const filled = { ...env };
	assert.deepEqual(loadTrackerEnv({ env: filled }), ['JIRA_EMAIL'], 'the secrets come from the machine folder, linked or not');
	// and the way a pass asks for a setting: config.mjs get, from the command line
	const r = spawnSync('node', [path.join(ROOT, 'scripts/config.mjs'), 'get', 'scheduler.intervalMinutes'], { cwd: home, env, encoding: 'utf8' });
	assert.equal(r.stdout.trim(), '17', r.stderr);
	assert.equal(fs.existsSync(path.join(own, 'config.json')), false);
});

test('a repository folder made under another machine folder is known by the links install --isolate puts in it', async () => {
	const { machineDir } = await import('../scripts/state-env.mjs');
	const root = tmp();
	const own = path.join(root, 'app-123456');
	fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
	fs.mkdirSync(own);
	assert.equal(machineDir({ HOME: tmp(), DF_STATE_DIR: own }), own, 'no link yet: an ordinary state folder');
	fs.symlinkSync('../bin', path.join(own, 'bin'));
	assert.equal(machineDir({ HOME: tmp(), DF_STATE_DIR: own }), root);
});

test('a plain DF_STATE_DIR, with no repository folder, is the machine folder as before', async () => {
	const { machineDir } = await import('../scripts/state-env.mjs');
	const { userConfigFile } = await import('../scripts/config.mjs');
	const { managedFile } = await import('../scripts/mcp-scope.mjs');
	const state = tmp();
	const env = { HOME: tmp(), DF_STATE_DIR: state };
	assert.equal(machineDir(env), state);
	assert.equal(userConfigFile(env), path.join(state, 'config.json'));
	assert.equal(managedFile(env), path.join(state, 'managed.json'));
	// the machine folder itself, named by DF_STATE_DIR, is not a repository's folder
	const home = tmp();
	assert.equal(machineDir({ HOME: home, DF_STATE_DIR: path.join(home, '.dev-factory') }), path.join(home, '.dev-factory'));
	assert.equal(machineDir({ HOME: home }), path.join(os.homedir(), '.dev-factory'), 'unset: the default folder, as stateDir');
});
