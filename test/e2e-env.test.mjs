import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const SCRIPT = new URL('../scripts/e2e-env.sh', import.meta.url).pathname;

// A fake docker that records every call; `compose ls` lists one df-* project and `config --services` one service.
// `labels` is what `ps -a --filter label=... --format ...` prints: the owner and worktree labels of the project's first container.
function fixture(config = {}, { labels = '' } = {}) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'df-e2e-'));
	const bin = path.join(base, 'bin');
	const state = path.join(base, 'state');
	const worktree = path.join(base, 'wt');
	for (const d of [bin, state, path.join(worktree, '.devcontainer'), path.join(worktree, '.dev-factory'), path.join(state, 'live')])
		fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(path.join(worktree, '.devcontainer/docker-compose.yml'), 'services: {}\n');
	fs.writeFileSync(path.join(worktree, '.dev-factory/run.json'), '{}');
	fs.writeFileSync(path.join(worktree, 'dev-factory.config.json'), JSON.stringify(config));
	fs.writeFileSync(
		path.join(bin, 'docker'),
		`#!/bin/bash
echo "$@" >> "${base}/docker.log"
case "$*" in
  *"compose ls"*) echo '[{"Name":"df-app-1"}]' ;;
  *"config --services"*) echo api ;;
  *"ps -a --filter"*"--format"*) cat "${base}/labels" ;;
  *"ps -aq"*) echo c1 ;;
  *" build"*|*" up -d"*|*" exec "*) exit 0 ;;
  *) exit 1 ;;
esac
`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(path.join(base, 'labels'), labels);
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DF_STATE_DIR: state, DF_OWNER_PID: String(process.pid) };
	const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8', cwd: worktree });
	const log = () => (fs.existsSync(path.join(base, 'docker.log')) ? fs.readFileSync(path.join(base, 'docker.log'), 'utf8') : '');
	return { base, state, worktree, run, log };
}

test('--ports accepts direct and the error names all three values', () => {
	const f = fixture();
	const r = f.run('up', '--key', 'APP-1', '--ports', 'bogus');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /--ports must be canonical, direct or none/);
	const ok = f.run('up', '--key', 'APP-1', '--ports', 'direct'); // no environment configured: only recorded
	assert.equal(ok.status, 0, ok.stderr);
	assert.doesNotMatch(ok.stderr, /--ports must be/);
});

test('the compose override strips host ports for --ports none and --ports direct, and keeps them for canonical', () => {
	const recorded = { none: '', canonical: 'https://login.app.local', direct: 'https://app.df-app-1.orb.local' };
	for (const [ports, strips] of [
		['none', true],
		['direct', true],
		['canonical', false],
	]) {
		const f = fixture({
			environment: { type: 'compose', composeFile: '.devcontainer/docker-compose.yml', service: 'app', webBaseUrl: 'https://login.app.local' },
		});
		f.run('up', '--key', 'APP-1', '--ports', ports); // fails at compose build on the fake docker; the override is already written
		const override = fs.readFileSync(path.join(f.worktree, '.dev-factory/compose.override.yml'), 'utf8');
		assert.equal(override.includes('ports: !reset []'), strips, ports);
		assert.match(override, /dev-factory: "1"/);
		const env = JSON.parse(fs.readFileSync(path.join(f.worktree, '.dev-factory/env.json'), 'utf8'));
		assert.equal(env.ports, ports);
		assert.equal(env.webBaseUrl, recorded[ports], ports);
	}
});

test('sweep removes an orphan stack but spares one whose worktree is still being worked on', () => {
	const old = fixture();
	fs.writeFileSync(path.join(old.state, 'live/df-app-1'), `99999999\n${old.worktree}\n`);
	const past = new Date(Date.now() - 6 * 3600_000);
	fs.utimesSync(path.join(old.worktree, '.dev-factory/run.json'), past, past);
	old.run('sweep');
	assert.match(old.log(), /ps -aq --filter label=com.docker.compose.project=df-app-1/);

	const fresh = fixture();
	fs.writeFileSync(path.join(fresh.state, 'live/df-app-1'), `99999999\n${fresh.worktree}\n`);
	fresh.run('sweep');
	assert.doesNotMatch(fresh.log(), /ps -aq/);

	const gone = fixture();
	fs.writeFileSync(path.join(gone.state, 'live/df-app-1'), `99999999\n${gone.worktree}-missing\n`);
	gone.run('sweep');
	assert.match(gone.log(), /ps -aq/);
});

// a pid that has exited: a child that ran and was waited for
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const removed = (f) => /rm -f/.test(f.log());

test('the override labels every service with its owner and worktree', () => {
	const f = fixture({ environment: { type: 'compose', composeFile: '.devcontainer/docker-compose.yml', service: 'app' } });
	f.run('up', '--key', 'APP-1', '--ports', 'none'); // fails at compose build on the fake docker; the override is already written
	const override = fs.readFileSync(path.join(f.worktree, '.dev-factory/compose.override.yml'), 'utf8');
	assert.match(override, /dev-factory: "1"/);
	assert.ok(override.includes(`dev-factory.owner: "${process.pid}"`), override);
	assert.ok(override.includes(`dev-factory.worktree: "${fs.realpathSync(f.worktree)}"`), override);
	assert.match(override, /ports: !reset \[\]/);
});

// The script records the worktree as `cd "$path" && pwd` prints it: the path as given, with a symlinked
// ancestor left in place. realpathSync would resolve it (macOS's temp folder /var is a link to
// /private/var), so the expectation asks the same shell builtin. The path travels as an argument, never
// inside the program text, so a quote, backslash or dollar sign in it stays inert.
const loggedPath = (dir) => spawnSync('bash', ['-c', 'cd "$1" && pwd', '_', dir], { encoding: 'utf8' }).stdout.replace(/\n$/, '');

test('a worktree path with a quote or a backslash stays valid YAML in the override labels', () => {
	const f = fixture({ environment: { type: 'compose', composeFile: '.devcontainer/docker-compose.yml', service: 'app' } });
	const odd = path.join(f.base, 'we"ird\\wt');
	fs.mkdirSync(path.join(odd, '.devcontainer'), { recursive: true });
	fs.writeFileSync(path.join(odd, '.devcontainer/docker-compose.yml'), 'services: {}\n');
	fs.writeFileSync(path.join(odd, 'dev-factory.config.json'), fs.readFileSync(path.join(f.worktree, 'dev-factory.config.json')));
	const r = spawnSync('bash', [SCRIPT, 'up', '--worktree', odd, '--key', 'APP-1'], {
		env: { ...process.env, PATH: `${path.join(f.base, 'bin')}:${process.env.PATH}`, DF_STATE_DIR: f.state, DF_OWNER_PID: String(process.pid) },
		encoding: 'utf8',
		cwd: f.worktree,
	});
	assert.notEqual(r.status, null);
	const override = fs.readFileSync(path.join(odd, '.dev-factory/compose.override.yml'), 'utf8');
	assert.ok(override.includes(String.raw`dev-factory.worktree: "${loggedPath(odd).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`), override);
});

test('a dollar sign in the worktree path is doubled in the override label, as compose interpolates every value', () => {
	for (const name of ['a$NAME', 'a${NAME}b', 'a$-b', 'trail$', 'mix$"q\\b$X']) {
		const f = fixture({ environment: { type: 'compose', composeFile: '.devcontainer/docker-compose.yml', service: 'app' } });
		const odd = path.join(f.base, name);
		fs.mkdirSync(path.join(odd, '.devcontainer'), { recursive: true });
		fs.writeFileSync(path.join(odd, '.devcontainer/docker-compose.yml'), 'services: {}\n');
		fs.writeFileSync(path.join(odd, 'dev-factory.config.json'), fs.readFileSync(path.join(f.worktree, 'dev-factory.config.json')));
		spawnSync('bash', [SCRIPT, 'up', '--worktree', odd, '--key', 'APP-1'], {
			env: {
				...process.env,
				PATH: `${path.join(f.base, 'bin')}:${process.env.PATH}`,
				DF_STATE_DIR: f.state,
				DF_OWNER_PID: String(process.pid),
			},
			encoding: 'utf8',
			cwd: f.worktree,
		});
		const override = fs.readFileSync(path.join(odd, '.dev-factory/compose.override.yml'), 'utf8');
		const want = loggedPath(odd).replace(/\$/g, '$$$$').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
		assert.ok(override.includes(`dev-factory.worktree: "${want}"`), `${name}: ${override}`);
		assert.equal((override.match(/\$/g) ?? []).length, (name.match(/\$/g) ?? []).length * 2, name);
	}
});

