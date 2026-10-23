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
