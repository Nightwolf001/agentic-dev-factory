import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { QaError, baseFor, done, globToRegExp, markNa, nonUiGlobsFor, record, start, uiGlobsFor, verify } from '../bin/qa.mjs';

const QA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'qa.mjs');
const PROFILES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'qa', 'profiles.yaml');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function makeRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-qa-'));
	g(root, 'init', '-q', '-b', 'develop');
	g(root, 'config', 'user.email', 't@example.com');
	g(root, 'config', 'user.name', 't');
	fs.mkdirSync(path.join(root, 'dev-factory/qa/cases/APP-1'), { recursive: true });
	fs.copyFileSync(PROFILES, path.join(root, 'dev-factory/qa/profiles.yaml'));
	fs.writeFileSync(path.join(root, 'dev-factory/qa/cases/APP-1/login.yaml'), 'appId: x\n');
	fs.writeFileSync(path.join(root, 'dev-factory/qa/cases/APP-1/arm.yaml'), 'appId: x\n');
	fs.writeFileSync(path.join(root, '.gitignore'), '.dev-factory/\n');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'base');
	return root;
}

// A PNG signature plus padding: valid magic, over the 1 KB floor, unique per seed.
function png(root, name, seed, size = 2048) {
	const shots = `${root}-shots`;
	fs.mkdirSync(shots, { recursive: true });
	const file = path.join(shots, `${name}.png`);
	const buf = Buffer.alloc(size, seed);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
	fs.writeFileSync(file, buf);
	return file;
}
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof QaError && re.test(e.message));

test('start refuses a dirty tree and a ticket with no authored case', () => {
	const root = makeRepo();
	fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
	refused(() => start({ root, key: 'APP-1', profile: 'web' }), /not clean/);
	fs.rmSync(path.join(root, 'stray.txt'));
	assert.throws(
		() => start({ root, key: 'APP-9', profile: 'web' }),
		(e) => e.code === 2 && /needs_own_case/.test(e.message),
	);
});

test('a full walk passes and verify accepts the recorded head', () => {
	const root = makeRepo();
	const m = start({ root, key: 'APP-1', profile: 'web' });
	record({ root, run: m.run, caseSlug: 'login', status: 'pass', assertion: 'login screen shows the arm button', screenshot: png(root, 'a', 1) });
	refused(() => done({ root, run: m.run }), /not recorded: arm/);
	record({ root, run: m.run, caseSlug: 'arm', status: 'pass', assertion: 'armed banner visible after tap', screenshot: png(root, 'b', 2) });
	const res = done({ root, run: m.run });
	assert.equal(res.verdict, 'pass');
	assert.equal(verify({ root, head: g(root, 'rev-parse', 'HEAD'), run: m.run }).ok, true);
});

test('record refuses weak evidence', () => {
	const root = makeRepo();
	const m = start({ root, key: 'APP-1', profile: 'web' });
	const base = { root, run: m.run, caseSlug: 'login', status: 'pass' };
	refused(() => record({ ...base, assertion: 'ok', screenshot: png(root, 'a', 1) }), /at least 8/);
	refused(() => record({ ...base, assertion: 'same as run #3 earlier', screenshot: png(root, 'a', 1) }), /another run/);
	refused(() => record({ ...base, assertion: 'login screen visible', screenshot: png(root, 'tiny', 1, 100) }), /at least 1024/);
	const fake = png(root, 'fake', 7);
	fs.writeFileSync(fake, Buffer.alloc(2048, 7));
	refused(() => record({ ...base, assertion: 'login screen visible', screenshot: fake }), /not a PNG/);
	refused(() => record({ ...base, assertion: 'login screen visible' }), /needs at least one screenshot/);
	const old = png(root, 'old', 3);
	const past = new Date(Date.now() - 3600_000);
	fs.utimesSync(old, past, past);
	refused(() => record({ ...base, assertion: 'login screen visible', screenshot: old }), /predates/);
});

test('duplicate screenshot bytes across cases are refused', () => {
	const root = makeRepo();
	const m = start({ root, key: 'APP-1', profile: 'web' });
	record({ root, run: m.run, caseSlug: 'login', status: 'pass', assertion: 'login screen visible', screenshot: png(root, 'a', 5) });
	refused(
		() => record({ root, run: m.run, caseSlug: 'arm', status: 'pass', assertion: 'armed banner visible', screenshot: png(root, 'b', 5) }),
		/already registered/,
	);
});