test('a sweep from another state folder keeps a stack whose labelled owner is alive', () => {
	const f = fixture({}, { labels: `${process.pid}|/nonexistent\n` }); // no live/ file here: this sweep does not know the owner
	const r = f.run('sweep');
	assert.equal(r.status, 0, r.stderr);
	assert.equal(removed(f), false, f.log());
});

test('a sweep keeps a stack whose worktree has a fresh run.json even when its owner is dead', () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.base, 'labels'), `${deadPid()}|${f.worktree}\n`);
	fs.writeFileSync(path.join(f.worktree, '.dev-factory/run.json'), '{}');
	f.run('sweep');
	assert.equal(removed(f), false, f.log());
});

test('a sweep removes a stack whose owner is dead and whose worktree is gone', () => {
	const f = fixture({}, { labels: `${deadPid()}|/nonexistent\n` });
	f.run('sweep');
	assert.match(f.log(), /ps -aq --filter label=com.docker.compose.project=df-app-1/);
	assert.ok(removed(f), f.log());
});

test('a sweep removes a stack whose owner is dead and whose run.json is old', () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.base, 'labels'), `${deadPid()}|${f.worktree}\n`);
	const past = new Date(Date.now() - 6 * 3600_000);
	fs.utimesSync(path.join(f.worktree, '.dev-factory/run.json'), past, past);
	f.run('sweep');
	assert.ok(removed(f), f.log());
});

test('a stack with no labels is swept by the live-file rule as before', () => {
	const bare = fixture(); // started before this release: no labels, no live/ file
	bare.run('sweep');
	assert.ok(removed(bare), bare.log());

	const kept = fixture(); // no labels, but a live/ file whose pid is alive
	fs.writeFileSync(path.join(kept.state, 'live/df-app-1'), `${process.pid}\n/nonexistent\n`);
	kept.run('sweep');
	assert.equal(removed(kept), false, kept.log());
});

test('a stack whose labels cannot be read is swept by the live-file rule', () => {
	const f = fixture();
	// docker answers the label query with a failure
	fs.writeFileSync(
		path.join(f.base, 'bin/docker'),
		fs.readFileSync(path.join(f.base, 'bin/docker'), 'utf8').replace('cat "' + f.base + '/labels"', 'exit 1'),
		{ mode: 0o755 },
	);
	f.run('sweep');
	assert.ok(removed(f), f.log());
});

test('up refuses a key that is not a task key, since it reaches node -e snippets', () => {
	const f = fixture();
	for (const key of ["X-1'; touch /tmp/pwned; '", 'no-digits-', '../x-1', 'A B-1']) {
		const r = f.run('up', '--key', key);
		assert.equal(r.status, 1, key);
		assert.match(r.stderr, /--key must look like/);
	}
});

test('every shell script parses (bash -n), the scheduler scripts included', async () => {
	const dir = new URL('../scripts/', import.meta.url).pathname;
	for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sh'))) {
		const r = spawnSync('bash', ['-n', path.join(dir, f)], { encoding: 'utf8' });
		assert.equal(r.status, 0, `${f}: ${r.stderr}`);
	}
});

test('with no environment configured, up only records that and down forgets it', () => {
	const f = fixture();
	const up = f.run('up', '--key', 'APP-1', '--ports', 'canonical');
	assert.equal(up.status, 0, up.stderr);
	const envFile = path.join(f.worktree, '.dev-factory/env.json');
	assert.equal(JSON.parse(fs.readFileSync(envFile, 'utf8')).mode, 'none');
	assert.equal(f.run('verify').status, 0);
	assert.equal(f.log(), '', 'docker is never called');
	assert.equal(f.run('down').status, 0);
	assert.equal(fs.existsSync(envFile), false);
});

test('a compose environment runs its configured setup commands inside the configured service and polls the ping URL', () => {
	const f = fixture({
		environment: {
			type: 'compose',
			composeFile: '.devcontainer/docker-compose.yml',
			service: 'web',
			user: 'dev',
			setup: ['npm ci'],
			pingUrl: 'http://app.local/ping',
		},
	});
	f.run('up', '--key', 'APP-1');
	const log = f.log();
	assert.match(log, /exec -T -u dev web bash -c npm ci/);
	assert.doesNotMatch(log, /startup|pm2|devcontainer exec/);
});

test('a canonical-ports start refuses, before building anything, when a published host port is already in use', async () => {
	const net = await import('node:net');
	const server = net.createServer();
	await new Promise((r) => server.listen(0, r));
	const port = server.address().port;
	try {
		const f = fixture({ environment: { type: 'compose', composeFile: '.devcontainer/docker-compose.yml', service: 'app' } });
		// the fake docker answers `config --format json` with a service that publishes the busy port and a free one
		const dockerFile = path.join(f.base, 'bin/docker');
		fs.writeFileSync(
			dockerFile,
			`#!/bin/bash
echo "$@" >> "${f.base}/docker.log"
case "$*" in
  *"config --format json"*) echo '{"services":{"app":{"ports":[{"published":"${port}","target":3000},{"published":"1","target":1}]}}}' ;;
  *"config --services"*) echo app ;;
  *) exit 0 ;;
esac
`,
			{ mode: 0o755 },
		);
		const r = f.run('up', '--key', 'APP-1', '--ports', 'canonical');
		assert.equal(r.status, 75, r.stderr);
		assert.match(r.stderr, new RegExp(`host port\\(s\\) already in use: ${port}`));
		assert.doesNotMatch(f.log(), / build/, 'nothing was built');
		assert.equal(fs.existsSync(path.join(f.state, 'ports.lock')), false, 'the ports lock was not taken');
		// isolated mode publishes nothing, so a busy host port is not its business
		const iso = f.run('up', '--key', 'APP-2', '--ports', 'none');
		assert.doesNotMatch(iso.stderr, /already in use/);
	} finally {
		server.close();
	}
});

test('the wait for a fresh stack is a config setting, with an env override', () => {
	const f = fixture({ environment: { type: 'compose', composeFile: '.devcontainer/docker-compose.yml', service: 'app', readyTimeout: 1234 } });
	const src = fs.readFileSync(SCRIPT, 'utf8');
	assert.match(src, /READY_TIMEOUT="\$\{DF_READY_TIMEOUT:-\$\(cfg readyTimeout\)\}"/);
	const out = spawnSync('node', [new URL('../scripts/config.mjs', import.meta.url).pathname, 'get', 'environment.readyTimeout'], {
		cwd: f.worktree,
		encoding: 'utf8',
	});
	assert.equal(out.stdout.trim(), '1234');
});

test('with takeover on, a canonical-ports start frees the busy host port instead of refusing, and without it still refuses', async () => {
	const { spawn } = await import('node:child_process');
	const child = spawn(
		process.execPath,
		['-e', "require('net').createServer().listen(0,function(){console.log(this.address().port)});setInterval(()=>{},1000)"],
		{ stdio: ['ignore', 'pipe', 'ignore'] },
	);
	try {
		const port = await new Promise((res) => child.stdout.once('data', (d) => res(Number(String(d).trim()))));
		const f = fixture({ environment: { type: 'compose', composeFile: '.devcontainer/docker-compose.yml', service: 'app' } });
		fs.writeFileSync(
			path.join(f.base, 'bin/docker'),
			`#!/bin/bash
echo "$@" >> "${f.base}/docker.log"
case "$*" in
  *"config --format json"*) echo '{"services":{"app":{"ports":[{"published":"${port}","target":3000}]}}}' ;;
  *"config --services"*) echo app ;;
  *"ps --filter"*) exit 0 ;;
  *) exit 0 ;;
esac
`,
			{ mode: 0o755 },
		);
		const refused = f.run('up', '--key', 'APP-1', '--ports', 'canonical');
		assert.equal(refused.status, 75, refused.stderr);
		assert.match(refused.stderr, /DF_TAKEOVER/, 'the refusal names the toggle');
		assert.equal(child.exitCode, null, 'nothing was stopped');
		const env = {
			...process.env,
			PATH: `${path.join(f.base, 'bin')}:${process.env.PATH}`,
			DF_STATE_DIR: f.state,
			DF_OWNER_PID: String(process.pid),
			DF_TAKEOVER: '1',
		};
		const r = spawnSync('bash', [SCRIPT, 'up', '--key', 'APP-1', '--ports', 'canonical'], { env, encoding: 'utf8', cwd: f.worktree });
		assert.match(r.stderr, /takeover is on: freeing host port/, r.stderr);
		assert.doesNotMatch(r.stderr, /already in use/);
		await new Promise((res) => (child.exitCode !== null || child.signalCode ? res() : child.once('exit', res)));
		assert.ok(child.exitCode !== null || child.signalCode, 'the process holding the port was stopped');
	} finally {
		child.kill('SIGKILL');
	}
});

