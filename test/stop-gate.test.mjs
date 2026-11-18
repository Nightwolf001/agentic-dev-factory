import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { done, record, start } from '../bin/qa.mjs';
import { decide, mayRecordBlock } from '../scripts/stop-gate-lib.mjs';

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'stop-gate.mjs');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const has =
	(...files) =>
	(f) =>
		files.includes(f);
const build = { role: 'builder', until: 'build', kind: 'story', key: 'APP-1' };

// A worktree the way a builder finds it: a committed case, run.json and nothing else.
function worktree(run = build) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-gate-'));
	g(root, 'init', '-q', '-b', 'develop');
	g(root, 'config', 'user.email', 't@example.com');
	g(root, 'config', 'user.name', 't');
	fs.mkdirSync(path.join(root, '.factory/qa/cases/APP-1'), { recursive: true });
	fs.writeFileSync(path.join(root, '.factory/qa/cases/APP-1/login.yaml'), 'appId: x\n');
	fs.writeFileSync(path.join(root, '.gitignore'), '.dev-factory/\n');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'base');
	fs.mkdirSync(path.join(root, '.dev-factory'), { recursive: true });
	fs.writeFileSync(path.join(root, '.dev-factory/run.json'), JSON.stringify(run));
	return root;
}

function png(root, seed) {
	const file = `${root}-shot-${seed}.png`;
	const buf = Buffer.alloc(2048, seed);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
	fs.writeFileSync(file, buf);
	return file;
}

function passingQa(root) {
	const m = start({ root, key: 'APP-1', profile: 'web' });
	record({ root, run: m.run, caseSlug: 'login', status: 'pass', assertion: 'login screen shows the arm button', screenshot: png(root, 7) });
	assert.equal(done({ root, run: m.run }).verdict, 'pass');
}

const gate = (root, env = {}) =>
	spawnSync('node', [GATE], {
		input: JSON.stringify({ cwd: root }),
		encoding: 'utf8',
		env: { ...process.env, DF_ACTIVE: '1', DF_STATE_DIR: `${root}-state`, ...env },
	});
const marker = (root, name) => path.join(root, '.dev-factory', name);

test('decide: build.done ends a build only when what backs it is in order', () => {
	assert.equal(decide({ run: build, has: has('build.done') }).finished, true, 'no facts supplied: the file alone is accepted, as before');
	assert.equal(decide({ run: build, has: has('build.done'), build: { problems: [] } }).finished, true);
	const refused = decide({ run: build, has: has('build.done'), build: { problems: ['working tree is not clean', 'no QA run at abc'] } });
	assert.equal(refused.finished, false);
	assert.match(refused.next, /build\.done is not accepted/);
	assert.match(refused.next, /working tree is not clean; no QA run at abc/);
	assert.equal(decide({ run: build, has: has(), build: { problems: [] } }).finished, false, 'no file, no end');
});

test('decide: blocked.json and needs_debug.json still let a builder stop whatever the facts say', () => {
	const bad = { problems: ['no QA run at abc'] };
	assert.equal(decide({ run: build, has: has('blocked.json'), build: bad }).finished, true);
	assert.equal(decide({ run: build, has: has('needs_debug.json'), build: bad }).finished, true);
});

test('only the roles whose stop condition accepts blocked.json may be given one by the gate', () => {
	for (const run of [
		build,
		{ role: 'debugger' },
		{ role: 'researcher' },
		{ role: 'improver' },
		{ role: 'promoter' },
		{ role: 'builder', until: 'ship' },
	])
		assert.equal(mayRecordBlock(run), true, JSON.stringify(run));
	assert.equal(mayRecordBlock({ role: 'reviewer', axis: 'spec' }), false);
});

test('the gate refuses a build.done that no QA run backs, and says why', () => {
	const root = worktree();
	fs.writeFileSync(marker(root, 'build.done'), g(root, 'rev-parse', 'HEAD'));
	const r = gate(root);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /build\.done is not accepted/);
	assert.match(r.stderr, /no QA run at/);
});

test('the gate accepts build.done once the tree is clean, QA passed at HEAD and the file names the commit', () => {
	const root = worktree();
	passingQa(root);
	fs.writeFileSync(marker(root, 'build.done'), g(root, 'rev-parse', 'HEAD'));
	const r = gate(root);
	assert.equal(r.status, 0, r.stderr);
});

test('the gate refuses a build.done with an unrelated sha or a stray uncommitted file', () => {
	const root = worktree();
	passingQa(root);
	fs.writeFileSync(marker(root, 'build.done'), '0123456789abcdef');
	assert.match(gate(root).stderr, /not the QA head/);
	fs.writeFileSync(marker(root, 'build.done'), g(root, 'rev-parse', 'HEAD'));
	fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
	assert.match(gate(root).stderr, /not clean/);
});

test('a builder that is blocked or needs the debugger may stop without any QA run', () => {
	for (const name of ['blocked.json', 'needs_debug.json']) {
		const root = worktree();
		fs.writeFileSync(marker(root, name), '{}');
		assert.equal(gate(root).status, 0, name);
	}
});

test('when the gate gives up it records a block naming the unmet step, so the scheduler is not left waiting', () => {
	const root = worktree();
	fs.writeFileSync(marker(root, 'build.done'), g(root, 'rev-parse', 'HEAD'));
	const env = { DF_STOP_GATE_MAX: '1' };
	assert.equal(gate(root, env).status, 2, 'the first refusal is a nudge');
	assert.equal(fs.existsSync(marker(root, 'blocked.json')), false);
	const last = gate(root, env);
	assert.equal(last.status, 0, 'the second one gives up');
	const blocked = JSON.parse(fs.readFileSync(marker(root, 'blocked.json'), 'utf8'));
	assert.match(blocked.reason, /stop gate/);
	assert.match(blocked.reason, /no QA run at/);
	assert.ok(blocked.decision, 'a block always carries the decision a person has to make');
	assert.equal(gate(root, env).status, 0, 'and the next stop is allowed outright');
});

test('giving up never replaces a block someone else wrote', () => {
	const root = worktree();
	fs.writeFileSync(marker(root, 'blocked.json'), JSON.stringify({ reason: 'needs a decision', decision: 'which API?' }));
	assert.equal(gate(root, { DF_STOP_GATE_MAX: '0' }).status, 0);
	assert.equal(JSON.parse(fs.readFileSync(marker(root, 'blocked.json'), 'utf8')).reason, 'needs a decision');
});

test('a reviewer that is let go after the nudges leaves no block behind, because nothing waits on one for a reviewer', () => {
	const root = worktree({ role: 'reviewer', axis: 'spec', key: 'APP-1' });
	assert.equal(gate(root, { DF_STOP_GATE_MAX: '0' }).status, 0);
	assert.equal(fs.existsSync(marker(root, 'blocked.json')), false);
});