test('a failed case yields a fail verdict that verify rejects', () => {
	const root = makeRepo();
	const m = start({ root, key: 'APP-1', profile: 'web' });
	record({ root, run: m.run, caseSlug: 'login', status: 'fail', assertion: 'arm button missing on screen' });
	record({ root, run: m.run, caseSlug: 'arm', status: 'pass', assertion: 'armed banner visible', screenshot: png(root, 'b', 2) });
	assert.equal(done({ root, run: m.run }).verdict, 'fail');
	refused(() => verify({ root, head: g(root, 'rev-parse', 'HEAD'), run: m.run }), /verdict is fail/);
});

test('HEAD moving invalidates the run and verify checks the PR head', () => {
	const root = makeRepo();
	const m = start({ root, key: 'APP-1', profile: 'web' });
	record({ root, run: m.run, caseSlug: 'login', status: 'pass', assertion: 'login screen visible', screenshot: png(root, 'a', 1) });
	fs.writeFileSync(path.join(root, 'late.txt'), 'x');
	g(root, 'add', 'late.txt');
	g(root, 'commit', '-qm', 'late');
	refused(() => record({ root, run: m.run, caseSlug: 'arm', status: 'fail', assertion: 'armed banner missing' }), /HEAD moved/);
	refused(() => done({ root, run: m.run }), /not recorded|HEAD moved/);
});

test('verify detects tampered evidence', () => {
	const root = makeRepo();
	const m = start({ root, key: 'APP-1', profile: 'web' });
	const r1 = record({ root, run: m.run, caseSlug: 'login', status: 'pass', assertion: 'login screen visible', screenshot: png(root, 'a', 1) });
	record({ root, run: m.run, caseSlug: 'arm', status: 'pass', assertion: 'armed banner visible', screenshot: png(root, 'b', 2) });
	done({ root, run: m.run });
	fs.appendFileSync(path.join(root, r1.evidence.file), 'x');
	refused(() => verify({ root, head: g(root, 'rev-parse', 'HEAD'), run: m.run }), /changed since recorded/);
});

test('mark-na refuses when the diff touches a UI glob and accepts otherwise', () => {
	const root = makeRepo();
	g(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
	g(root, 'checkout', '-qb', 'task/X-1-x');
	fs.mkdirSync(path.join(root, 'services/api'), { recursive: true });
	fs.writeFileSync(path.join(root, 'services/api/a.js'), '1');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'api');
	const ok = markNa({ root, key: 'X-1', profile: 'web', reason: 'backend only change' });
	assert.equal(ok.verdict, 'not_applicable');
	assert.equal(verify({ root, head: g(root, 'rev-parse', 'HEAD'), key: 'X-1' }).ok, true);
	fs.mkdirSync(path.join(root, 'web/src'), { recursive: true });
	fs.writeFileSync(path.join(root, 'web/src/App.vue'), '1');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'ui');
	refused(() => markNa({ root, key: 'X-1', profile: 'web', reason: 'backend only change' }), /UI surface/);
});

test('markdown under a UI folder is documentation, not UI surface, but code beside it still needs a walk', () => {
	const root = makeRepo();
	g(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
	g(root, 'checkout', '-qb', 'task/X-2-docs');
	fs.mkdirSync(path.join(root, 'app/ios/Sources'), { recursive: true });
	fs.writeFileSync(path.join(root, 'app/ios/Sources/AGENTS.md'), '# notes');
	fs.writeFileSync(path.join(root, 'app/ios/AGENTS.md'), '# notes');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'docs');
	assert.equal(markNa({ root, key: 'X-2', profile: 'mobile', reason: 'documentation only' }).verdict, 'not_applicable');
	fs.writeFileSync(path.join(root, 'app/ios/Sources/Screen.swift'), '1');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'code');
	refused(() => markNa({ root, key: 'X-2', profile: 'mobile', reason: 'documentation only' }), /UI surface.*Screen\.swift/);
});

test('profile globs parse and match', () => {
	const root = makeRepo();
	const globs = uiGlobsFor(root, 'mobile').map(globToRegExp);
	assert.ok(globs.some((r) => r.test('app/ios/Sources/Home.swift')));
	assert.ok(!globs.some((r) => r.test('services/api/x.js')));
	const docs = nonUiGlobsFor(root, 'mobile').map(globToRegExp);
	assert.ok(docs.some((r) => r.test('app/ios/Sources/AGENTS.md')));
	assert.ok(!docs.some((r) => r.test('app/ios/Sources/Home.swift')));
});

// ---- two-step review ----
import { reviewRecord as recordReview, reviewStatus } from '../bin/qa.mjs';

// Records as the scheduler's reviewer agent writes them: qa.mjs stamps the role from run.json.
const reviewRecord = (o) => recordReview({ by: 'reviewer', ...o });