// A docker whose `exec` reads standard input to its end, as the real `exec -T` does, and logs each call with its arguments.
function stdinReadingDocker(f) {
	fs.writeFileSync(
		path.join(f.base, 'bin/docker'),
		`#!/bin/bash
echo "$@" >> "${f.base}/docker.log"
case "$*" in
  *"config --services"*) echo api ;;
  *" exec "*) cat > /dev/null; exit 0 ;;
  *" build"*|*" up -d"*) exit 0 ;;
  *) exit 1 ;;
esac
`,
		{ mode: 0o755 },
	);
}

test('every setup step runs: exec -T reads standard input, which must not be the list of steps', () => {
	const f = fixture({
		environment: {
			type: 'compose',
			composeFile: '.devcontainer/docker-compose.yml',
			service: 'app',
			setup: ['echo one', 'echo two', 'echo three'],
		},
	});
	stdinReadingDocker(f);
	f.run('up', '--key', 'APP-1');
	const log = f.log();
	for (const s of ['echo one', 'echo two', 'echo three']) assert.ok(log.includes(`bash -c ${s}`), `${s} ran:\n${log}`);
});

test('a setup entry may run as another user, or span several lines', () => {
	const f = fixture({
		environment: {
			type: 'compose',
			composeFile: '.devcontainer/docker-compose.yml',
			service: 'app',
			user: 'dev',
			setup: ['echo plain', { run: 'chown -R dev /srv', user: 'root' }, 'echo first\necho second', { run: 'echo as-default-user' }],
		},
	});
	stdinReadingDocker(f);
	f.run('up', '--key', 'APP-1');
	const log = f.log();
	assert.match(log, /exec -T -u dev app bash -c echo plain/);
	assert.match(log, /exec -T -u root app bash -c chown -R dev \/srv/);
	assert.match(log, /exec -T -u dev app bash -c echo first\necho second/, 'a multi-line step is one command');
	assert.match(log, /exec -T -u dev app bash -c echo as-default-user/);
});

test('a failing setup step stops the start and names the step', () => {
	const f = fixture({
		environment: {
			type: 'compose',
			composeFile: '.devcontainer/docker-compose.yml',
			service: 'app',
			setup: ['echo ok', 'false-step', 'echo never'],
		},
	});
	fs.writeFileSync(
		path.join(f.base, 'bin/docker'),
		`#!/bin/bash
echo "$@" >> "${f.base}/docker.log"
case "$*" in
  *"config --services"*) echo api ;;
  *"bash -c false-step"*) exit 7 ;;
  *" exec "*|*" build"*|*" up -d"*) exit 0 ;;
  *) exit 0 ;;
esac
`,
		{ mode: 0o755 },
	);
	const r = f.run('up', '--key', 'APP-1');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /false-step/);
	assert.doesNotMatch(f.log(), /echo never/);
});

test('a stack started with fewer ports than this run needs is replaced; an equal or stronger one is reused', () => {
	const record = (f, mode) =>
		fs.writeFileSync(
			path.join(f.worktree, '.dev-factory/env.json'),
			JSON.stringify({ project: 'df-app-1', key: 'APP-1', worktree: f.worktree, mode }),
		);
	const cfg = { environment: { type: 'compose', composeFile: '.devcontainer/docker-compose.yml', service: 'app' } };
	const healthy = (f) =>
		fs.writeFileSync(
			path.join(f.base, 'bin/docker'),
			`#!/bin/bash
echo "$@" >> "${f.base}/docker.log"
case "$*" in
  *"config --services"*) echo api ;;
  *"ps -a --format json"*) echo '{"Service":"api","State":"running"}' ;;
  *) exit 0 ;;
esac
`,
			{ mode: 0o755 },
		);
	// isolated -> canonical: replaced
	let f = fixture(cfg);
	healthy(f);
	record(f, 'isolated');
	let r = f.run('up', '--key', 'APP-1', '--ports', 'canonical');
	assert.match(r.stderr, /replacing df-app-1/, r.stderr);
	assert.match(f.log(), /down -v/);
	assert.ok(f.log().indexOf('down -v') < f.log().indexOf(' up -d'), 'taken down before the new start');
	assert.equal(JSON.parse(fs.readFileSync(path.join(f.worktree, '.dev-factory/env.json'), 'utf8')).mode, 'canonical');
	// isolated -> device: replaced
	f = fixture(cfg);
	healthy(f);
	record(f, 'isolated');
	assert.match(f.run('up', '--key', 'APP-1', '--device').stderr, /replacing df-app-1/);
	// canonical -> canonical, canonical -> isolated, device -> canonical: reused, nothing rebuilt
	for (const [have, ports] of [
		['canonical', 'canonical'],
		['canonical', 'none'],
		['isolated', 'none'],
	]) {
		f = fixture(cfg);
		healthy(f);
		record(f, have);
		r = f.run('up', '--key', 'APP-1', '--ports', ports);
		assert.match(r.stderr, new RegExp(`ready \\(reused, ${have}\\): df-app-1`), `${have} -> ${ports}: ${r.stderr}`);
		assert.doesNotMatch(f.log(), / up -d| build/);
	}
});

// ---- --ports direct: the stack at its own address, reached from this machine ----

const DIRECT_CFG = {
	environment: {
		type: 'compose',
		composeFile: '.devcontainer/docker-compose.yml',
		service: 'app',
		pingUrl: 'http://localhost:3000/api/health?token=SECRET',
		webBaseUrl: 'http://localhost:3000',
	},
};

