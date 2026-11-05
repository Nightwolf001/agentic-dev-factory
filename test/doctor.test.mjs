import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const PLUGIN = path.resolve(import.meta.dirname, '..');
const DOCTOR = path.join(PLUGIN, 'scripts/doctor.sh');
const OPTIONAL = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'plugins.json'), 'utf8'))
	.plugins.filter((p) => !p.required)
	.map((p) => p.id);

// A machine for doctor.sh to look at: a repository, a home, and stand-ins for `claude` and `gh` that answer from files.
function machine({ installed = [], ghFailures = 0 } = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-doctor-')));
	const repo = path.join(root, 'repo');
	const home = path.join(root, 'home');
	const bin = path.join(root, 'bin');
	for (const d of [repo, home, bin, path.join(home, 'Library/LaunchAgents')]) fs.mkdirSync(d, { recursive: true });
	for (const a of [
		['init', '-q'],
		['config', 'user.name', 'Dev Person'],
		['config', 'user.email', 'dev@example.test'],
	])
		execFileSync('git', ['-C', repo, ...a]);
	const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
	const plugins = path.join(root, 'plugins.txt');
	fs.writeFileSync(plugins, installed.join('\n') + '\n');
	stub('claude', `case "$*" in "--version") echo "2.1.0 (Claude Code)" ;; "plugin list") cat "${plugins}" ;; *) exit 0 ;; esac`);
	const ghCalls = path.join(root, 'gh-calls');
	stub('gh', `n=$(cat "${ghCalls}" 2>/dev/null || echo 0); echo $((n+1)) > "${ghCalls}"; [ "$n" -ge ${ghFailures} ]`);
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		HOME: home,
		DF_STATE_DIR: path.join(home, '.dev-factory'),
		DF_GH_RETRY_SECONDS: '0',
		DF_REPO: repo,
	};
	delete env.DF_TAKEOVER;
	const slug = execFileSync('bash', ['-c', `DIR="${PLUGIN}"; . "${PLUGIN}/scripts/runtime.sh"; df_slug "${repo}"`], { encoding: 'utf8' });
	const run = (...a) => spawnSync('bash', [DOCTOR, ...a], { encoding: 'utf8', env, cwd: repo });
	return { root, repo, home, slug, run, env, ghCalls: () => Number(fs.readFileSync(ghCalls, 'utf8')) };
}

test('gh is asked a second time before doctor calls it unauthenticated, and a lasting failure is a FAIL', () => {
	const blip = machine({ ghFailures: 1 });
	assert.match(blip.run().stdout, /ok {4}gh authenticated/);
	assert.equal(blip.ghCalls(), 2);
	const down = machine({ ghFailures: 99 });
	assert.match(down.run().stdout, /FAIL {2}gh not authenticated/);
	assert.equal(down.ghCalls(), 2, 'one retry, not a loop');
});

