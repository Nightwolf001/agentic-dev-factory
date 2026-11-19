import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

// Runs a pass script from a folder that is not a repository, with a state folder that must stay empty: the arguments are read before
// anything else is touched, so a refused argument is status 2 (not the 1 of "not a repository") and leaves no trace.
function refused(script, ...args) {
	const cwd = tmp('df-args-cwd-');
	const state = path.join(tmp('df-args-state-'), 'state');
	const env = { ...process.env, DF_STATE_DIR: state, HOME: cwd };
	delete env.DF_REPO;
	const r = spawnSync('bash', [path.join(ROOT, 'scripts', script), ...args], { encoding: 'utf8', env, cwd });
	return { ...r, state };
}

test('improve.sh --bogus exits 2 and names the argument', () => {
	const r = refused('improve.sh', '--bogus');
	assert.equal(r.status, 2, r.stderr);
	assert.match(r.stderr, /improve\.sh: unknown argument '--bogus' \(accepted: --dry-run\)/);
	assert.equal(fs.existsSync(r.state), false, 'nothing was created in the state folder');
});

test('tick.sh takes no arguments', () => {
	for (const arg of ['anything', '--dry-run']) {
		const r = refused('tick.sh', arg);
		assert.equal(r.status, 2, r.stderr);
		assert.match(r.stderr, new RegExp(`tick\\.sh: unknown argument '${arg}' \\(accepted: none\\)`));
		assert.equal(fs.existsSync(r.state), false, 'nothing was created in the state folder');
	}
});

test('df_pass_args sets DF_DRY_RUN', () => {
	const parse = (shell, ...args) =>
		spawnSync(shell, ['-c', '. scripts/pass-args.sh; df_pass_args improve.sh "--dry-run" -- "$@"; echo $DF_DRY_RUN', '_', ...args], {
			encoding: 'utf8',
			cwd: ROOT,
		});
	for (const shell of ['bash', '/bin/bash']) {
		let r = parse(shell);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout.trim(), '0', `${shell}: no arguments`);
		r = parse(shell, '--dry-run');
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout.trim(), '1', `${shell}: --dry-run`);
		r = parse(shell, '--dry-run=1');
		assert.equal(r.status, 2, `${shell}: --dry-run=1`);
		assert.equal(r.stdout.trim(), '', 'it exits before the caller goes on');
		assert.match(r.stderr, /unknown argument '--dry-run=1'/);
		r = parse(shell, '--dry-run', '--other');
		assert.equal(r.status, 2, `${shell}: a second unknown flag after a valid one`);
		assert.match(r.stderr, /unknown argument '--other' \(accepted: --dry-run\)/);
	}
});

// ---- improve.sh --dry-run, end to end ----

// A repository on a machine where the doctor passes, with stand-ins for claude, gh and git that remember how they were called.
function improveFixture() {
	const home = tmp('df-dry-');
	const repo = path.join(home, 'repo');
	const bin = path.join(home, 'bin');
	const state = path.join(home, 'state');
	for (const d of [repo, bin, state]) fs.mkdirSync(d);
	const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
	spawnSync(realGit, ['init', '-q'], { cwd: repo });
	spawnSync(realGit, ['config', 'user.name', 'Dev One'], { cwd: repo });
	spawnSync(realGit, ['config', 'user.email', 'dev@example.com'], { cwd: repo });
	fs.writeFileSync(
		path.join(repo, 'dev-factory.config.json'),
		JSON.stringify({ tasks: { source: 'local' }, sources: { local: { dir: '.factory/tasks' } } }),
	);
	fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$@" >> "${path.join(home, 'git-calls')}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
	fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	fs.writeFileSync(
		path.join(bin, 'claude'),
		`#!/bin/sh
case "$1 $2" in
  "plugin list") echo "superpowers@claude-plugins-official frontend-design@claude-plugins-official code-simplifier@claude-plugins-official dev-factory@dev-factory"; exit 0 ;;
  "plugin marketplace") exit 0 ;;
esac
case "$1" in --version) echo "9.9.9"; exit 0 ;; esac
printf '%s\\n' "$@" > "${path.join(home, 'claude-args')}"
echo '{"result":"improve: findings=0"}'
`,
		{ mode: 0o755 },
	);
	const env = {
		...process.env,
		HOME: home,
		PATH: `${bin}:${process.env.PATH}`,
		DF_STATE_DIR: state,
		DF_REPO: repo,
		DF_RUNTIME: 'local',
		DF_LOG: path.join(home, 'improve.log'),
		CLAUDE_CODE_OAUTH_TOKEN: 'x',
		DF_SCHEDULER_INTERVAL_MINUTES: '',
	};
	const run = (...args) =>
		spawnSync('bash', [path.join(ROOT, 'scripts/improve.sh'), ...args], { encoding: 'utf8', env, cwd: repo, timeout: 90000 });
	const slug = spawnSync('bash', ['-c', `DIR="${ROOT}"; . "${ROOT}/scripts/runtime.sh"; df_slug "${repo}"`], {
		encoding: 'utf8',
		env,
	}).stdout.trim();
	const read = (f) => (fs.existsSync(path.join(home, f)) ? fs.readFileSync(path.join(home, f), 'utf8') : '');
	return { home, repo, state, env, run, slug, read };
}

test('improve.sh --dry-run asks for a dry run, does not fetch, ignores the pause switch, and prints what claude said', () => {
	const f = improveFixture();
	// a scheduled run would stop at the pause switch; a person who asked for the dry run by hand did not ask for a pause
	fs.writeFileSync(path.join(f.state, `paused.${f.slug}.improve`), '');
	f.env.DF_SCHEDULED = '1';
	const r = f.run('--dry-run');
	const log = f.read('improve.log');
	assert.equal(r.status, 0, `${r.stderr}\n${log}`);
	const args = f.read('claude-args').trim().split('\n');
	assert.equal(args[args.indexOf('-p') + 1], '/dev-factory:improve --dry-run', args.join(' '));
	assert.doesNotMatch(f.read('git-calls'), /(^|\s)fetch(\s|$)/, 'a dry run does not fetch');
	assert.doesNotMatch(log, /paused/);
	assert.match(r.stdout, /improve: findings=0/, 'the output reached the terminal');
	assert.match(log, /improve: findings=0/, 'and the log');
	assert.match(log, /improve end rc=0/);
});

test('improve.sh without arguments is unchanged: it fetches, keeps the prompt, keeps the pause switch and writes only to the log', () => {
	const f = improveFixture();
	const r = f.run();
	const log = f.read('improve.log');
	assert.equal(r.status, 0, `${r.stderr}\n${log}`);
	const args = f.read('claude-args').trim().split('\n');
	assert.equal(args[args.indexOf('-p') + 1], '/dev-factory:improve');
	assert.match(f.read('git-calls'), /(^|\s)fetch(\s|$)/);
	assert.doesNotMatch(r.stdout, /improve: findings=0/);
	assert.match(log, /improve: findings=0/);

	fs.writeFileSync(path.join(f.state, `paused.${f.slug}.improve`), '');
	f.env.DF_SCHEDULED = '1';
	fs.rmSync(path.join(f.home, 'claude-args'));
	assert.equal(f.run().status, 0);
	assert.equal(f.read('claude-args'), '', 'paused: claude did not start');
	assert.match(f.read('improve.log'), /paused/);
});
