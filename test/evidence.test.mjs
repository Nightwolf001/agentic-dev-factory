import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { done, record, start } from '../bin/qa.mjs';
import { diffDigest, listEvidence, summaryText } from '../scripts/evidence-lib.mjs';
import { plan } from '../scripts/evidence.mjs';
import { load, merge, validate } from '../scripts/config.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function png(root, name, seed) {
	const f = path.join(`${root}-shots`, `${name}.png`);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	const b = Buffer.alloc(2048, seed);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
	fs.writeFileSync(f, b);
	return f;
}

// A repository with a branch, a finished QA run of two cases, and one text evidence file.
function finished() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-evid-')));
	g(root, 'init', '-q', '-b', 'develop');
	g(root, 'config', 'user.email', 't@t');
	g(root, 'config', 'user.name', 't');
	fs.writeFileSync(path.join(root, '.gitignore'), '.dev-factory/\n');
	fs.writeFileSync(path.join(root, 'app.js'), 'a\nb\n');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'base');
	g(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
	g(root, 'checkout', '-qb', 'task/APP-1-x');
	const cases = path.join(root, '.factory/qa/cases/APP-1');
	fs.mkdirSync(cases, { recursive: true });
	fs.writeFileSync(path.join(cases, 'login.yaml'), 'appId: x\n');
	fs.writeFileSync(path.join(cases, 'send-mail.worker.md'), '# the job sends mail\n');
	fs.writeFileSync(path.join(root, 'app.js'), 'a\nb\nconst password = "Tr0ub4dor&3xyz";\nlet user = "jane.doe@example.com";\n');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'work');
	const m = start({ root, key: 'APP-1', profile: 'service' });
	record({ root, run: m.run, caseSlug: 'login', status: 'pass', assertion: 'the login screen shows', screenshot: png(root, 'a', 3) });
	const worker = path.join(`${root}-shots`, 'w.txt');
	fs.writeFileSync(worker, 'job 41 finished; mailed jane.doe@example.com with token sk_live_abcdefghijklmnop1234 and queued 1 message');
	record({
		root,
		run: m.run,
		caseSlug: 'send-mail.worker',
		status: 'pass',
		assertion: 'the worker mailed the receipt',
		kind: 'worker',
		evidenceFile: worker,
	});
	done({ root, run: m.run });
	return { root, run: m.run, dir: path.join(root, '.dev-factory/evidence/APP-1', `run-${m.run}`) };
}

test('the files come from the manifest, so a stray file in the folder is not attached', () => {
	const f = finished();
	fs.writeFileSync(path.join(f.dir, 'stray.png'), 'not in the manifest');
	const l = listEvidence({ root: f.root, run: f.run });
	assert.deepEqual(l.attach.map((a) => [a.name, a.type, a.case]).sort(), [
		['login-1.png', 'image', 'login'],
		['send-mail.worker-1.worker.txt', 'worker', 'send-mail.worker'],
	]);
	assert.deepEqual(l.skipped, []);
	assert.deepEqual(l.problems, []);
	assert.equal(l.verdict, 'pass');
	assert.ok(l.attach.every((a) => path.isAbsolute(a.file) && a.bytes > 0));
});

test('a file over the size limit is left out and named, not silently dropped', () => {
	const f = finished();
	const l = listEvidence({ root: f.root, run: f.run, maxMb: 0.001 }); // ~1 KB: the 2 KB image is over it
	assert.deepEqual(
		l.skipped.map((s) => [s.name, s.why]),
		[['login-1.png', 'over 0.001 MB']],
	);
	assert.deepEqual(
		l.attach.map((a) => a.name),
		['send-mail.worker-1.worker.txt'],
	);
	assert.equal(validate(merge(load(), { evidence: { maxAttachmentMb: 9 } })).length, 0);
	assert.equal(load().evidence.maxAttachmentMb, 9, 'under the 10 MB Jira takes');
	assert.match(validate(merge(load(), { evidence: { maxAttachmentMb: 0 } })).join('\n'), /evidence\.maxAttachmentMb/);
});

test('a file that changed, vanished or is a link out of the run folder is not attached, and the reason is given', () => {
	const f = finished();
	fs.appendFileSync(path.join(f.dir, 'login-1.png'), 'x');
	let l = listEvidence({ root: f.root, run: f.run });
	assert.deepEqual(
		l.attach.map((a) => a.name),
		['send-mail.worker-1.worker.txt'],
	);
	assert.match(l.problems.join('\n'), /login-1\.png changed since it was recorded/);
	const outside = path.join(os.tmpdir(), `df-evid-outside-${process.pid}.txt`);
	fs.writeFileSync(outside, 'outside');
	fs.rmSync(path.join(f.dir, 'send-mail.worker-1.worker.txt'));
	fs.symlinkSync(outside, path.join(f.dir, 'send-mail.worker-1.worker.txt'));
	l = listEvidence({ root: f.root, run: f.run });
	assert.match(l.problems.join('\n'), /send-mail\.worker-1\.worker\.txt resolves outside the run folder/);
	assert.deepEqual(l.attach, []);
	fs.rmSync(path.join(f.dir, 'login-1.png'));
	assert.match(listEvidence({ root: f.root, run: f.run }).problems.join('\n'), /login-1\.png is missing/);
	assert.throws(() => listEvidence({ root: f.root, run: 9 }), /no QA run 9/);
});

