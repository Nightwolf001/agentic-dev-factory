import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const SCRIPT = new URL('../scripts/e2e-env.sh', import.meta.url).pathname;

// A fake docker that records every call; `compose ls` lists one df-* project and `config --services` one service.
function fixture(config = {}) {
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
  *"ps -aq"*) echo c1 ;;
  *" build"*|*" up -d"*|*" exec "*) exit 0 ;;
  *) exit 1 ;;
esac
`,
		{ mode: 0o755 },
	);
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DF_STATE_DIR: state, DF_OWNER_PID: String(process.pid) };
	const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8', cwd: worktree });
	const log = () => (fs.existsSync(path.join(base, 'docker.log')) ? fs.readFileSync(path.join(base, 'docker.log'), 'utf8') : '');
	return { base, state, worktree, run, log };
}

test('up rejects an unknown --ports value', () => {
	const f = fixture();
	const r = f.run('up', '--key', 'APP-1', '--ports', 'bogus');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /--ports must be canonical or none/);
});

test('the compose override strips host ports only for --ports none', () => {
	for (const [ports, strips] of [
		['none', true],
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
		assert.equal(env.webBaseUrl, ports === 'canonical' ? 'https://login.app.local' : '');
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
		assert.match(r.stderr, /ready \(reused\)/, `${have} -> ${ports}: ${r.stderr}`);
		assert.doesNotMatch(f.log(), / up -d| build/);
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