const passedRun = (root) => {
	const m = start({ root, key: 'APP-1', profile: 'web' });
	record({ root, run: m.run, caseSlug: 'login', status: 'pass', assertion: 'login screen visible', screenshot: png(root, 'r1', 11) });
	record({ root, run: m.run, caseSlug: 'arm', status: 'pass', assertion: 'armed banner visible', screenshot: png(root, 'r2', 12) });
	done({ root, run: m.run });
	return m.run;
};
const head = (root) => g(root, 'rev-parse', 'HEAD');
const SUMMARY = 'Compared every acceptance criterion with the diff and tests';

test('review step 2 needs a clean step 1 at the same commit', () => {
	const root = makeRepo();
	refused(() => reviewRecord({ root, axis: 'standards', head: head(root), summary: SUMMARY, findings: '[]' }), /step 1/);
	const bad = [{ severity: 'High', file: 'a.js', line: 3, note: 'criterion two is not implemented' }];
	reviewRecord({ root, axis: 'spec', head: head(root), summary: SUMMARY, findings: JSON.stringify(bad) });
	refused(() => reviewRecord({ root, axis: 'standards', head: head(root), summary: SUMMARY, findings: '[]' }), /open Critical or High/);
	assert.equal(reviewStatus({ root }).clean, false);
});

test('review counts come from findings and bad findings are refused', () => {
	const root = makeRepo();
	const h = head(root);
	refused(() => reviewRecord({ root, axis: 'spec', head: h, summary: 'short', findings: '[]' }), /20 characters/);
	refused(() => reviewRecord({ root, axis: 'spec', head: h, summary: SUMMARY, findings: 'nope' }), /JSON array/);
	refused(
		() =>
			reviewRecord({
				root,
				axis: 'spec',
				head: h,
				summary: SUMMARY,
				findings: '[{"severity":"Huge","file":"a","line":1,"note":"long enough note"}]',
			}),
		/severity/,
	);
	refused(
		() =>
			reviewRecord({
				root,
				axis: 'spec',
				head: h,
				summary: SUMMARY,
				findings: '[{"severity":"Low","file":"a","line":0,"note":"long enough note"}]',
			}),
		/line/,
	);
	const r = reviewRecord({
		root,
		axis: 'spec',
		head: h,
		summary: SUMMARY,
		findings: '[{"severity":"Low","file":"a.js","line":2,"note":"naming could be clearer"}]',
	});
	assert.deepEqual(r.counts, { critical: 0, high: 0, medium: 0, low: 1 });
	refused(() => reviewRecord({ root, axis: 'spec', head: 'deadbeef', summary: SUMMARY, findings: '[]' }), /not the current HEAD/);
});

test('verify with require-review needs both steps clean at the QA head', () => {
	const root = makeRepo();
	const run = passedRun(root);
	const h = head(root);
	refused(() => verify({ root, head: h, run, requireReview: true }), /review step spec is not recorded/);
	reviewRecord({ root, axis: 'spec', head: h, summary: SUMMARY, findings: '[]' });
	refused(() => verify({ root, head: h, run, requireReview: true }), /review step standards is not recorded/);
	reviewRecord({
		root,
		axis: 'standards',
		head: h,
		summary: SUMMARY,
		findings: '[{"severity":"Medium","file":"a.js","line":9,"note":"consider extracting a helper"}]',
	});
	assert.equal(verify({ root, head: h, run, requireReview: true }).ok, true);
	assert.equal(reviewStatus({ root }).rounds, 1);
});

// ---- specialist review axes ----
import { triggeredAxes } from '../bin/qa.mjs';

const AXES_CFG = { data: ['**/migrations/**'], infra: ['.github/workflows/**'], security: ['**/*token*'] };
function withDiff(files) {
	const root = makeRepo();
	g(root, 'branch', 'origin-develop');
	for (const f of files) {
		fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
		fs.writeFileSync(path.join(root, f), 'x\n');
	}
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'change');
	return root;
}

test('triggeredAxes maps changed paths to specialist axes and tolerates a missing base', () => {
	const root = withDiff(['services/api/migrations/001.sql', 'src/a.js']);
	assert.deepEqual(triggeredAxes({ root, specialistAxes: AXES_CFG, base: 'origin-develop' }), ['data']);
	assert.deepEqual(triggeredAxes({ root, specialistAxes: AXES_CFG, base: 'no-such-ref' }), []);
});

