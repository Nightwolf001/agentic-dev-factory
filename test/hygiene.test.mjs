import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { TOKEN_SHAPES, TRACKER_SITE } from './patterns.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const tracked = () =>
	execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
		.split('\0')
		.filter(Boolean)
		.filter((f) => fs.existsSync(path.join(ROOT, f)));
const isText = (buf) => !buf.subarray(0, 4096).includes(0);
const read = (f) => fs.readFileSync(path.join(ROOT, f));

test('no environment file with real values is tracked', () => {
	const bad = tracked().filter((f) => /(^|\/)\.env(\.[^/]*)?$/i.test(f) && !/\.(example|sample|template)$/i.test(f));
	assert.deepEqual(bad, [], 'secrets live in ~/.dev-factory/.env.local, outside every repository');
	assert.ok(tracked().includes('.env.example'), 'the names are documented in .env.example');
	assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\.env\.local$/m);
	const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
	for (const line of example.split('\n').filter((l) => /^[A-Z_]+=/.test(l)))
		assert.match(line, /^[A-Z_]+=\s*$/, `${line.split('=')[0]} has a value in .env.example: names only`);
});

test('no tracked file holds a secret-shaped string (tests excepted: their fakes are written in other shapes on purpose)', () => {
	const hits = [];
	for (const f of tracked()) {
		const buf = read(f);
		if (!isText(buf)) continue;
		const text = buf.toString('utf8');
		for (const [name, re] of TOKEN_SHAPES) {
			if (!re.test(text)) continue;
			// a test may hold a fake in a credential's shape; a private key counts only with a key body after the header
			if (f.startsWith('test/') && (name !== 'private key' || !/PRIVATE KEY-----\s*[A-Za-z0-9+/=]{60,}/.test(text))) continue;
			hits.push(`${f}: ${name}`);
		}
	}
	assert.deepEqual(hits, []);
});

test('the patterns do catch the shapes they claim to (so the sweep above means something)', () => {
	const samples = {
		'GitHub token': `ghp_${'a1B2'.repeat(9)}`,
		'Slack token': `xoxb-${'1234567890-'.repeat(3)}abc`,
		'AWS access key id': 'AKIAABCDEFGHIJKLMNOP',
		'Atlassian API token': `ATATT3${'x'.repeat(40)}`,
		'private key': '-----BEGIN RSA PRIVATE KEY-----',
		JWT: `eyJ${'a'.repeat(30)}.eyJ${'b'.repeat(30)}.${'c'.repeat(30)}`,
		'Notion token': `secret_${'a'.repeat(43)}`,
	};
	for (const [name, sample] of Object.entries(samples)) assert.ok(TOKEN_SHAPES.find(([n]) => n === name)[1].test(sample), name);
	assert.ok(
		!TOKEN_SHAPES.some(([, re]) => re.test('sk_live_abcdefghijklmnop1234 and Bearer abcdefghijklmnop1234')),
		'the fakes the tests use do not match',
	);
});

test('no file names a real tracker site: a host is a setting, and examples use placeholders', () => {
	const hits = [];
	for (const f of tracked()) {
		const buf = read(f);
		if (!isText(buf) || f === 'docs/fork-improvements-to-port.md') continue;
		const m = TRACKER_SITE.exec(buf.toString('utf8'));
		if (m) hits.push(`${f}: ${m[0]}`);
	}
	assert.deepEqual(hits, []);
	assert.ok(!TRACKER_SITE.test('https://example.atlassian.net/browse/APP-1'));
	assert.ok(!TRACKER_SITE.test('your-site.atlassian.net'));
	assert.ok(TRACKER_SITE.test('https://realcompany.atlassian.net/browse/APP-1'));
});

test('the vocabulary lint passes on every tracked file', () => {
	const r = spawnSync('bash', [path.join(ROOT, 'scripts/lint-vocabulary.sh')], { encoding: 'utf8', cwd: ROOT });
	assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('nothing tracked is a build product or a machine file', () => {
	const bad = tracked().filter(
		(f) => /(^|\/)(node_modules|\.DS_Store|\.dev-factory|\.worktrees)(\/|$)/.test(f) || (/\.(log|pid|lock)$/.test(f) && !/package-lock/.test(f)),
	);
	assert.deepEqual(bad, []);
});
