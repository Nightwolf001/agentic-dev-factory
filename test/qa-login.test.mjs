import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const SCRIPT = path.resolve(import.meta.dirname, '../scripts/qa-login.sh');
const PASSWORD = 'correct-horse-battery';
const USER = 'qa-reviewer-account';

function fixture({ remote = true, maestroExit = 0 } = {}) {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-login-')));
	const wt = path.join(home, 'wt');
	const bin = path.join(home, 'bin');
	fs.mkdirSync(path.join(wt, '.dev-factory'), { recursive: true });
	fs.mkdirSync(bin);
	fs.writeFileSync(
		path.join(wt, '.dev-factory/env.json'),
		JSON.stringify({
			mode: 'remote',
			device: { platform: 'ios', udid: 'UDID-1' },
			...(remote
				? { remote: { env: 'staging', userVar: 'DF_REMOTE_STAGING_REVIEWER_USER', passwordVar: 'DF_REMOTE_STAGING_REVIEWER_PASSWORD' } }
				: {}),
		}),
	);
	// a Maestro that records its arguments and its environment, and echoes what it was given the way a verbose run does
	fs.writeFileSync(
		path.join(bin, 'maestro'),
		`#!/bin/bash
echo "ARGV: $*" > "${home}/argv.txt"
env | grep '^MAESTRO_' > "${home}/maestro-env.txt"
echo "Running flow $4"
echo "Input text $MAESTRO_QA_USER"
echo "Input text $MAESTRO_QA_PASSWORD"
exit ${maestroExit}`,
		{ mode: 0o755 },
	);
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		HOME: home,
		DF_STATE_DIR: path.join(home, 'state'),
		DF_REMOTE_STAGING_REVIEWER_USER: USER,
		DF_REMOTE_STAGING_REVIEWER_PASSWORD: PASSWORD,
		DF_APP_ID: 'com.example.app',
	};
	const run = (args = [], more = {}) =>
		spawnSync('bash', [SCRIPT, '--worktree', wt, ...args], { encoding: 'utf8', env: { ...env, ...more }, cwd: wt });
	return {
		home,
		wt,
		run,
		argv: () => fs.readFileSync(path.join(home, 'argv.txt'), 'utf8'),
		menv: () => fs.readFileSync(path.join(home, 'maestro-env.txt'), 'utf8'),
	};
}

test('the password reaches Maestro through its environment only, and neither the output nor the log shows it', () => {
	const f = fixture();
	const r = f.run();
	assert.equal(r.status, 0, r.stderr);
	assert.doesNotMatch(f.argv(), new RegExp(`${PASSWORD}|${USER}`), 'not an argument, where ps would show it');
	assert.match(f.argv(), /--device UDID-1 test .*qa\/maestro\/login\.yaml/);
	assert.match(f.menv(), new RegExp(`MAESTRO_QA_PASSWORD=${PASSWORD}`));
	assert.match(f.menv(), new RegExp(`MAESTRO_QA_USER=${USER}`));
	assert.match(f.menv(), /MAESTRO_APP_ID=com\.example\.app/);
	assert.match(f.menv(), /MAESTRO_LOGIN_USER_FIELD=qa-login-username/, 'the element ids are the mobile.login settings');
	assert.match(f.menv(), /MAESTRO_LOGIN_SUCCESS=qa-login-success/);
	for (const out of [r.stdout, r.stderr, fs.readFileSync(path.join(f.wt, '.dev-factory/qa-login.log'), 'utf8')]) {
		assert.doesNotMatch(out, new RegExp(`${PASSWORD}|${USER}`));
	}
	assert.match(r.stdout, /Input text \*\*\*/);
	assert.match(r.stderr, /signed in as the QA account \(DF_REMOTE_STAGING_REVIEWER_USER\)/, 'the variable name, not its value');
});

