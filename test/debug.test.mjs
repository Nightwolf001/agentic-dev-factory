import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DebugError, block, fingerprint, listRecords, open, record, runLoop, status } from '../scripts/debug-lib.mjs';

const QA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'qa.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'df-debug-'));
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof DebugError && re.test(e.message));
const OUT = 'Error: connect ECONNREFUSED 10.0.0.5:3306\n  at x';
const cause = 'The api pool is exhausted because the worker holds a connection open across the retry loop.';
const ev = [{ kind: 'log', ref: 'pm2 api id 2', summary: 'ECONNREFUSED count 14 in last 200 lines' }];

test('fingerprint ignores numbers, hex and quoted values', () => {
	const a = fingerprint('npm test', 'Error: timeout after 3000ms on "abc"\nFAIL x');
	const b = fingerprint('npm test', 'Error: timeout after 9100ms on "zzz"\nFAIL x');
	assert.equal(a, b);
	assert.notEqual(a, fingerprint('npm run lint', 'Error: timeout after 3000ms on "abc"\nFAIL x'));
});

test('open enforces rounds and repeated fingerprints, validate is exempt', () => {
	const root = tmp();
	open({ root, trigger: 'triage', command: 'npm test', output: OUT, caps: { maxDebugRounds: 2 } });
	refused(() => open({ root, trigger: 'unstick', command: 'npm test', output: OUT, caps: { maxDebugRounds: 2 } }), /already investigated/);
	open({ root, trigger: 'unstick', command: 'npm test', output: 'Error: other thing', caps: { maxDebugRounds: 2 } });
	refused(() => open({ root, trigger: 'unstick', command: 'npm run x', output: 'Error: third', caps: { maxDebugRounds: 2 } }), /budget spent/);
	open({ root, trigger: 'validate', command: 'sentry count', caps: { maxDebugRounds: 2 } });
	assert.equal(status(root, { maxDebugRounds: 2 }).rounds, 2);
	assert.equal(status(root, { maxDebugRounds: 2 }).budgetLeft, 0);
	assert.deepEqual(status(root).openAll, [1, 2, 3]);
});

test('record needs a loop that was run, a real root cause and evidence', () => {
	const root = tmp();
	const rec = open({ root, trigger: 'triage', command: 'curl x', output: OUT });
	refused(() => record({ root, id: rec.id, loop: 'echo hi', rootCause: cause, evidence: ev, fixPlan: 'fix' }), /run through qa\.mjs debug run/);
	const r = runLoop({ root, id: rec.id, command: 'echo ok' });
	assert.equal(r.exitCode, 0);
	refused(() => record({ root, id: rec.id, loop: 'echo ok', rootCause: 'too short', evidence: ev, fixPlan: 'fix' }), /at least 40/);
	refused(() => record({ root, id: rec.id, loop: 'echo ok', rootCause: cause, evidence: [], fixPlan: 'fix' }), /at least one evidence/);
	refused(
		() => record({ root, id: rec.id, loop: 'echo ok', rootCause: cause, evidence: [{ kind: 'guess', ref: 'x', summary: 'y' }], fixPlan: 'fix' }),
		/kind/,
	);
	refused(
		() =>
			record({
				root,
				id: rec.id,
				loop: 'echo ok',
				rootCause: cause,
				evidence: [{ kind: 'sentry', ref: 'ISSUE-1', summary: 'user jane@example.com saw it' }],
				fixPlan: 'fix',
			}),
		/raw data/,
	);
	const done = record({
		root,
		id: rec.id,
		loop: 'echo ok',
		rootCause: cause,
		evidence: ev,
		fixPlan: 'bound the retry',
		validationPlan: 'Sentry count falls',
	});
	assert.equal(done.status, 'recorded');
	assert.equal(done.loop.exitCode, 0);
	assert.equal(status(root).hasRootCause, true);
	refused(() => record({ root, id: rec.id, loop: 'echo ok', rootCause: cause, evidence: ev, fixPlan: 'x' }), /already recorded/);
});

test('record refuses a round past its minutes', () => {
	const root = tmp();
	const rec = open({ root, trigger: 'triage', command: 'curl x', output: OUT, now: Date.now() - 3600_000 });
	runLoop({ root, id: rec.id, command: 'echo ok' });
	refused(
		() => record({ root, id: rec.id, loop: 'echo ok', rootCause: cause, evidence: ev, fixPlan: 'f', caps: { debugMinutes: 20 } }),
		/past its 20 minute/,
	);
});