// fixture() with a docker whose stack is healthy (so `up` gets through verify) and a fake curl for the probe from this machine:
// it logs its arguments to curl.log and prints the HTTP status held in the file curl-answer, as `-w '%{http_code}'` does; 000 is
// no connection, which real curl also reports with a non-zero exit. `answers` is true (200), false (000) or a status.
// `state` shares one state folder between fixtures; `env` adds variables to every run.
function directFixture(config = DIRECT_CFG, { answers = true, ipAnswers, ip = '192.168.97.2', state, env: more = {} } = {}) {
	const f = fixture(config);
	fs.writeFileSync(
		path.join(f.base, 'bin/docker'),
		`#!/bin/bash
echo "$@" >> "${f.base}/docker.log"
case "$*" in
  *"compose ls"*) echo '[{"Name":"df-app-1"}]' ;;
  *"config --services"*) echo api ;;
  *"ps -a --format json"*) echo '{"Service":"api","State":"running"}' ;;
  *"ps -aq"*) echo c1 ;;
  *"ps -q"*) echo c1 ;;
  *"inspect"*) printf '%s' "${ip ? ip + ' ' : ''}" ;;
  *) exit 0 ;;
esac
`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(
		path.join(f.base, 'bin/curl'),
		`#!/bin/bash
echo "$@" >> "${f.base}/curl.log"
code="$(cat "${f.base}/curl-answer" 2>/dev/null)"
case "$*" in *"${ip}"*) [ -f "${f.base}/curl-answer-ip" ] && code="$(cat "${f.base}/curl-answer-ip")" ;; esac
printf '%s' "\${code:-000}"
[ "\${code:-000}" = 000 ] && exit 7
exit 0
`,
		{ mode: 0o755 },
	);
	const answer = (a) => fs.writeFileSync(path.join(f.base, 'curl-answer'), a === true ? '200' : a === false ? '000' : String(a));
	answer(answers);
	if (ipAnswers !== undefined)
		fs.writeFileSync(path.join(f.base, 'curl-answer-ip'), ipAnswers === true ? '200' : ipAnswers === false ? '000' : String(ipAnswers));
	const stateDir = state ?? f.state;
	const env = {
		...process.env,
		PATH: `${path.join(f.base, 'bin')}:${process.env.PATH}`,
		DF_STATE_DIR: stateDir,
		DF_OWNER_PID: String(process.pid),
		DF_READY_TIMEOUT: '0',
	};
	delete env.DF_PING_URL;
	Object.assign(env, more);
	const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8', cwd: f.worktree });
	const record = () => JSON.parse(fs.readFileSync(path.join(f.worktree, '.dev-factory/env.json'), 'utf8'));
	const curlLog = () => (fs.existsSync(path.join(f.base, 'curl.log')) ? fs.readFileSync(path.join(f.base, 'curl.log'), 'utf8') : '');
	const locked = () => fs.existsSync(path.join(stateDir, 'ports.lock'));
	return { ...f, state: stateDir, env, run, record, curlLog, answer, locked };
}
const withEnv = (more) => ({ environment: { ...DIRECT_CFG.environment, ...more } });

// ---- --ports direct --device: the stack at its own address for a simulator and an emulator ----

const ROOT = path.resolve(path.dirname(SCRIPT), '..');

// directFixture() running a copy of the plugin whose mobile lane is a stub that logs its arguments to lane.log and exits with
// `laneExit`: the real lane needs a simulator or an emulator, and mobile.test.mjs covers it.
function deviceFixture(opts = {}) {
	const f = directFixture(opts.directCfg ?? DIRECT_CFG, opts);
	const plugin = path.join(f.base, 'plugin');
	fs.cpSync(ROOT, plugin, { recursive: true, filter: (src) => !/\/(\.git|node_modules|test|docs)(\/|$)/.test(src) });
	fs.writeFileSync(path.join(plugin, 'scripts/mobile-env.sh'), `#!/bin/bash\necho "$@" >> "${f.base}/lane.log"\nexit ${opts.laneExit ?? 0}\n`, {
		mode: 0o755,
	});
	const run = (...args) => spawnSync('bash', [path.join(plugin, 'scripts/e2e-env.sh'), ...args], { env: f.env, encoding: 'utf8', cwd: f.worktree });
	const lane = () => (fs.existsSync(path.join(f.base, 'lane.log')) ? fs.readFileSync(path.join(f.base, 'lane.log'), 'utf8') : '');
	return { ...f, run, lane };
}

test('--ports direct with --device is accepted in either order and records the name and the container IP', () => {
	for (const args of [
		['--ports', 'direct', '--device'],
		['--device', '--ports', 'direct'],
	]) {
		const f = deviceFixture();
		const r = f.run('up', '--key', 'APP-1', ...args);
		assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
		const rec = f.record();
		assert.equal(rec.mode, 'device', 'the stack serves a device');
		assert.equal(rec.ports, 'direct', 'and publishes no host port');
		assert.equal(rec.webBaseUrl, 'http://app.df-app-1.orb.local:3000', 'the name: what the Mac and an iOS simulator use');
		assert.equal(rec.directIp, '192.168.97.2');
		assert.equal(rec.directIpUrl, 'http://192.168.97.2:3000', 'the address an Android emulator uses: its DNS cannot see the name');
		assert.deepEqual(rec.hosts, ['app.df-app-1.orb.local', '192.168.97.2'], 'a probe may reach both');
		assert.match(fs.readFileSync(path.join(f.worktree, '.dev-factory/compose.override.yml'), 'utf8'), /ports: !reset \[\]/);
		assert.equal(f.locked(), false, 'no ports.lock');
		assert.doesNotMatch(f.log(), /config --format json/, 'no busy-ports check');
		assert.match(f.curlLog(), /http:\/\/app\.df-app-1\.orb\.local:3000(\s|$)/, 'the name was probed');
		assert.match(f.curlLog(), /http:\/\/192\.168\.97\.2:3000(\s|$)/, 'and the IP');
		assert.match(f.lane(), /^up --worktree /m, 'the mobile lane ran');
	}
});

test('--device without direct ports keeps the canonical ports, the lock and no IP', () => {
	for (const args of [['--device'], ['--device', '--ports', 'none'], ['--ports', 'none', '--device']]) {
		const f = deviceFixture();
		const r = f.run('up', '--key', 'APP-1', ...args);
		assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
		const rec = f.record();
		assert.equal(rec.mode, 'device');
		assert.equal(rec.ports, 'canonical', args.join(' '));
		assert.equal('directIp' in rec, false);
		assert.equal(f.locked(), true);
	}
});

test('a device stack whose container IP does not answer fails, tears itself down and never starts the lane', () => {
	const f = deviceFixture({ ipAnswers: false });
	const r = f.run('up', '--key', 'APP-1', '--ports', 'direct', '--device');
	assert.equal(r.status, 1, r.stderr);
	assert.match(r.stderr, /container address http:\/\/192\.168\.97\.2:3000 did not answer within 0s/);
	assert.match(r.stderr, /Android emulator/);
	assert.match(f.log(), /down -v/);
	assert.equal(f.lane(), '');
	assert.equal(f.locked(), false);
});

test('a device stack whose container has no IP fails and says so', () => {
	const f = deviceFixture({ ip: '' });
	const r = f.run('up', '--key', 'APP-1', '--ports', 'direct', '--device');
	assert.equal(r.status, 1, r.stderr);
	assert.match(r.stderr, /could not read the IP address of the service app/);
	assert.match(f.log(), /down -v/);
});

test('a direct web start does not look up or record an IP', () => {
	const f = deviceFixture();
	assert.equal(f.run('up', '--key', 'APP-1', '--ports', 'direct').status, 0);
	assert.equal('directIp' in f.record(), false);
	assert.doesNotMatch(f.log(), /inspect/);
	assert.equal(f.lane(), '');
});

test('a direct device stack is reused by a direct device run, replaced by a canonical one, and never takes the lock', () => {
	const record = (f, ports) =>
		fs.writeFileSync(
			path.join(f.worktree, '.dev-factory/env.json'),
			JSON.stringify({
				project: 'df-app-1',
				mode: 'device',
				ports,
				...(ports === 'direct' ? { webBaseUrl: 'http://app.df-app-1.orb.local:3000' } : {}),
			}),
		);
	let f = deviceFixture();
	record(f, 'direct');
	let r = f.run('up', '--key', 'APP-1', '--ports', 'direct', '--device');
	assert.match(r.stderr, /ready \(reused, device\): df-app-1/, r.stderr);
	assert.doesNotMatch(f.log(), / up -d| build/);
	assert.equal(f.locked(), false, 'a reused direct device stack takes no lock');
	assert.match(f.lane(), /^up --worktree /m, 'the lane runs again on a reused stack');
	// a canonical device stack is not what a direct device run asked for, and the other way round
	for (const [have, args, want] of [
		['canonical', ['--ports', 'direct', '--device'], 'direct'],
		['direct', ['--device'], 'canonical'],
	]) {
		f = deviceFixture();
		record(f, have);
		r = f.run('up', '--key', 'APP-1', ...args);
		assert.match(r.stderr, /replacing df-app-1/, `${have} -> ${want}: ${r.stderr}`);
		assert.equal(f.record().ports, want);
	}
});

test('taking a direct device stack down leaves a canonical ports lock the same owner holds, and stops the lane', () => {
	const f = deviceFixture();
	assert.equal(f.run('up', '--key', 'APP-1', '--ports', 'direct', '--device').status, 0);
	fs.mkdirSync(path.join(f.state, 'ports.lock'), { recursive: true });
	fs.writeFileSync(path.join(f.state, 'ports.lock/owner'), String(process.pid));
	assert.equal(f.run('down').status, 0);
	assert.equal(f.locked(), true, "the lock is another stack's");
	assert.match(f.lane(), /^down --worktree /m);
});

test('verify of a direct device stack probes the name and the container address, and names the one that fails', () => {
	let f = deviceFixture();
	assert.equal(f.run('up', '--key', 'APP-1', '--ports', 'direct', '--device').status, 0);
	fs.writeFileSync(path.join(f.base, 'curl.log'), '');
	assert.equal(f.run('verify').status, 0);
	assert.match(f.curlLog(), /app\.df-app-1\.orb\.local/);
	assert.match(f.curlLog(), /192\.168\.97\.2/);
	fs.writeFileSync(path.join(f.base, 'curl-answer-ip'), '000');
	const r = f.run('verify');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /container address does not answer: http:\/\/192\.168\.97\.2:3000/);
	assert.doesNotMatch(r.stderr, /direct address does not answer/);
});