test('a triggered axis must be recorded and clean before verify passes', () => {
	const root = withDiff(['.github/workflows/ci.yml']);
	const run = passedRun(root);
	const h = head(root);
	reviewRecord({ root, axis: 'spec', head: h, summary: SUMMARY, findings: '[]' });
	refused(() => reviewRecord({ root, axis: 'infra', head: h, summary: SUMMARY, findings: '[]' }), /standards step has not been recorded/);
	reviewRecord({ root, axis: 'standards', head: h, summary: SUMMARY, findings: '[]' });
	const opts = { root, head: h, run, requireReview: true, specialistAxes: AXES_CFG, base: 'origin-develop' };
	assert.equal(reviewStatus({ root, specialistAxes: AXES_CFG, base: 'origin-develop' }).clean, false);
	refused(() => verify(opts), /review step infra is not recorded/);
	reviewRecord({
		root,
		axis: 'infra',
		head: h,
		summary: SUMMARY,
		findings: '[{"severity":"High","file":"a","line":1,"note":"secret in workflow"}]',
	});
	refused(() => verify(opts), /infra has 1 open/);
});

test('verify passes once the triggered axis is clean', () => {
	const root = withDiff(['.github/workflows/ci.yml']);
	const run = passedRun(root);
	const h = head(root);
	for (const axis of ['spec', 'standards', 'infra']) reviewRecord({ root, axis, head: h, summary: SUMMARY, findings: '[]' });
	assert.equal(verify({ root, head: h, run, requireReview: true, specialistAxes: AXES_CFG, base: 'origin-develop' }).ok, true);
	assert.equal(reviewStatus({ root, specialistAxes: AXES_CFG, base: 'origin-develop' }).clean, true);
});

test('verify by key finds the run made at the PR head, never a PR number', () => {
	const root = makeRepo();
	const head = g(root, 'rev-parse', 'HEAD');
	refused(() => verify({ root, head, key: 'APP-1' }), /no QA run at/);
	const m = start({ root, key: 'APP-1', profile: 'web' });
	refused(() => verify({ root, head, key: 'APP-1' }), /no QA run at/);
	record({ root, run: m.run, caseSlug: 'login', status: 'pass', assertion: 'login screen shows the arm button', screenshot: png(root, 'a', 1) });
	record({ root, run: m.run, caseSlug: 'arm', status: 'pass', assertion: 'armed banner visible after tap', screenshot: png(root, 'b', 2) });
	done({ root, run: m.run });
	assert.equal(verify({ root, head, key: 'APP-1' }).ok, true);
	assert.equal(verify({ root, head: head.slice(0, 9), key: 'APP-1' }).ok, true);
	refused(() => verify({ root, head: 'f'.repeat(40), key: 'APP-1' }), /no QA run at/);
	refused(() => verify({ root, head, key: 'OTHER-2' }), /no QA run at/);
});

test('verify refuses a review record that no reviewer agent wrote', () => {
	const root = makeRepo();
	const run = passedRun(root);
	const h = head(root);
	for (const by of [undefined, null, 'builder']) {
		for (const axis of ['spec', 'standards']) recordReview({ root, axis, head: h, summary: SUMMARY, findings: '[]', by });
		refused(() => verify({ root, head: h, run, requireReview: true }), /review step spec was not recorded by a reviewer agent/);
		refused(() => verify({ root, head: h, run, requireReview: true }), /review step standards was not recorded by a reviewer agent/);
	}
	for (const axis of ['spec', 'standards']) reviewRecord({ root, axis, head: h, summary: SUMMARY, findings: '[]' });
	assert.equal(verify({ root, head: h, run, requireReview: true }).ok, true);
	assert.equal(reviewStatus({ root }).axes.spec.by, 'reviewer');
});

test('the CLI records a review only for the axis its run.json names, and only as a reviewer', () => {
	const root = makeRepo();
	const h = head(root);
	const cli = (axis) =>
		spawnSync('node', [QA, 'review', 'record', '--worktree', root, '--axis', axis, '--head', h, '--summary', SUMMARY, '--findings', '[]'], {
			encoding: 'utf8',
			env: { ...process.env, DF_STATE_DIR: path.join(root, 'state') },
		});
	const runJson = (run) => {
		fs.mkdirSync(path.join(root, '.dev-factory'), { recursive: true });
		fs.writeFileSync(path.join(root, '.dev-factory', 'run.json'), JSON.stringify({ key: 'APP-1', ...run }));
	};
	assert.notEqual(cli('spec').status, 0, 'no run.json');
	runJson({ role: 'builder' });
	assert.match(cli('spec').stderr, /only the reviewer the scheduler dispatched/);
	runJson({ role: 'reviewer', axis: 'standards' });
	assert.match(cli('spec').stderr, /only the spec reviewer/);
	runJson({ role: 'reviewer', axis: 'spec' });
	const ok = cli('spec');
	assert.equal(ok.status, 0, ok.stderr);
	assert.equal(JSON.parse(ok.stdout).by, 'reviewer');
});

