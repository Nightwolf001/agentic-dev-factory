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
	assert.ok(fs.existsSync(path.join(f.home, 'state', `paused.${slug}.tick`)));
	assert.ok(fs.existsSync(path.join(f.home, 'state', `paused.${slug}.improve`)));
	assert.match(f.run('status').stdout, /pause switch tick: ON/);
	assert.match(f.run('status').stdout, /tick: installed, stopped/);
	assert.ok(fs.existsSync(path.join(f.agents, `com.dev-factory.${slug}.tick.plist`)), 'off keeps the job definitions');
	const on = f.run('on');
	assert.equal(on.status, 0, on.stderr);
	assert.match(f.calls(), /launchctl bootstrap gui\/\d+ .*\.tick\.plist/);
	assert.equal(fs.existsSync(path.join(f.home, 'state', `paused.${slug}.tick`)), false);
	assert.equal(fs.existsSync(path.join(f.home, 'state', `paused.${slug}.improve`)), false);
	assert.match(f.run('status').stdout, /tick: running/);
	assert.match(f.calls(), /launchctl kickstart gui\/\d+\/com\.dev-factory\..*\.tick/, 'a tick starts at once');
	assert.doesNotMatch(f.calls(), /kickstart .*improve/);
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

test('off and on touch only the job they name: one job never pauses or resumes the other', () => {
	const f = fixture();
	const slug = f.install();
	const switchOf = (j) => path.join(f.home, 'state', `paused.${slug}.${j}`);
	f.run('off', 'improve');
	assert.ok(fs.existsSync(switchOf('improve')));
	assert.equal(fs.existsSync(switchOf('tick')), false, 'tick keeps running');
	assert.match(f.run('status').stdout, /pause switch improve: ON/);
	assert.doesNotMatch(f.run('status').stdout, /pause switch tick: ON/);
	f.run('off', 'tick');
	f.run('on', 'tick');
	assert.equal(fs.existsSync(switchOf('tick')), false);
	assert.ok(fs.existsSync(switchOf('improve')), 'on tick leaves improve paused');
	f.run('on', 'improve');
	assert.equal(fs.existsSync(switchOf('improve')), false);

	// each pass reads its own switch
	fs.mkdirSync(path.join(f.home, 'state'), { recursive: true });
	fs.writeFileSync(switchOf('improve'), '');
	const pass = (job) => {
		const log = path.join(f.home, `${job}.log`);
		spawnSync('bash', [path.join(ROOT, 'scripts', `${job}.sh`)], {
			encoding: 'utf8',
			env: { ...f.env, DF_SCHEDULED: '1', DF_LOG: log, DF_PREFLIGHT: 'off' },
			cwd: f.repo,
			timeout: 60000,
		});
		return fs.readFileSync(log, 'utf8');
	};
	assert.match(pass('improve'), /paused/);
	assert.doesNotMatch(pass('tick'), /paused/);
});

test('the older switch that paused both jobs still pauses them, and turning one on keeps the other paused', () => {
	const f = fixture();
	const slug = f.install();
	fs.mkdirSync(path.join(f.home, 'state'), { recursive: true });
	fs.writeFileSync(path.join(f.home, 'state', `paused.${slug}`), '');
	const log = path.join(f.home, 'tick.log');
	spawnSync('bash', [path.join(ROOT, 'scripts/tick.sh')], { encoding: 'utf8', env: { ...f.env, DF_SCHEDULED: '1', DF_LOG: log }, cwd: f.repo });
	assert.match(fs.readFileSync(log, 'utf8'), /paused/);
	f.run('on', 'tick');
	assert.equal(fs.existsSync(path.join(f.home, 'state', `paused.${slug}`)), false);
	assert.equal(fs.existsSync(path.join(f.home, 'state', `paused.${slug}.tick`)), false);
	assert.ok(fs.existsSync(path.join(f.home, 'state', `paused.${slug}.improve`)), 'improve stays paused');
});

test('GitHub Actions has only a tick job: off and on for improve are refused and change nothing', () => {
	const f = fixture();
	f.env.DF_SCHEDULER = 'github-actions';
	fs.writeFileSync(path.join(f.home, 'wf-state'), 'active\n');
	for (const action of ['off', 'on']) {
		const r = f.run(action, 'improve');
		assert.equal(r.status, 1);
		assert.match(r.stderr, /only a tick job/);
	}
	assert.doesNotMatch(f.calls(), /gh workflow (disable|enable)/);
	assert.equal(f.run('off', 'tick').status, 0);
	assert.match(f.calls(), /gh workflow disable/);
});