test('--ports direct needs environment.webBaseUrl', () => {
	const f = directFixture(withEnv({ webBaseUrl: '' }));
	const r = f.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.equal(r.status, 1, r.stderr);
	assert.match(r.stderr, /--ports direct needs environment\.webBaseUrl \(the address a browser would use, with its port\)/);
	assert.equal(fs.existsSync(path.join(f.worktree, '.dev-factory/compose.override.yml')), false);
	assert.equal(fs.existsSync(path.join(f.worktree, '.dev-factory/env.json')), false);
	// with no environment, up only records that, as before
	const none = directFixture({ environment: { type: 'none' } });
	const n = none.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.equal(n.status, 0, n.stderr);
	assert.equal(none.record().mode, 'none');
});

test('--ports direct refuses a webBaseUrl that is not an http(s) address, before anything is written', () => {
	for (const webBaseUrl of ['ftp://localhost:3000', 'localhost:3000/app']) {
		const f = directFixture(withEnv({ webBaseUrl }));
		const r = f.run('up', '--key', 'APP-1', '--ports', 'direct');
		assert.equal(r.status, 1, `${webBaseUrl}: ${r.stderr}`);
		assert.match(r.stderr, /environment\.webBaseUrl must be an http\(s\) address for --ports direct/, webBaseUrl);
		assert.equal(fs.existsSync(path.join(f.worktree, '.dev-factory/compose.override.yml')), false, webBaseUrl);
		assert.equal(fs.existsSync(path.join(f.worktree, '.dev-factory/env.json')), false, webBaseUrl);
	}
});

test('--ports direct refuses a service name that does not make a host name, naming environment.service and environment.directHost', () => {
	const f = directFixture(withEnv({ service: 'web_app' }));
	const r = f.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.equal(r.status, 1, r.stderr);
	assert.match(r.stderr, /environment\.service \(web_app\)/);
	assert.match(r.stderr, /environment\.directHost \(\{service\}\.\{project\}\.orb\.local\)/);
	assert.match(r.stderr, /makes web_app\.df-app-1\.orb\.local, which is not a valid host name/);
	assert.equal(fs.existsSync(path.join(f.worktree, '.dev-factory/compose.override.yml')), false);
	assert.equal(fs.existsSync(path.join(f.worktree, '.dev-factory/env.json')), false);
	// the web served by another service: its name goes in directHost, and the address is valid again
	const g = directFixture(withEnv({ service: 'web_app', directHost: 'web.{project}.orb.local' }));
	const ok = g.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.equal(ok.status, 0, ok.stderr);
	assert.equal(g.record().webBaseUrl, 'http://web.df-app-1.orb.local:3000');
});

test("a direct start records the stack's own address, strips the published ports, takes no lock and asks the host to probe it", () => {
	const f = directFixture();
	const r = f.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.equal(r.status, 0, r.stderr);
	const rec = f.record();
	assert.equal(rec.mode, 'direct');
	assert.equal(rec.ports, 'direct');
	assert.equal(rec.webBaseUrl, 'http://app.df-app-1.orb.local:3000');
	assert.equal('directProbe' in rec, false, 'the address is the only thing recorded');
	const override = fs.readFileSync(path.join(f.worktree, '.dev-factory/compose.override.yml'), 'utf8');
	assert.ok(override.includes('ports: !reset []'), override);
	assert.match(f.curlLog(), /-w %\{http_code\} http:\/\/app\.df-app-1\.orb\.local:3000(\s|$)/, 'the host probes the web address itself');
	assert.equal(f.locked(), false, 'no ports.lock');
	assert.doesNotMatch(f.log(), /config --format json/, 'no busy-ports check');
});

test('the host probe never uses the pingUrl: neither its query nor DF_PING_URL reaches the output, env.json or the probe', () => {
	const f = directFixture(DIRECT_CFG, { env: { DF_PING_URL: 'http://localhost:3000/health?token=ENVSECRET' } });
	const r = f.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.equal(r.status, 0, r.stderr);
	const text = fs.readFileSync(path.join(f.worktree, '.dev-factory/env.json'), 'utf8');
	assert.doesNotMatch(text, /SECRET|health/, text);
	assert.doesNotMatch(r.stdout + r.stderr, /SECRET/);
	assert.doesNotMatch(f.curlLog(), /SECRET|health/, 'the probe from this machine is the web address, not the ping URL');
	assert.match(f.log(), /sh -c .* ping http:\/\/localhost:3000\/health\?token=ENVSECRET/, 'the ping inside the service still runs');
});

// An image without curl (node:22-alpine) never became ready: the ping uses curl, else wget, else node's fetch, whichever the image has,
// and the address is an argument of the shell, never part of its script.
test('the ping inside the service works with curl, wget or node, and passes the address as an argument', () => {
	const sh = fs.readFileSync(path.join(ROOT, 'scripts/e2e-env.sh'), 'utf8');
	const script = /^PING_SH='(.*)'$/m.exec(sh)?.[1];
	assert.ok(script, 'PING_SH');
	const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'df-ping-'));
	const run = (tools) => {
		for (const t of ['curl', 'wget', 'node']) fs.rmSync(path.join(bin, t), { force: true });
		for (const t of tools) fs.writeFileSync(path.join(bin, t), `#!/bin/sh\necho "${t} $*"\n`, { mode: 0o755 });
		return spawnSync('/bin/sh', ['-c', script, 'ping', 'http://h:1/x?a=1;touch /tmp/no'], {
			encoding: 'utf8',
			env: { PATH: bin },
		}).stdout;
	};
	assert.match(run(['curl', 'wget', 'node']), /^curl -ksf -o \/dev\/null http:\/\/h:1\/x\?a=1;touch \/tmp\/no$/m);
	assert.match(run(['wget', 'node']), /^wget -q -O \/dev\/null http:\/\/h:1\/x/m);
	assert.match(run(['node']), /^node -e .*fetch.* http:\/\/h:1\/x/m);
	assert.doesNotMatch(sh, /curl -ksf -o \/dev\/null "\$PING_URL"/, 'no ping calls curl directly any more');
});

test('the host probe counts any answer below 500 as reachable', () => {
	for (const code of ['200', '302', '401', '404']) {
		const f = directFixture(DIRECT_CFG, { answers: code });
		const r = f.run('up', '--key', 'APP-1', '--ports', 'direct');
		assert.equal(r.status, 0, `${code}: ${r.stderr}`);
	}
});

test('a direct address that does not answer ends up with exit 1 and no lock, naming the engine problem', () => {
	const f = directFixture(DIRECT_CFG, { answers: '000' });
	const r = f.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.equal(r.status, 1, r.stderr);
	assert.match(
		r.stderr,
		/the engine did not make the stack reachable from this machine: http:\/\/app\.df-app-1\.orb\.local:3000 did not answer within 0s/,
	);
	assert.match(r.stderr, /environment\.directHost is \{service\}\.\{project\}\.orb\.local/);
	assert.doesNotMatch(r.stdout + r.stderr, /SECRET/);
	assert.equal(f.locked(), false, 'no ports.lock');
	assert.match(f.log(), /down -v/, 'the stack is taken down');
});

test('a direct address that answers 5xx is reachable but not ready: exit 1, and the message says which', () => {
	for (const code of ['500', '503']) {
		const f = directFixture(DIRECT_CFG, { answers: code });
		const r = f.run('up', '--key', 'APP-1', '--ports', 'direct');
		assert.equal(r.status, 1, `${code}: ${r.stderr}`);
		assert.match(r.stderr, new RegExp(`http://app\\.df-app-1\\.orb\\.local:3000 still answered HTTP ${code} after 0s`), code);
		assert.doesNotMatch(r.stderr, /did not make the stack reachable/, code);
		assert.match(f.log(), /down -v/, code);
	}
});

test('a direct start that fails leaves alone a canonical ports lock the same owner holds', () => {
	const f = directFixture(DIRECT_CFG, { answers: '000' });
	fs.mkdirSync(path.join(f.state, 'ports.lock'));
	fs.writeFileSync(path.join(f.state, 'ports.lock/owner'), `${process.pid}\n`);
	const r = f.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.equal(r.status, 1, r.stderr);
	assert.match(f.log(), /down -v/);
	assert.equal(f.locked(), true, 'the lock of the canonical stack survives');
	// a direct stack's own down leaves it too
	fs.writeFileSync(path.join(f.worktree, '.dev-factory/env.json'), JSON.stringify({ project: 'df-app-1', mode: 'direct' }));
	assert.equal(f.run('down').status, 0);
	assert.equal(f.locked(), true, 'a direct down does not release it');
	// the canonical stack's own down releases it
	fs.writeFileSync(path.join(f.worktree, '.dev-factory/env.json'), JSON.stringify({ project: 'df-app-1', mode: 'canonical' }));
	const down = f.run('down');
	assert.equal(down.status, 0, down.stderr);
	assert.equal(f.locked(), false, 'a canonical down releases its lock');
});