test('the ui profile is read from the plugin, so a worktree whose base has no dev-factory folder still works', () => {
	const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'df-qa-bare-'));
	assert.equal(fs.existsSync(path.join(bare, 'dev-factory')), false);
	assert.ok(uiGlobsFor(bare, 'mobile').length > 0);
});

test("the diff base is the run's base branch, with DF_BASE_REF overriding and origin/develop as the default", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-qa-base-'));
	const saved = process.env.DF_BASE_REF;
	delete process.env.DF_BASE_REF;
	try {
		assert.equal(baseFor(root), 'origin/develop');
		fs.mkdirSync(path.join(root, '.dev-factory'));
		fs.writeFileSync(path.join(root, '.dev-factory', 'run.json'), JSON.stringify({ key: 'APP-1', base: 'feature/X-1-base' }));
		assert.equal(baseFor(root), 'origin/feature/X-1-base');
		fs.writeFileSync(path.join(root, '.dev-factory', 'run.json'), JSON.stringify({ key: 'APP-1', base: '--upload-pack=x' }));
		assert.equal(baseFor(root), 'origin/develop', 'an unusable name in run.json is ignored');
		process.env.DF_BASE_REF = 'origin/other';
		assert.equal(baseFor(root), 'origin/other');
	} finally {
		if (saved === undefined) delete process.env.DF_BASE_REF;
		else process.env.DF_BASE_REF = saved;
	}
});

test('ticket base prints the branch a ticket names and nothing when it names none', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-qa-tb-'));
	const f = path.join(dir, 'd.md');
	fs.writeFileSync(f, 'Summary\n\nBase branch: feature/X-1-base\n\nAcceptance criteria\n- a thing\n');
	const named = spawnSync('node', [QA, 'ticket', 'base', '--file', f], { encoding: 'utf8' });
	assert.equal(named.status, 0);
	assert.equal(JSON.parse(named.stdout).base, 'feature/X-1-base');
	fs.writeFileSync(f, 'Summary\n\nAcceptance criteria\n- a thing\n');
	assert.equal(JSON.parse(spawnSync('node', [QA, 'ticket', 'base', '--file', f], { encoding: 'utf8' }).stdout).base, null);
});

test('a repository replaces the default QA profiles with its own dev-factory.qa.yaml', () => {
	const root = makeRepo();
	assert.ok(
		uiGlobsFor(root, 'web').some((g) => g === '**/*.vue'),
		'the plugin defaults apply without a file',
	);
	fs.writeFileSync(
		path.join(root, 'dev-factory.qa.yaml'),
		'web:\n  runner: playwright\n  uiGlobs:\n    - "site/**"\n  nonUiGlobs:\n    - "**/*.md"\n',
	);
	assert.deepEqual(uiGlobsFor(root, 'web'), ['site/**']);
	assert.deepEqual(nonUiGlobsFor(root, 'web'), ['**/*.md']);
});

test('verify refuses commits authored by an agent or carrying an agent trailer when attribution is off', async () => {
	const { attributionProblems } = await import('../bin/qa.mjs');
	const root = makeRepo();
	g(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
	g(root, 'checkout', '-qb', 'task/X-9-attr');
	const commit = (msg, extra = []) => {
		fs.writeFileSync(path.join(root, `f${Math.random()}.txt`), 'x');
		g(root, 'add', '-A');
		g(root, ...extra, 'commit', '-qm', msg);
	};
	commit('Plain change [X-9]');
	assert.deepEqual(attributionProblems(root, 'HEAD', 'origin/develop'), []);
	commit('With trailer [X-9]\n\nCo-Authored-By: Claude Sonnet <noreply@anthropic.com>');
	assert.match(attributionProblems(root, 'HEAD', 'origin/develop')[0], /agent attribution line/);
	commit('Agent author [X-9]', ['-c', 'user.name=Claude', '-c', 'user.email=noreply@anthropic.com']);
	const problems = attributionProblems(root, 'HEAD', 'origin/develop');
	assert.equal(problems.length, 2);
	assert.match(problems.join(' '), /authored or committed by an agent identity/);
	assert.deepEqual(attributionProblems(root, 'HEAD', 'origin/no-such-base'), [], 'an unknown base is not a verdict');
});