test('the tick interval is one setting: it drives the launchd job, the workflow and the routine text', async () => {
	const { cronFor, renderWorkflow, routineHelp } = await import('../scripts/cloud.mjs');
	assert.deepEqual(cronFor(15), { cron: '*/15 * * * *', minutes: 15, note: null });
	assert.equal(cronFor(5).cron, '*/5 * * * *');
	assert.match(cronFor(2).note, /at most every 5 minutes/);
	assert.equal(cronFor(2).minutes, 5);
	assert.equal(cronFor(1).cron, '*/5 * * * *');
	assert.match(cronFor(17).note, /became 15/);
	assert.equal(cronFor(120).cron, '0 */2 * * *');
	assert.equal(cronFor(1440).cron, '0 0 * * *');
	assert.throws(() => cronFor(0), /whole number/);
	const yml = fs.readFileSync(path.join(ROOT, 'templates/dev-factory-tick.yml'), 'utf8');
	assert.match(renderWorkflow(yml, 'o/r', 10), /cron: '\*\/10 \* \* \* \*'/);
	assert.doesNotMatch(renderWorkflow(yml, 'o/r', 10), /__CRON__/);
	assert.match(routineHelp(30), /every 30 minutes/);

	// launchd: StartInterval is minutes x 60, from the setting or DF_SCHEDULER_INTERVAL_MINUTES
	const f = fixture({ scheduler: { intervalMinutes: 7 } });
	f.run('on'); // installs the jobs
	const plist = fs.readFileSync(
		path.join(
			f.agents,
			fs.readdirSync(f.agents).find((n) => n.endsWith('.tick.plist')),
		),
		'utf8',
	);
	assert.match(plist, /<key>StartInterval<\/key><integer>420<\/integer>/);
	const g = fixture({ scheduler: { intervalMinutes: 7 } });
	g.env.DF_SCHEDULER_INTERVAL_MINUTES = '3';
	g.run('on');
	assert.match(
		fs.readFileSync(
			path.join(
				g.agents,
				fs.readdirSync(g.agents).find((n) => n.endsWith('.tick.plist')),
			),
			'utf8',
		),
		/<integer>180<\/integer>/,
	);
	assert.match(g.run('status').stdout, /every 3 minutes/);
});

test('scheduled jobs run in a real environment: a terminal type, a UTF-8 locale and the state folder as home directory', () => {
	for (const j of ['tick', 'improve']) {
		const t = fs.readFileSync(path.join(ROOT, `launchd/${j}.plist.template`), 'utf8');
		assert.match(t, /<key>TERM<\/key><string>xterm-256color/);
		assert.match(t, /<key>LANG<\/key><string>en_US\.UTF-8/);
		assert.match(t, /<key>LC_ALL<\/key><string>en_US\.UTF-8/);
		assert.match(t, /<key>WorkingDirectory<\/key><string>__STATE__/);
	}
});

test('install: optional plugins are installed by default, DF_INSTALL_OPTIONAL=0 skips them, and a failed install fails the run', () => {
	const f = fixture();
	const claudeCalls = () =>
		f
			.calls()
			.split('\n')
			.filter((l) => /claude plugin install/.test(l));
	let r = spawnSync('bash', [path.join(ROOT, 'scripts/install.sh'), '--apply'], { encoding: 'utf8', env: f.env, cwd: f.repo });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(
		claudeCalls().some((l) => /frontend-design@/.test(l)),
		'optional plugin installed by default',
	);
	const g = fixture();
	g.env.DF_INSTALL_OPTIONAL = '0';
	r = spawnSync('bash', [path.join(ROOT, 'scripts/install.sh'), '--apply'], { encoding: 'utf8', env: g.env, cwd: g.repo });
	assert.match(r.stdout, /frontend-design@.* is optional, skipped/);
	assert.ok(
		!g
			.calls()
			.split('\n')
			.some((l) => /claude plugin install.*frontend-design/.test(l)),
	);
	// a claude that cannot install
	const h = fixture();
	fs.writeFileSync(path.join(h.home, 'bin/claude'), '#!/bin/sh\ncase "$*" in "plugin install"*) exit 1 ;; esac\nexit 0\n', { mode: 0o755 });
	r = spawnSync('bash', [path.join(ROOT, 'scripts/install.sh'), '--apply'], { encoding: 'utf8', env: h.env, cwd: h.repo });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /FAILED: claude plugin install superpowers@/);
	assert.match(r.stderr, /could not be installed/);
	// ... and the dry run never installs, so it never fails on it
	r = spawnSync('bash', [path.join(ROOT, 'scripts/install.sh')], { encoding: 'utf8', env: h.env, cwd: h.repo });
	assert.equal(r.status, 0, r.stderr);
});