test('environment.directHost changes the address', () => {
	const f = directFixture(withEnv({ directHost: '{project}.stack.test' }));
	const r = f.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.equal(r.status, 0, r.stderr);
	assert.equal(f.record().webBaseUrl, 'http://df-app-1.stack.test:3000');
	assert.match(f.curlLog(), /http:\/\/df-app-1\.stack\.test:3000/);
});

// ---- environment.directEnv: variables for the service of a direct stack, with the stack's own address in them ----

// the override of a direct start whose service is `api`, the one the fake docker lists
const overrideOf = (f) => fs.readFileSync(path.join(f.worktree, '.dev-factory/compose.override.yml'), 'utf8');
const DIRECT_ENV = { REACT_APP_API_ENDPOINT: 'http://{host}:1337', CORS_ORIGIN: '{origin}' };

test("a direct start puts environment.directEnv in the service's override, with {host} and {origin} filled in", () => {
	const f = directFixture(withEnv({ service: 'api', directEnv: DIRECT_ENV }));
	const r = f.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.equal(r.status, 0, r.stderr);
	const o = overrideOf(f);
	assert.match(
		o,
		/ports: !reset \[\]\n {4}environment:\n {6}REACT_APP_API_ENDPOINT: "http:\/\/api\.df-app-1\.orb\.local:1337"\n {6}CORS_ORIGIN: "http:\/\/api\.df-app-1\.orb\.local:3000"\n/,
		o,
	);
	assert.equal(f.record().webBaseUrl, 'http://api.df-app-1.orb.local:3000');
});

test('the same variables reach a direct device stack', () => {
	const f = deviceFixture({ directCfg: withEnv({ service: 'api', directEnv: DIRECT_ENV }) });
	assert.equal(f.run('up', '--key', 'APP-1', '--ports', 'direct', '--device').status, 0);
	assert.match(overrideOf(f), /REACT_APP_API_ENDPOINT: "http:\/\/api\.df-app-1\.orb\.local:1337"/);
});

test('directEnv is for a direct stack only: canonical and isolated starts write no environment block', () => {
	for (const ports of ['canonical', 'none']) {
		const f = directFixture(withEnv({ service: 'api', directEnv: DIRECT_ENV }));
		f.run('up', '--key', 'APP-1', '--ports', ports);
		assert.doesNotMatch(overrideOf(f), /environment:|REACT_APP_API_ENDPOINT/, ports);
	}
	const none = directFixture();
	none.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.doesNotMatch(overrideOf(none), /environment:/, 'nothing configured, nothing written');
});

test('a directEnv value is written as text: $, \\ and " cannot reach compose or the YAML as syntax', () => {
	const f = directFixture(withEnv({ service: 'api', directEnv: { A: 'a$b"c\\d${X}' } }));
	assert.equal(f.run('up', '--key', 'APP-1', '--ports', 'direct').status, 0);
	assert.ok(overrideOf(f).includes('      A: "a$$b\\"c\\\\d$${X}"\n'), overrideOf(f));
});

test('an invalid directEnv stops up before anything is written', () => {
	const f = directFixture(withEnv({ service: 'api', directEnv: { 'bad name': 'x' } }));
	const r = f.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /environment\.directEnv/);
	assert.equal(fs.existsSync(path.join(f.worktree, '.dev-factory/compose.override.yml')), false);
});

test('a url with no port keeps none', () => {
	const f = directFixture(withEnv({ webBaseUrl: 'https://login.app.local' }));
	const r = f.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.equal(r.status, 0, r.stderr);
	assert.equal(f.record().webBaseUrl, 'https://app.df-app-1.orb.local');
	assert.match(f.curlLog(), /https:\/\/app\.df-app-1\.orb\.local(\s|$)/);
});

test('with no pingUrl the probe is still the direct web address', () => {
	const f = directFixture(withEnv({ pingUrl: '' }));
	const r = f.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.equal(r.status, 0, r.stderr);
	assert.equal(f.record().webBaseUrl, 'http://app.df-app-1.orb.local:3000');
	assert.match(f.curlLog(), /http:\/\/app\.df-app-1\.orb\.local:3000/);
});

test('direct stacks still count against the cap: with DF_MAX_STACKS=1 a second direct up for another key is refused', () => {
	const one = directFixture(DIRECT_CFG, { env: { DF_MAX_STACKS: '1' } });
	const two = directFixture(DIRECT_CFG, { state: one.state, env: { DF_MAX_STACKS: '1' } });
	const a = one.run('up', '--key', 'APP-1', '--ports', 'direct');
	assert.equal(a.status, 0, a.stderr);
	const b = two.run('up', '--key', 'APP-2', '--ports', 'direct');
	assert.equal(b.status, 75, b.stderr);
	assert.match(b.stderr, /already live \(cap 1\)/);
	assert.doesNotMatch(two.log(), / up -d| build/, 'nothing was started');
});

test('two direct environments for different keys coexist with no lock', () => {
	const one = directFixture();
	const two = directFixture(DIRECT_CFG, { state: one.state });
	const a = one.run('up', '--key', 'APP-1', '--ports', 'direct');
	const b = two.run('up', '--key', 'APP-2', '--ports', 'direct');
	assert.equal(a.status, 0, a.stderr);
	assert.equal(b.status, 0, b.stderr);
	assert.doesNotMatch(a.stderr + b.stderr, /lock/);
	assert.equal(one.locked(), false, 'neither created ports.lock');
	assert.deepEqual(fs.readdirSync(path.join(one.state, 'live')).sort(), ['df-app-1', 'df-app-2']);
	assert.equal(two.record().webBaseUrl, 'http://app.df-app-2.orb.local:3000');
});

test('verify of a direct stack fails when the address stops answering', () => {
	const f = directFixture();
	assert.equal(f.run('up', '--key', 'APP-1', '--ports', 'direct').status, 0);
	const ok = f.run('verify');
	assert.equal(ok.status, 0, ok.stderr);
	f.answer('404');
	assert.equal(f.run('verify').status, 0, 'a 404 is reachable');
	f.answer(false);
	const bad = f.run('verify');
	assert.equal(bad.status, 1, bad.stderr);
	assert.match(bad.stderr, /direct address does not answer: http:\/\/app\.df-app-1\.orb\.local:3000/);
	assert.doesNotMatch(bad.stderr, /SECRET/);
	f.answer('503');
	const sick = f.run('verify');
	assert.equal(sick.status, 1, sick.stderr);
	assert.match(sick.stderr, /direct address answered HTTP 503: http:\/\/app\.df-app-1\.orb\.local:3000/);
});

test('verify names the ping address by origin and path only: its query, which can carry a token, is never printed', () => {
	const f = directFixture();
	assert.equal(f.run('up', '--key', 'APP-1', '--ports', 'direct').status, 0);
	// the same fake docker, but the ping inside the service fails
	const dockerFile = path.join(f.base, 'bin/docker');
	const failing = fs.readFileSync(dockerFile, 'utf8').replace('  *"compose ls"*)', '  *"curl -ksf"*) exit 22 ;;\n  *"compose ls"*)');
	assert.notEqual(failing, fs.readFileSync(dockerFile, 'utf8'), 'the fake docker was changed');
	fs.writeFileSync(dockerFile, failing, { mode: 0o755 });
	const bad = f.run('verify');
	assert.equal(bad.status, 1, bad.stderr);
	assert.match(bad.stderr, /ping failed: http:\/\/localhost:3000\/api\/health(\s|$)/, bad.stderr);
	assert.doesNotMatch(bad.stdout + bad.stderr, /SECRET|token/);
});

