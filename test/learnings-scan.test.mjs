import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const script = new URL('../scripts/learnings-scan.mjs', import.meta.url).pathname;

const lesson = (key, at) => ({
	title: `Fix the retry loop [${key}]`,
	mergedAt: at,
	comments: [],
	body: '## Learnings\n- A retry loop that keeps the connection open exhausts the api pool under load.\n  scope: services/api\n',
});

// Runs the scan with a stand-in `gh` first on PATH: it logs its arguments (one per line) and prints the fixture.
function scan(prs, args) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-scan-'));
	const bin = path.join(dir, 'bin');
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(dir, 'prs.json'), JSON.stringify(prs));
	fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${dir}/args.log"; done\ncat "${dir}/prs.json"\n`, {
		mode: 0o755,
	});
	const r = spawnSync(process.execPath, [script, 'candidates', ...args], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir },
	});
	const logFile = path.join(dir, 'args.log');
	const logged = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
	return { ...r, logged };
}

const big = { title: 'Large change [BIG-1]', mergedAt: '2026-11-10T00:00:00Z', comments: [], body: 'x'.repeat(3 * 1024 * 1024) };
const searchOf = (logged) => {
	const i = logged.indexOf('--search');
	return i === -1 ? null : logged[i + 1];
};

test('a merged-PR list over 1 MB does not crash the scan', () => {
	const r = scan([big, lesson('AAA-1', '2026-11-11T00:00:00Z'), lesson('AAA-2', '2026-11-12T00:00:00Z')], []);
	assert.equal(r.status, 0, r.stderr.slice(0, 500));
	const out = JSON.parse(r.stdout);
	assert.equal(out.entries, 2);
	assert.equal(out.candidates.length, 1);
	assert.deepEqual(out.candidates[0].tickets.sort(), ['AAA-1', 'AAA-2']);
});

test('--since 2026-11-01T00:00:00Z asks gh only for PRs merged since that day', () => {
	const r = scan([lesson('AAA-1', '2026-11-11T00:00:00Z')], ['--since', '2026-11-01T00:00:00Z']);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(searchOf(r.logged), 'merged:>=2026-11-01');
	assert.deepEqual(r.logged.slice(0, 6), ['pr', 'list', '--state', 'merged', '--limit', '200']);
	assert.ok(r.logged.includes('--json'));
});

test('a plain date --since 2026-11-01 does the same', () => {
	const r = scan([lesson('AAA-1', '2026-11-11T00:00:00Z')], ['--since', '2026-11-01']);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(searchOf(r.logged), 'merged:>=2026-11-01');
	assert.deepEqual(r.logged.slice(0, 6), ['pr', 'list', '--state', 'merged', '--limit', '200']);
});

test('no --since sends no search', () => {
	const r = scan([lesson('AAA-1', '2026-11-11T00:00:00Z')], []);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(searchOf(r.logged), null);
	assert.ok(r.logged.includes('--json'));
});

test('a --since that is not a date sends no search', () => {
	const r = scan([lesson('AAA-1', '2026-11-11T00:00:00Z')], ['--since', 'garbage']);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(searchOf(r.logged), null);
	assert.equal(JSON.parse(r.stdout).entries, 0);
});

test('the in-process filter still drops a PR merged earlier on the same day', () => {
	const r = scan(
		[lesson('AAA-1', '2026-11-01T06:00:00Z'), lesson('AAA-2', '2026-11-01T18:00:00Z'), lesson('AAA-3', '2026-11-02T01:00:00Z')],
		['--since', '2026-11-01T12:00:00Z', '--min', '1'],
	);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(searchOf(r.logged), 'merged:>=2026-11-01');
	const out = JSON.parse(r.stdout);
	assert.equal(out.entries, 2);
	assert.deepEqual(out.candidates[0].tickets.sort(), ['AAA-2', 'AAA-3']);
});

test('output shape unchanged', () => {
	const r = scan([lesson('AAA-1', '2026-11-11T00:00:00Z'), lesson('AAA-2', '2026-11-12T00:00:00Z')], []);
	assert.equal(r.status, 0, r.stderr);
	const out = JSON.parse(r.stdout);
	assert.deepEqual(Object.keys(out), ['entries', 'candidates']);
	assert.equal(out.entries, 2);
	assert.deepEqual(Object.keys(out.candidates[0]), ['text', 'scope', 'tickets', 'confirmed']);
	assert.equal(out.candidates[0].scope, 'services/api');
});

test('without the candidates verb it prints the usage and exits 3', () => {
	const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
	assert.equal(r.status, 3);
	assert.match(r.stderr, /usage: learnings-scan\.mjs candidates/);
});
