import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const SCRIPT = path.join(ROOT, 'scripts/scheduler.sh');

// A repository, a home folder and stubs for launchctl and gh that remember what they were asked to do.
function fixture(config = {}) {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-sched-')));
	const repo = path.join(home, 'repo');
	const bin = path.join(home, 'bin');
	fs.mkdirSync(repo);
	fs.mkdirSync(bin);
	fs.mkdirSync(path.join(home, 'loaded'));
	spawnSync('git', ['init', '-q'], { cwd: repo });
	fs.writeFileSync(path.join(repo, 'dev-factory.config.json'), JSON.stringify(config));
	// launchctl: bootstrap loads a label, bootout unloads it, print succeeds only for a loaded one
	fs.writeFileSync(
		path.join(bin, 'launchctl'),
		`#!/bin/sh
echo "launchctl $@" >> "$HOME/calls.log"
case "$1" in
  bootstrap) b=$(basename "$3" .plist); : > "$HOME/loaded/$b" ;;
  bootout) b=$(basename "$2"); [ -f "$HOME/loaded/$b" ] && rm "$HOME/loaded/$b" || exit 3 ;;
  print) b=$(basename "$2"); [ -f "$HOME/loaded/$b" ] || exit 113 ;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(
		path.join(bin, 'gh'),
		`#!/bin/sh
echo "gh $@" >> "$HOME/calls.log"
case "$*" in
  "workflow list"*) cat "$HOME/wf-state" 2>/dev/null ;;
  "workflow disable"*) echo disabled_manually > "$HOME/wf-state" ;;
  "workflow enable"*) echo active > "$HOME/wf-state" ;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
	// claude and plutil are stubs too: install.sh must not reach the network or touch the real plugin set
	for (const n of ['claude', 'plutil'])
		fs.writeFileSync(path.join(bin, n), '#!/bin/sh\necho "$0 $@" >> "$HOME/calls.log"\nexit 0\n', { mode: 0o755 });
	const env = {
		...process.env,
		HOME: home,
		PATH: `${bin}:${process.env.PATH}`,
		DF_STATE_DIR: path.join(home, 'state'),
		DF_REPO: repo,
		DF_RUNTIME: 'local',
		DF_SCHEDULER: 'launchd',
	};
	const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env, cwd: repo });
	const calls = () => (fs.existsSync(path.join(home, 'calls.log')) ? fs.readFileSync(path.join(home, 'calls.log'), 'utf8') : '');
	const agents = path.join(home, 'Library/LaunchAgents');
	// pretend the jobs were installed and loaded
	const install = () => {
		fs.mkdirSync(agents, { recursive: true });
		const slug = spawnSync('bash', ['-c', `DIR="${ROOT}"; . "${ROOT}/scripts/runtime.sh"; df_slug "${repo}"`], {
			encoding: 'utf8',
			env,
		}).stdout.trim();
		for (const j of ['tick', 'improve']) {
			fs.writeFileSync(path.join(agents, `com.dev-factory.${slug}.${j}.plist`), '<plist/>');
			fs.writeFileSync(path.join(home, 'loaded', `com.dev-factory.${slug}.${j}`), '');
		}
		return slug;
	};
	return { home, repo, env, run, calls, install, agents };
}

test('status says which scheduler it is, whether each job runs, and the pause switch', () => {
	const f = fixture();
	let r = f.run('status');
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /scheduler:\s+launchd \(local\)/);
	assert.match(r.stdout, /tick: not installed/);
	assert.match(r.stdout, /pause switch: off/);
	f.install();
	r = f.run('status');
	assert.match(r.stdout, /tick: running/);
	assert.match(r.stdout, /improve: running/);
});

test('off unloads the launchd jobs and sets the pause switch; on loads them again and clears it', () => {
	const f = fixture();
	const slug = f.install();
	const off = f.run('off');
	assert.equal(off.status, 0, off.stderr);
	assert.match(f.calls(), new RegExp(`launchctl bootout gui/\\d+/com\\.dev-factory\\.${slug}\\.tick`));
	assert.match(f.calls(), new RegExp(`launchctl bootout gui/\\d+/com\\.dev-factory\\.${slug}\\.improve`));
	assert.ok(fs.existsSync(path.join(f.home, 'state', `paused.${slug}`)));
	assert.match(f.run('status').stdout, /pause switch: ON/);
	assert.match(f.run('status').stdout, /tick: installed, stopped/);
	assert.ok(fs.existsSync(path.join(f.agents, `com.dev-factory.${slug}.tick.plist`)), 'off keeps the job definitions');
	const on = f.run('on');
	assert.equal(on.status, 0, on.stderr);
	assert.match(f.calls(), /launchctl bootstrap gui\/\d+ .*\.tick\.plist/);
	assert.equal(fs.existsSync(path.join(f.home, 'state', `paused.${slug}`)), false);
	assert.match(f.run('status').stdout, /tick: running/);
});

