import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const SCRIPT = new URL('../scripts/e2e-env.sh', import.meta.url).pathname;

// A fake docker that records every call; `compose ls` lists one df-* project and `config --services` one service.
function fixture() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'df-e2e-'));
	const bin = path.join(base, 'bin');
	const state = path.join(base, 'state');
	const worktree = path.join(base, 'wt');
	for (const d of [bin, state, path.join(worktree, '.devcontainer'), path.join(worktree, '.dev-factory'), path.join(state, 'live')])
		fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(path.join(worktree, '.devcontainer/docker-compose.yml'), 'services: {}\n');
	fs.writeFileSync(path.join(worktree, '.dev-factory/run.json'), '{}');
	fs.writeFileSync(
		path.join(bin, 'docker'),
		`#!/bin/bash
echo "$@" >> "${base}/docker.log"
case "$*" in
  *"compose ls"*) echo '[{"Name":"df-oapp-1"}]' ;;
  *"config --services"*) echo api ;;
  *"ps -aq"*) echo c1 ;;
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
	const r = f.run('up', '--key', 'OAPP-1', '--ports', 'bogus');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /--ports must be canonical or none/);
});

test('the compose override strips host ports only for --ports none', () => {
	for (const [ports, strips] of [
		['none', true],
		['canonical', false],
	]) {
		const f = fixture();
		f.run('up', '--key', 'OAPP-1', '--ports', ports); // fails at compose build on the fake docker; the override is already written
		const override = fs.readFileSync(path.join(f.worktree, '.dev-factory/compose.override.yml'), 'utf8');
		assert.equal(override.includes('ports: !reset []'), strips, ports);
		assert.match(override, /dev-factory: "1"/);
		const env = JSON.parse(fs.readFileSync(path.join(f.worktree, '.dev-factory/env.json'), 'utf8'));
		assert.equal(env.ports, ports);
		assert.equal(env.webBaseUrl, ports === 'canonical' ? 'https://login.olarm.local' : '');
	}
});

test('sweep removes an orphan stack but spares one whose worktree is still being worked on', () => {
	const old = fixture();
	fs.writeFileSync(path.join(old.state, 'live/df-oapp-1'), `99999999\n${old.worktree}\n`);
	const past = new Date(Date.now() - 6 * 3600_000);
	fs.utimesSync(path.join(old.worktree, '.dev-factory/run.json'), past, past);
	old.run('sweep');
	assert.match(old.log(), /ps -aq --filter label=com.docker.compose.project=df-oapp-1/);

	const fresh = fixture();
	fs.writeFileSync(path.join(fresh.state, 'live/df-oapp-1'), `99999999\n${fresh.worktree}\n`);
	fresh.run('sweep');
	assert.doesNotMatch(fresh.log(), /ps -aq/);

	const gone = fixture();
	fs.writeFileSync(path.join(gone.state, 'live/df-oapp-1'), `99999999\n${gone.worktree}-missing\n`);
	gone.run('sweep');
	assert.match(gone.log(), /ps -aq/);
});

test('up refuses a key that is not a Jira key, since it reaches node -e snippets', () => {
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