test('verify of a direct stack works out the address from the settings and never probes one read back from env.json', () => {
	const f = directFixture();
	assert.equal(f.run('up', '--key', 'APP-1', '--ports', 'direct').status, 0);
	const file = path.join(f.worktree, '.dev-factory/env.json');
	const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
	fs.writeFileSync(file, JSON.stringify({ ...rec, webBaseUrl: 'http://elsewhere.test:9/', directProbe: 'http://elsewhere.test:9/x' }));
	fs.writeFileSync(path.join(f.base, 'curl.log'), '');
	const v = f.run('verify');
	assert.equal(v.status, 0, v.stderr);
	assert.doesNotMatch(f.curlLog(), /elsewhere/);
	assert.match(f.curlLog(), /http:\/\/app\.df-app-1\.orb\.local:3000/);
	// a recorded project that this script cannot have made is not turned into an address
	fs.writeFileSync(file, JSON.stringify({ ...rec, project: 'df-app;x' }));
	fs.writeFileSync(path.join(f.base, 'curl.log'), '');
	const bad = f.run('verify');
	assert.equal(bad.status, 1, bad.stderr);
	assert.equal(f.curlLog(), '', 'nothing was probed');
});

test('reuse order: isolated < direct < canonical < device', () => {
	const record = (f, mode) =>
		fs.writeFileSync(
			path.join(f.worktree, '.dev-factory/env.json'),
			JSON.stringify({
				project: 'df-app-1',
				key: 'APP-1',
				worktree: f.worktree,
				mode,
				...(mode === 'direct' ? { webBaseUrl: 'http://app.df-app-1.orb.local:3000' } : {}),
			}),
		);
	// replaced: isolated -> direct, direct -> canonical, direct -> device
	for (const [have, args, mode] of [
		['isolated', ['--ports', 'direct'], 'direct'],
		['direct', ['--ports', 'canonical'], 'canonical'],
		['direct', ['--device'], null],
	]) {
		const f = directFixture();
		record(f, have);
		const r = f.run('up', '--key', 'APP-1', ...args);
		assert.match(r.stderr, /replacing df-app-1/, `${have} -> ${args.join(' ')}: ${r.stderr}`);
		assert.ok(f.log().indexOf('down -v') >= 0 && f.log().indexOf('down -v') < f.log().indexOf(' up -d'), 'taken down before the new start');
		if (mode) assert.equal(f.record().mode, mode);
	}
	// reused: direct -> direct, direct -> isolated; and no lock is written for a reused direct stack
	for (const ports of ['direct', 'none']) {
		const f = directFixture();
		record(f, 'direct');
		const r = f.run('up', '--key', 'APP-1', '--ports', ports);
		assert.match(r.stderr, /ready \(reused, direct\): df-app-1/, `direct -> ${ports}: ${r.stderr}`);
		assert.doesNotMatch(f.log(), / up -d| build/);
		assert.equal(f.locked(), false, `direct -> ${ports}: no ports.lock`);
	}
});

// ---- values are data, not code ----

test('down removes only a project this script started: env.json is written by the run and is not trusted to name one', () => {
	const f = fixture({ environment: { type: 'compose', composeFile: '.devcontainer/docker-compose.yml', service: 'app' } });
	for (const project of ['myapp-prod', 'df-', 'df-A b', 'DF-app-1', 'df-app;rm', '$(touch x)']) {
		fs.writeFileSync(path.join(f.worktree, '.dev-factory/env.json'), JSON.stringify({ project, mode: 'isolated' }));
		const r = f.run('down');
		assert.equal(r.status, 1, `${project}: ${r.stderr}`);
		assert.match(r.stderr, /refusing to take down/);
	}
	assert.doesNotMatch(f.log(), /down -v/, 'docker was never asked to remove anything');
	assert.ok(fs.existsSync(path.join(f.worktree, '.dev-factory/env.json')), 'and the record is left for a person to look at');
	fs.writeFileSync(path.join(f.worktree, '.dev-factory/env.json'), JSON.stringify({ project: 'df-app-1', mode: 'isolated' }));
	assert.equal(f.run('down').status, 0, 'its own project goes');
	assert.match(f.log(), /-p df-app-1 down -v/);
});

test('a setting or a path with a quote in it is recorded as text and never runs', () => {
	const evil = "http://x/'+require('fs').writeFileSync('PWNED-SETTING','x')+'";
	const f = fixture({ environment: { type: 'none', webBaseUrl: evil } });
	const r = f.run('up', '--key', 'APP-1');
	assert.equal(r.status, 0, r.stderr);
	assert.equal(JSON.parse(fs.readFileSync(path.join(f.worktree, '.dev-factory/env.json'), 'utf8')).webBaseUrl, evil);
	assert.equal(fs.existsSync(path.join(f.worktree, 'PWNED-SETTING')), false);
	assert.equal(fs.existsSync(path.join(process.cwd(), 'PWNED-SETTING')), false);
	// a worktree whose folder name holds a quote
	const g = fixture({ environment: { type: 'none' } });
	const odd = path.join(g.base, "it's a wt");
	fs.mkdirSync(path.join(odd, '.dev-factory'), { recursive: true });
	fs.writeFileSync(path.join(odd, 'dev-factory.config.json'), JSON.stringify({ environment: { type: 'none' } }));
	const r2 = spawnSync('bash', [SCRIPT, 'up', '--key', 'APP-1', '--worktree', odd], {
		env: { ...process.env, DF_STATE_DIR: g.state },
		encoding: 'utf8',
		cwd: odd,
	});
	assert.equal(r2.status, 0, r2.stderr);
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(odd, '.dev-factory/env.json'), 'utf8')).worktree.replace(/^\/private/, ''),
		fs.realpathSync(odd).replace(/^\/private/, ''),
	);
	const v = spawnSync('bash', [SCRIPT, 'verify', '--worktree', odd], {
		env: { ...process.env, DF_STATE_DIR: g.state },
		encoding: 'utf8',
		cwd: odd,
	});
	assert.equal(v.status, 0, v.stderr);
});

// ---- remote QA ----

function remoteFixture({ answer = '200', accounts = ['reviewer', 'admin'], extra = {} } = {}) {
	const f = fixture({
		environments: {
			dev: { source: 'local', sentry: null, axiomDatasets: [] },
			staging: { remote: { url: 'https://staging.example.test/app', accounts, defaultAccount: 'reviewer' } },
		},
		...extra,
	});
	fs.writeFileSync(path.join(f.base, 'bin/curl'), `#!/bin/bash\necho "curl $@" >> "${f.base}/curl.log"\nprintf '${answer}'\n`, { mode: 0o755 });
	const env = (more = {}) => ({
		...process.env,
		PATH: `${path.join(f.base, 'bin')}:${process.env.PATH}`,
		DF_STATE_DIR: f.state,
		DF_OWNER_PID: String(process.pid),
		DF_REMOTE_STAGING_REVIEWER_USER: 'qa-reviewer@example.test',
		DF_REMOTE_STAGING_REVIEWER_PASSWORD: 'correct-horse-battery',
		...more,
	});
	const run = (args, more) => spawnSync('bash', [SCRIPT, ...args], { env: env(more), encoding: 'utf8', cwd: f.worktree });
	const record = () => JSON.parse(fs.readFileSync(path.join(f.worktree, '.dev-factory/env.json'), 'utf8'));
	return { ...f, run, record };
}

test('up --remote checks that the deployed address answers and records the environment with the names of the account variables, never their values', () => {
	const f = remoteFixture();
	const r = f.run(['up', '--key', 'APP-1', '--remote', 'staging']);
	assert.equal(r.status, 0, r.stderr);
	const rec = f.record();
	assert.equal(rec.mode, 'remote');
	assert.equal(rec.project, '');
	assert.equal(rec.webBaseUrl, 'https://staging.example.test/app');
	assert.deepEqual(rec.hosts, ['staging.example.test']);
	assert.deepEqual(rec.remote, {
		env: 'staging',
		url: 'https://staging.example.test/app',
		account: 'reviewer',
		userVar: 'DF_REMOTE_STAGING_REVIEWER_USER',
		passwordVar: 'DF_REMOTE_STAGING_REVIEWER_PASSWORD',
	});
	assert.deepEqual(rec.secretEnv, ['DF_REMOTE_STAGING_REVIEWER_PASSWORD'], 'so kept evidence is redacted of the password');
	const text = fs.readFileSync(path.join(f.worktree, '.dev-factory/env.json'), 'utf8');
	assert.doesNotMatch(text, /correct-horse-battery|qa-reviewer@example/, 'no value is written');
	assert.doesNotMatch(r.stdout + r.stderr, /correct-horse-battery|qa-reviewer@example/, 'and none is printed');
	assert.match(fs.readFileSync(path.join(f.base, 'curl.log'), 'utf8'), /https:\/\/staging\.example\.test\/app/);
	assert.equal(f.log(), '', 'a remote environment starts no stack');
});