// ---- a pass that could not reach a tool keeps its frontier ----

// A machine on which the doctor passes: a git identity, a claude that lists the required plugins and answers with `claudeResult`.
function passFixture(claudeResult) {
	const f = fixture({ tasks: { source: 'local' }, sources: { local: { dir: '.factory/tasks' } } });
	spawnSync('git', ['config', 'user.name', 'Dev One'], { cwd: f.repo });
	spawnSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: f.repo });
	const out = path.join(f.home, 'claude-result.json');
	fs.writeFileSync(out, JSON.stringify(claudeResult));
	fs.writeFileSync(
		path.join(f.home, 'bin/claude'),
		`#!/bin/sh
case "$1 $2" in
  "plugin list") echo "superpowers@claude-plugins-official frontend-design@claude-plugins-official code-simplifier@claude-plugins-official dev-factory@dev-factory"; exit 0 ;;
  "plugin marketplace") exit 0 ;;
esac
case "$1" in --version) echo "9.9.9"; exit 0 ;; esac
cat "${out}"
`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(path.join(f.home, 'bin/gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	const state = path.join(f.home, 'state');
	fs.mkdirSync(state, { recursive: true });
	Object.assign(f.env, {
		DF_PREFLIGHT: 'off',
		CLAUDE_CODE_OAUTH_TOKEN: 'x',
		DF_LOG: path.join(f.home, 'tick.log'),
		DF_SCHEDULER_INTERVAL_MINUTES: '',
	});
	const pending = path.join(state, 'frontier.pending.json');
	const committed = path.join(state, 'frontier.json');
	const tick = () => {
		fs.writeFileSync(pending, JSON.stringify({ fingerprint: 'abc', at: new Date().toISOString() }));
		return spawnSync('bash', [path.join(ROOT, 'scripts/tick.sh')], { encoding: 'utf8', env: f.env, cwd: f.repo, timeout: 90000 });
	};
	return { ...f, pending, committed, tick, state };
}

test('a pass that ended with "tick: aborted" discards the frontier it was about to remember; a normal pass commits it', () => {
	const aborted = passFixture({
		result: 'could not reach the task source\ntick: aborted task source unreachable',
		is_error: false,
		subtype: 'success',
	});
	const r1 = aborted.tick();
	assert.equal(
		fs.existsSync(aborted.committed),
		false,
		`the next pass must read the same queue\n${r1.stderr}${fs.readFileSync(aborted.env.DF_LOG, 'utf8')}`,
	);
	assert.equal(fs.existsSync(aborted.pending), false, 'and nothing is left pending');

	const normal = passFixture({ result: 'tick: claimed=1 resumed=0 shipped=1 blocked=0 merged=0 skipped=0', is_error: false, subtype: 'success' });
	normal.tick();
	assert.equal(fs.existsSync(normal.committed), true, fs.readFileSync(normal.env.DF_LOG, 'utf8'));
	// pass records now carry the wall-clock time and the subtype
	const runs = fs
		.readFileSync(path.join(normal.state, 'runs', 'runs.jsonl'), 'utf8')
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l));
	assert.equal(runs.at(-1).subtype, 'success');
	assert.equal(typeof runs.at(-1).wallMs, 'number');
});

test('a failed preflight is recorded once, shown by status, and cleared by a pass that gets through', () => {
	const f = passFixture({ result: 'tick: claimed=0', is_error: false });
	// make the doctor fail: no git identity
	spawnSync('git', ['config', '--unset', 'user.name'], { cwd: f.repo });
	spawnSync('git', ['config', '--unset', 'user.email'], { cwd: f.repo });
	f.env.GIT_CONFIG_GLOBAL = '/dev/null';
	f.env.GIT_CONFIG_SYSTEM = '/dev/null';
	const r = f.tick();
	assert.equal(r.status, 1);
	const rec = JSON.parse(fs.readFileSync(path.join(f.state, 'preflight-alert.json'), 'utf8'));
	assert.match(rec.reason, /^doctor: .*git user\.name/);
	assert.match(f.run('status').stdout, /last preflight failure: doctor: /);
	spawnSync('git', ['config', 'user.name', 'Dev One'], { cwd: f.repo });
	spawnSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: f.repo });
	f.tick();
	assert.equal(fs.existsSync(path.join(f.state, 'preflight-alert.json')), false, 'cleared');
});