test('a run that is not finished has nothing to attach', () => {
	const f = finished();
	const open = start({ root: f.root, key: 'APP-1', profile: 'service' });
	assert.throws(() => listEvidence({ root: f.root, run: open.run }), /not finished/);
});

test('the digest has the diff stat and the first hunks of the biggest files, with secrets and addresses redacted', () => {
	const f = finished();
	const d = diffDigest({ root: f.root, base: 'origin/develop', secrets: ['Tr0ub4dor&3xyz'] });
	assert.match(d.stat, /app\.js/);
	assert.match(d.hunks, /--- app\.js/);
	assert.match(d.hunks, /@@/);
	assert.doesNotMatch(d.hunks, /Tr0ub4dor|jane\.doe@example/);
	assert.match(d.hunks, /\[redacted:secret\]/);
	assert.match(d.hunks, /\[redacted:email address\]/);
	assert.match(diffDigest({ root: f.root, base: 'origin/nope' }).note, /could not be read/);
	const many = diffDigest({ root: f.root, base: 'origin/develop', hunkLines: 2 });
	for (const section of many.hunks.split('\n\n')) assert.ok(section.split('\n').length <= 3, 'a header and at most hunkLines lines per file');
});

test('plan writes the summary a person reads, redacted, and lists it with the files', () => {
	const f = finished();
	process.env.QA_ACCT_PASSWORD = 'Tr0ub4dor&3xyz';
	fs.writeFileSync(path.join(f.root, '.dev-factory/env.json'), JSON.stringify({ secretEnv: ['QA_ACCT_PASSWORD'] }));
	try {
		const p = plan({ root: f.root, run: f.run, base: 'origin/develop' });
		assert.equal(p.key, 'APP-1');
		assert.equal(p.summary, '.dev-factory/evidence/APP-1/run-1/summary.md');
		assert.deepEqual(p.attach.map((a) => a.name).sort(), ['login-1.png', 'send-mail.worker-1.worker.txt', 'summary.md']);
		assert.ok(
			p.attach.every((a) => !('file' in a)),
			'absolute paths are not handed on',
		);
		const text = fs.readFileSync(path.join(f.root, p.summary), 'utf8');
		assert.match(text, /^QA run 1 for APP-1: pass/);
		assert.match(text, /worker: 1\/1 passed/);
		assert.match(text, /- login \(ui\): pass - the login screen shows/);
		assert.match(text, /- send-mail\.worker \(worker\): pass/);
		assert.match(text, /Change\n.*app\.js/s);
		assert.match(text, /Excerpts\nsend-mail\.worker-1\.worker\.txt:\njob 41 finished/);
		for (const leak of ['Tr0ub4dor', 'jane.doe@example.com', 'sk_live_abcdefghijklmnop1234'])
			assert.ok(!text.includes(leak), `${leak} is not in the summary`);
	} finally {
		delete process.env.QA_ACCT_PASSWORD;
	}
});

test('what was left out and what was not attached is in the summary, and the CLI prints the plan', () => {
	const f = finished();
	const listing = listEvidence({ root: f.root, run: f.run, maxMb: 0.001 });
	const text = summaryText({ root: f.root, run: f.run, listing, digest: null });
	assert.match(text, /Left out \(too large to attach\)\n- login-1\.png \(0\.0 MB, over 0\.001 MB\)/);
	const cli = spawnSync(
		process.execPath,
		[
			path.resolve(import.meta.dirname, '../scripts/evidence.mjs'),
			'plan',
			'--worktree',
			f.root,
			'--run',
			String(f.run),
			'--base',
			'origin/develop',
		],
		{ encoding: 'utf8' },
	);
	assert.equal(cli.status, 0, cli.stderr);
	assert.equal(JSON.parse(cli.stdout).verdict, 'pass');
	assert.equal(
		spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../scripts/evidence.mjs'), 'bogus'], { encoding: 'utf8' }).status,
		1,
	);
});

test('a base that is an option is not given to git, and an excerpt is redacted before it is cut', () => {
	const f = finished();
	const target = path.join(f.root, 'written-by-git.txt');
	const d = diffDigest({ root: f.root, base: `--output=${target}`, head: 'HEAD' });
	assert.match(d.note, /could not be read/);
	assert.equal(fs.existsSync(target), false, '--output never reached git');
	// a secret that would straddle the cut is gone whole
	const listing = listEvidence({ root: f.root, run: f.run });
	const worker = listing.attach.find((a) => a.type === 'worker');
	fs.writeFileSync(worker.file, `${'x'.repeat(380)} token sk_live_abcdefghijklmnop1234 end`);
	const text = summaryText({ root: f.root, run: f.run, listing, digest: null, excerptChars: 400 });
	assert.doesNotMatch(text, /sk_live|abcdefghij/);
});

test('plan works for a run that attached nothing: the folder for summary.md is made', () => {
	const f = finished();
	fs.rmSync(path.join(f.root, '.dev-factory/evidence'), { recursive: true, force: true });
	const p = plan({ root: f.root, run: f.run, base: 'origin/develop' });
	assert.ok(fs.existsSync(path.join(f.root, p.summary)));
});