test('another account is chosen with --account, and an account the settings do not list is refused', () => {
	const f = remoteFixture();
	const admin = f.run(['up', '--key', 'APP-1', '--remote', 'staging', '--account', 'admin'], {
		DF_REMOTE_STAGING_ADMIN_USER: 'root-qa',
		DF_REMOTE_STAGING_ADMIN_PASSWORD: 'another-secret-pw',
	});
	assert.equal(admin.status, 0, admin.stderr);
	assert.equal(f.record().remote.passwordVar, 'DF_REMOTE_STAGING_ADMIN_PASSWORD');
	const unknown = f.run(['up', '--key', 'APP-1', '--remote', 'staging', '--account', 'intern']);
	assert.equal(unknown.status, 1);
	assert.match(unknown.stderr, /intern is not one of environments\.staging\.remote\.accounts/);
});

test('up --remote refuses what it cannot rely on, naming variables and never values', () => {
	const f = remoteFixture();
	const missing = f.run(['up', '--key', 'APP-1', '--remote', 'staging', '--account', 'admin']);
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /DF_REMOTE_STAGING_ADMIN_USER and DF_REMOTE_STAGING_ADMIN_PASSWORD/);
	const unset = f.run(['up', '--key', 'APP-1', '--remote', 'staging'], { DF_REMOTE_STAGING_REVIEWER_PASSWORD: '' });
	assert.equal(unset.status, 1);
	assert.match(unset.stderr, /DF_REMOTE_STAGING_REVIEWER_PASSWORD/);
	assert.doesNotMatch(unset.stderr, /qa-reviewer@example/);
	const nope = f.run(['up', '--key', 'APP-1', '--remote', 'nowhere']);
	assert.equal(nope.status, 1);
	assert.match(nope.stderr, /no remote environment called nowhere/);
	for (const bad of ['a b', 'x;rm', '$(x)', '../x']) assert.equal(f.run(['up', '--key', 'APP-1', '--remote', bad]).status, 1, bad);
	assert.equal(f.run(['up', '--key', 'APP-1', '--account', 'reviewer']).status, 1, 'an account needs a remote environment');
	const down = remoteFixture({ answer: '503' });
	const r = down.run(['up', '--key', 'APP-1', '--remote', 'staging']);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /does not answer/);
	assert.equal(fs.existsSync(path.join(down.worktree, '.dev-factory/env.json')), false, 'nothing is recorded for an environment that is down');
	for (const code of ['000', '502'])
		assert.equal(remoteFixture({ answer: code }).run(['up', '--key', 'APP-1', '--remote', 'staging']).status, 1, code);
	for (const code of ['200', '301', '401', '403'])
		assert.equal(remoteFixture({ answer: code }).run(['up', '--key', 'APP-1', '--remote', 'staging']).status, 0, code);
});

test('verify pings the recorded address again, and down only forgets the record', () => {
	const f = remoteFixture();
	f.run(['up', '--key', 'APP-1', '--remote', 'staging']);
	const v = f.run(['verify']);
	assert.equal(v.status, 0, v.stderr);
	assert.match(v.stderr, /verify ok: remote staging/);
	assert.ok(f.record().verifiedAt);
	fs.writeFileSync(path.join(f.base, 'bin/curl'), `#!/bin/bash\nprintf '503'\n`, { mode: 0o755 });
	const bad = f.run(['verify']);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /verify FAILED for the remote environment staging/);
	const down = f.run(['down']);
	assert.equal(down.status, 0, down.stderr);
	assert.equal(fs.existsSync(path.join(f.worktree, '.dev-factory/env.json')), false);
	assert.equal(f.log(), '', 'docker was never touched');
});

test('the remote settings are validated', async () => {
	const { load, merge, validate } = await import('../scripts/config.mjs');
	const with_ = (remote, name = 'staging') => merge(load(), { environments: { [name]: { remote } } });
	assert.deepEqual(validate(with_({ url: 'https://staging.example.test', accounts: ['reviewer'], defaultAccount: 'reviewer' })), []);
	for (const [remote, re] of [
		[{ url: 'ftp://x' }, /remote\.url/],
		[{ url: 'https://user:pw@x.test' }, /remote\.url/],
		[{ url: 'https://x.test', accounts: ['a b'] }, /accounts/],
		[{ url: 'https://x.test', accounts: ['a'], defaultAccount: 'b' }, /defaultAccount/],
		['https://x.test', /must be an object/],
	])
		assert.match(validate(with_(remote)).join('\n'), re, JSON.stringify(remote));
	assert.match(validate(with_({ url: 'https://x.test' }, 'bad name')).join('\n'), /environment name/);
});

test('a remote address with a user or password in it is refused, and what is logged is the origin and path, not the query', () => {
	for (const bad of [
		'https://qa:SECRETPW@staging.example.test/app',
		'https://:SECRETPW@staging.example.test',
		'ftp://staging.example.test',
		'staging.example.test/app',
	]) {
		const f = remoteFixture();
		fs.writeFileSync(
			path.join(f.worktree, 'dev-factory.config.json'),
			JSON.stringify({ environments: { staging: { remote: { url: bad, accounts: ['reviewer'] } } } }),
		);
		const r = f.run(['up', '--key', 'APP-1', '--remote', 'staging']);
		assert.equal(r.status, 1, bad);
		assert.match(r.stderr, /http\(s\) address with no user or password/);
		assert.doesNotMatch(r.stdout + r.stderr, /SECRETPW/, 'and the secret is not echoed back');
		assert.equal(fs.existsSync(path.join(f.worktree, '.dev-factory/env.json')), false);
	}
	const ok = remoteFixture();
	fs.writeFileSync(
		path.join(ok.worktree, 'dev-factory.config.json'),
		JSON.stringify({
			environments: { staging: { remote: { url: 'https://staging.example.test/app?token=QUERYSECRET', accounts: ['reviewer'] } } },
		}),
	);
	const r = ok.run(['up', '--key', 'APP-1', '--remote', 'staging']);
	assert.equal(r.status, 0, r.stderr);
	assert.doesNotMatch(r.stderr, /QUERYSECRET/, 'the log names the address without its query');
});

test('up seals the build files a setup step rewrote, and leaves alone a file the ticket had already edited', () => {
	const f = fixture({
		environment: {
			type: 'compose',
			composeFile: '.devcontainer/docker-compose.yml',
			service: 'app',
			setup: ['npm ci'],
			buildFiles: ['package-lock.json', 'yarn.lock'],
		},
	});
	const git = (...a) => spawnSync('git', ['-C', f.worktree, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
	fs.writeFileSync(path.join(f.worktree, 'package-lock.json'), 'one\n');
	fs.writeFileSync(path.join(f.worktree, 'yarn.lock'), 'one\n');
	fs.writeFileSync(path.join(f.worktree, '.gitignore'), '.dev-factory/\n');
	git('init', '-q');
	git('add', '-A');
	git('commit', '-qm', 'init');
	// the ticket's own edit, made before the environment came up (an adopted worktree)
	fs.writeFileSync(path.join(f.worktree, 'yarn.lock'), 'the ticket changed this\n');
	// the setup step rewrites the lockfile
	fs.writeFileSync(
		path.join(f.base, 'bin/docker'),
		`#!/bin/bash
echo "$@" >> "${f.base}/docker.log"
case "$*" in
  *"compose ls"*) echo '[{"Name":"df-app-1"}]' ;;
  *"config --services"*) echo app ;;
  *"ps -aq"*) echo c1 ;;
  *" exec "*) echo "refreshed" >> "${f.worktree}/package-lock.json"; exit 0 ;;
  *" build"*|*" up -d"*) exit 0 ;;
  *) exit 1 ;;
esac
`,
		{ mode: 0o755 },
	);
	f.run('up', '--key', 'APP-1');
	const sealed = JSON.parse(fs.readFileSync(path.join(f.worktree, '.dev-factory/env-sealed.json'), 'utf8'));
	assert.deepEqual(Object.keys(sealed), ['package-lock.json'], 'the environment’s rewrite is sealed, the ticket’s edit is not');
});