test('debug run applies the debugger shell rules', () => {
	const root = tmp();
	const rec = open({ root, trigger: 'triage', command: 'curl x', output: OUT });
	refused(() => runLoop({ root, id: rec.id, command: 'npm install' }), /guard/);
	refused(() => runLoop({ root, id: rec.id, command: 'echo x > f.txt' }), /guard/);
});

test('block writes blocked.json and listRecords is ordered', () => {
	const root = tmp();
	open({ root, trigger: 'triage', command: 'a', output: 'Error: one' });
	open({ root, trigger: 'unstick', command: 'b', output: 'Error: two' });
	assert.deepEqual(
		listRecords(root).map((r) => r.id),
		[1, 2],
	);
	block({ root, reason: 'cannot reproduce' });
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.dev-factory/blocked.json'), 'utf8')).reason, 'cannot reproduce');
});

test('the CLI passes the command after -- through', () => {
	const root = tmp();
	execFileSync('git', ['init', '-q'], { cwd: root });
	const run = (...a) => JSON.parse(execFileSync('node', [QA, ...a], { cwd: root, encoding: 'utf8' }));
	fs.mkdirSync(path.join(root, '.dev-factory'));
	fs.writeFileSync(path.join(root, '.dev-factory/run.json'), JSON.stringify({ key: 'APP-1', role: 'debugger' }));
	run('debug', 'open', '--trigger', 'triage', '--command', 'curl x');
	assert.equal(run('debug', 'run', '--id', '1', '--', 'echo', 'hello').exitCode, 0);
	assert.equal(run('debug', 'status').rounds, 1);
});

test('debug run refuses an awk program or a substitution before anything is spawned', () => {
	const root = tmp();
	const rec = open({ root, trigger: 'triage', command: 'curl x', output: OUT });
	const marker = path.join(root, 'ran');
	for (const command of [
		`awk 'BEGIN{system("touch ${marker}")}'`,
		`echo $(touch ${marker})`,
		`echo \`touch ${marker}\``,
		`curl -s https://api.app.local/$(touch ${marker})`,
		`cat dev-factory/.env.local`,
	])
		refused(() => runLoop({ root, id: rec.id, command }), /dev-factory guard/);
	assert.equal(fs.existsSync(marker), false);
	assert.equal(listRecords(root)[0].loops.length, 0);
});

test('only the debugger the scheduler dispatched opens, runs, records or blocks a debug round; anyone may read status', () => {
	const root = tmp();
	execFileSync('git', ['init', '-q'], { cwd: root });
	const cli = (...a) =>
		spawnSync('node', [QA, ...a], { cwd: root, encoding: 'utf8', env: { ...process.env, DF_STATE_DIR: path.join(root, 'state') } });
	const setRole = (role) => {
		fs.mkdirSync(path.join(root, '.dev-factory'), { recursive: true });
		fs.writeFileSync(path.join(root, '.dev-factory/run.json'), JSON.stringify({ key: 'APP-1', role }));
	};
	const writes = [
		['debug', 'open', '--trigger', 'triage', '--command', 'curl x'],
		['debug', 'run', '--id', '1', '--', 'echo', 'hi'],
		['debug', 'record', '--id', '1', '--loop', 'echo hi', '--root-cause', cause, '--evidence', JSON.stringify(ev), '--fix-plan', 'fix'],
		['debug', 'block', '--reason', 'cannot reproduce'],
	];
	for (const role of [undefined, 'builder', 'reviewer', 'improver']) {
		if (role) setRole(role);
		for (const w of writes) {
			const r = cli(...w);
			assert.notEqual(r.status, 0, `${role ?? 'no run.json'}: ${w.slice(0, 2).join(' ')}`);
			assert.match(r.stderr, /only the debugger/);
		}
	}
	assert.equal(fs.existsSync(path.join(root, '.dev-factory/debug')), false, 'nothing was written');
	assert.equal(fs.existsSync(path.join(root, '.dev-factory/blocked.json')), false);
	setRole('builder');
	assert.equal(cli('debug', 'status').status, 0, 'a builder and the scheduler still read the status');
	setRole('debugger');
	assert.equal(cli(...writes[0]).status, 0);
});