test('an optional plugin that is missing is a warning that says how to add it, and one that is installed is ok', () => {
	if (!OPTIONAL.length) return;
	const none = machine({ installed: ['superpowers@claude-plugins-official'] });
	const out = none.run().stdout;
	for (const id of OPTIONAL)
		assert.match(
			out,
			new RegExp(`warn {2}optional plugin ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not installed \\(dev-factory install --apply`),
		);
	const all = machine({ installed: ['superpowers@claude-plugins-official', ...OPTIONAL] });
	for (const id of OPTIONAL) assert.match(all.run().stdout, new RegExp(`ok {4}optional plugin ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test(
	'an installed scheduled job without TERM, LANG, LC_ALL and the state folder as working directory is a warning',
	{ skip: process.platform !== 'darwin' },
	() => {
		const m = machine();
		const plist = path.join(m.home, 'Library/LaunchAgents', `com.dev-factory.${m.slug}.tick.plist`);
		fs.writeFileSync(plist, '<plist><dict><key>Label</key><string>x</string></dict></plist>\n');
		assert.match(m.run().stdout, /warn {2}the installed tick job lacks: TERM LANG LC_ALL WorkingDirectory/);
		const state = path.join(m.home, '.dev-factory');
		fs.writeFileSync(
			plist,
			`<plist><dict><key>EnvironmentVariables</key><dict><key>TERM</key><string>xterm</string><key>LANG</key><string>en_US.UTF-8</string><key>LC_ALL</key><string>en_US.UTF-8</string></dict><key>WorkingDirectory</key>\n<string>${state}</string></dict></plist>\n`,
		);
		assert.match(m.run().stdout, /ok {4}scheduled job tick has TERM, LANG, LC_ALL and the state folder as working directory/);
	},
);

test(
	'--ci is recognised in any position: it skips the checks of the installed jobs, which a CI machine does not have',
	{ skip: process.platform !== 'darwin' },
	() => {
		const m = machine();
		fs.writeFileSync(path.join(m.home, 'Library/LaunchAgents', `com.dev-factory.${m.slug}.tick.plist`), '<plist><dict></dict></plist>\n');
		assert.match(m.run('--lenient').stdout, /the installed tick job lacks/, 'without --ci the job is checked');
		assert.doesNotMatch(m.run('--ci').stdout, /installed tick job lacks/);
		assert.doesNotMatch(m.run('--lenient', '--ci').stdout, /installed tick job lacks/, '--ci as the second argument counts too');
	},
);

// ---- the secrets the enabled servers need ----

const SECRETS = ['GITHUB_PERSONAL_ACCESS_TOKEN', 'JIRA_API_TOKEN', 'JIRA_EMAIL', 'CONTEXT7_API_KEY'];

function withServers(m, servers) {
	fs.mkdirSync(path.join(m.repo, '.devfactory'), { recursive: true });
	fs.writeFileSync(path.join(m.repo, '.devfactory', 'config.json'), JSON.stringify({ mcp: { servers } }));
	for (const k of SECRETS) delete m.env[k];
}

test('doctor prints one line per secret the enabled servers read, and never a value', () => {
	const m = machine();
	withServers(m, { jira: true, github: true });
	const empty = m.run().stdout;
	assert.match(empty, /warn {2}JIRA_API_TOKEN empty: needed by jira/);
	assert.match(empty, /warn {2}JIRA_EMAIL empty: needed by jira/);
	assert.match(empty, /warn {2}GITHUB_PERSONAL_ACCESS_TOKEN empty: needed by github/);
	Object.assign(m.env, { JIRA_API_TOKEN: 'sekrit-value', JIRA_EMAIL: 'a@example.test', GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_sekrit' });
	const set = m.run();
	assert.match(set.stdout, /ok {4}JIRA_API_TOKEN set \(jira\)/);
	assert.match(set.stdout, /ok {4}GITHUB_PERSONAL_ACCESS_TOKEN set \(github\)/);
	assert.doesNotMatch(set.stdout + set.stderr, /sekrit/);
});

test('doctor warns that a token Claude reads itself must be exported when it is only in .env.local', () => {
	const m = machine();
	withServers(m, { jira: true, github: true });
	const state = m.env.DF_STATE_DIR;
	fs.mkdirSync(state, { recursive: true });
	fs.writeFileSync(
		path.join(state, '.env.local'),
		'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_stored\nJIRA_API_TOKEN=jira_stored\nJIRA_EMAIL=a@example.test\n',
		{
			mode: 0o600,
		},
	);
	const out = m.run();
	assert.match(out.stdout, /warn {2}GITHUB_PERSONAL_ACCESS_TOKEN is set only in .*\.env\.local.*export it in the shell that starts claude/);
	assert.match(out.stdout, /ok {4}JIRA_API_TOKEN set \(jira\)/, 'the Jira launcher reads .env.local itself');
	assert.doesNotMatch(out.stdout + out.stderr, /ghp_stored|jira_stored/);
	m.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'ghp_stored';
	assert.match(m.run().stdout, /ok {4}GITHUB_PERSONAL_ACCESS_TOKEN set \(github\)/);
});

test('doctor shows the notes config validate prints', () => {
	const m = machine();
	fs.writeFileSync(path.join(m.repo, 'dev-factory.config.json'), '{}\n');
	assert.match(m.run().stdout, /warn {2}.*dev-factory\.config\.json is the old location/);
});