test('the element ids can be overridden, and a failed flow is reported with the masked log', () => {
	const f = fixture();
	assert.equal(f.run([], { MAESTRO_LOGIN_SUBMIT: 'btn-sign-in' }).status, 0);
	assert.match(f.menv(), /MAESTRO_LOGIN_SUBMIT=btn-sign-in/);
	const bad = fixture({ maestroExit: 3 });
	const r = bad.run();
	assert.equal(r.status, 1);
	assert.match(r.stderr, /the login flow failed \(exit 3\)/);
	assert.doesNotMatch(r.stdout + r.stderr, new RegExp(PASSWORD));
});

test('it refuses to run when it is not set up, and says what is missing by name', () => {
	const f = fixture();
	let r = f.run([], { DF_REMOTE_STAGING_REVIEWER_PASSWORD: '' });
	assert.equal(r.status, 2);
	assert.match(r.stderr, /DF_REMOTE_STAGING_REVIEWER_USER and DF_REMOTE_STAGING_REVIEWER_PASSWORD are not both set/);
	assert.doesNotMatch(r.stderr, new RegExp(USER));
	r = f.run([], { DF_APP_ID: '' });
	assert.equal(r.status, 2);
	assert.match(r.stderr, /no app id/);
	r = fixture({ remote: false }).run();
	assert.equal(r.status, 2);
	assert.match(r.stderr, /no QA account/);
	assert.equal(f.run(['--bogus']).status, 2);
	fs.rmSync(path.join(f.wt, '.dev-factory/env.json'));
	assert.equal(f.run().status, 2);
	// a recorded name that is not a variable name is never used as one
	const g = fixture();
	const env = JSON.parse(fs.readFileSync(path.join(g.wt, '.dev-factory/env.json'), 'utf8'));
	env.remote.passwordVar = 'X; touch /tmp/pwned';
	fs.writeFileSync(path.join(g.wt, '.dev-factory/env.json'), JSON.stringify(env));
	const bad = g.run();
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /not DF_REMOTE_/);
});

test('the Maestro flows are shipped, take their ids from the environment and keep the account out of the file', () => {
	const dir = path.resolve(import.meta.dirname, '../qa/maestro');
	const login = fs.readFileSync(path.join(dir, 'login.yaml'), 'utf8');
	const dismiss = fs.readFileSync(path.join(dir, 'dismiss-system-dialogs.yaml'), 'utf8');
	for (const v of [
		'MAESTRO_APP_ID',
		'MAESTRO_QA_USER',
		'MAESTRO_QA_PASSWORD',
		'MAESTRO_LOGIN_USER_FIELD',
		'MAESTRO_LOGIN_PASSWORD_FIELD',
		'MAESTRO_LOGIN_SUBMIT',
		'MAESTRO_LOGIN_SUCCESS',
	])
		assert.match(login, new RegExp(`\\$\\{${v}\\}`), v);
	assert.match(login, /runFlow: dismiss-system-dialogs\.yaml/);
	assert.match(dismiss, /Not Now/);
	assert.match(dismiss, /appId: \$\{MAESTRO_APP_ID\}/);
	assert.doesNotMatch(login + dismiss, /My Devices|olarm/i);
});

test('only the QA account variables e2e-env.sh names can be read: a forged record cannot point it at another secret', () => {
	const f = fixture();
	const env = JSON.parse(fs.readFileSync(path.join(f.wt, '.dev-factory/env.json'), 'utf8'));
	for (const bad of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'JIRA_API_TOKEN', 'DF_REMOTE_staging_USER', 'DF_REMOTE_X', 'HOME']) {
		fs.writeFileSync(path.join(f.wt, '.dev-factory/env.json'), JSON.stringify({ ...env, remote: { ...env.remote, passwordVar: bad } }));
		const r = f.run([], { ANTHROPIC_API_KEY: 'sk-secret', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret', JIRA_API_TOKEN: 'jira-secret' });
		assert.equal(r.status, 2, bad);
		assert.match(r.stderr, /not DF_REMOTE_<ENV>_<ACCOUNT>_USER and _PASSWORD/);
		assert.doesNotMatch(r.stdout + r.stderr, /sk-secret|oauth-secret|jira-secret/);
	}
});