test('one job can be switched on its own, and switching twice is harmless', () => {
	const f = fixture();
	f.install();
	assert.equal(f.run('off', 'improve').status, 0);
	const s = f.run('status').stdout;
	assert.match(s, /tick: running/);
	assert.match(s, /improve: installed, stopped/);
	assert.match(f.run('off', 'improve').stdout, /improve was not running/);
	assert.match(f.run('on', 'tick').stdout, /tick already running/);
	assert.equal(f.run('bogus').status, 3);
	assert.equal(f.run('on', 'weekly').status, 3);
});

test('on installs the jobs first when they never were', () => {
	const f = fixture();
	// the real install.sh runs; give it nothing slow to do
	const r = f.run('on');
	assert.match(r.stdout, /jobs were never installed here; installing/);
	assert.ok(fs.existsSync(path.join(f.home, 'state/bin/dev-factory')), 'install ran');
});

test('GitHub Actions: off disables the workflow and on enables it', () => {
	const f = fixture();
	f.env.DF_SCHEDULER = 'github-actions';
	fs.writeFileSync(path.join(f.home, 'wf-state'), 'active\n');
	assert.match(f.run('status').stdout, /scheduler:\s+github-actions/);
	assert.match(f.run('off').stdout, /disabled workflow dev-factory-tick\.yml/);
	assert.match(f.calls(), /gh workflow disable dev-factory-tick\.yml/);
	assert.match(f.run('on').stdout, /enabled workflow dev-factory-tick\.yml/);
	assert.match(f.calls(), /gh workflow enable dev-factory-tick\.yml/);
});

test('a routine is switched in Claude, and a repository with no scheduler says so', () => {
	const f = fixture();
	f.env.DF_SCHEDULER = 'routine';
	assert.match(f.run('off').stdout, /\/schedule/);
	f.env.DF_SCHEDULER = 'none';
	assert.match(f.run('status').stdout, /nothing runs by itself/);
	assert.equal(f.run('on').status, 1);
});

test('a scheduled pass does nothing while the pause switch is set, and a manual pass is not affected', () => {
	const f = fixture();
	f.install();
	f.run('off');
	const logOf = (job) => path.join(f.home, `${job}.log`);
	for (const job of ['tick', 'improve']) {
		const env = { ...f.env, DF_SCHEDULED: '1', DF_LOG: logOf(job) };
		const scheduled = spawnSync('bash', [path.join(ROOT, 'scripts', `${job}.sh`)], { encoding: 'utf8', env, cwd: f.repo });
		assert.equal(scheduled.status, 0, scheduled.stderr);
		const log = fs.readFileSync(logOf(job), 'utf8');
		assert.match(log, /paused/);
		assert.doesNotMatch(log, /pass start|improve start/);
	}
	// a manual run is not stopped by the switch: it gets as far as writing its start line (the stubs end it soon after)
	const env = { ...f.env, DF_LOG: path.join(f.home, 'manual.log'), DF_PREFLIGHT: 'off' };
	spawnSync('bash', [path.join(ROOT, 'scripts/tick.sh')], { encoding: 'utf8', env, cwd: f.repo, timeout: 60000 });
	assert.match(fs.readFileSync(path.join(f.home, 'manual.log'), 'utf8'), /pass start/);
});

test('the jobs and the workflow tell their passes they are scheduled, so the switch applies to them', () => {
	for (const j of ['tick', 'improve'])
		assert.match(fs.readFileSync(path.join(ROOT, `launchd/${j}.plist.template`), 'utf8'), /DF_SCHEDULED<\/key><string>1/);
	assert.match(fs.readFileSync(path.join(ROOT, 'templates/dev-factory-tick.yml'), 'utf8'), /DF_SCHEDULED: '1'/);
});

test('the slash command and the CLI both reach the script', () => {
	const md = fs.readFileSync(path.join(ROOT, 'commands/scheduler.md'), 'utf8');
	assert.match(md, /scripts\/scheduler\.sh/);
	assert.match(md, /on\|off\|status/);
	assert.match(fs.readFileSync(path.join(ROOT, 'scripts/cli.mjs'), 'utf8'), /scheduler: \['bash', 'scripts\/scheduler\.sh'\]/);
});
