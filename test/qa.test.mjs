import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { QaError, baseFor, done, globToRegExp, markNa, noBehaviourGlobsFor, nonUiGlobsFor, record, start, uiGlobsFor, verify } from '../bin/qa.mjs';

const QA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'qa.mjs');
const PROFILES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'qa', 'profiles.yaml');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

function makeRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-qa-'));
	g(root, 'init', '-q', '-b', 'develop');
	g(root, 'config', 'user.email', 't@example.com');
	g(root, 'config', 'user.name', 't');
	fs.mkdirSync(path.join(root, '.factory/qa/cases/APP-1'), { recursive: true });
	fs.writeFileSync(path.join(root, '.factory/qa/cases/APP-1/login.yaml'), 'appId: x\n');
	fs.writeFileSync(path.join(root, '.factory/qa/cases/APP-1/arm.yaml'), 'appId: x\n');
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

test('mark-na is accepted only when every changed file is documentation, a test or a formatting rule', () => {
	const root = makeRepo();
	g(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
	g(root, 'checkout', '-qb', 'task/X-1-x');
	fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
	fs.writeFileSync(path.join(root, 'docs/guide.md'), '# guide');
	fs.writeFileSync(path.join(root, 'src.test.js'), 'test()');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'docs and tests');
	const ok = markNa({ root, key: 'X-1', profile: 'web', reason: 'documentation and tests only' });
	assert.equal(ok.verdict, 'not_applicable');
	assert.equal(verify({ root, head: g(root, 'rev-parse', 'HEAD'), key: 'X-1' }).ok, true);
	// a backend file used to be exempt because it is not a UI file: it changes behaviour, so it needs QA
	fs.mkdirSync(path.join(root, 'services/api'), { recursive: true });
	fs.writeFileSync(path.join(root, 'services/api/a.js'), '1');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'api');
	refused(() => markNa({ root, key: 'X-1', profile: 'web', reason: 'backend only change' }), /can alter behaviour.*services\/api\/a\.js/);
	refused(() => markNa({ root, key: 'X-1', profile: 'service', reason: 'a worker change' }), /can alter behaviour/);
	// a UI file is refused the same way
	fs.mkdirSync(path.join(root, 'web/src'), { recursive: true });
	fs.writeFileSync(path.join(root, 'web/src/App.vue'), '1');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'ui');
	refused(() => markNa({ root, key: 'X-1', profile: 'web', reason: 'backend only change' }), /can alter behaviour/);
});

test('the reason for not applicable has to say something, and a profile with no list cannot declare it', () => {
	const root = makeRepo();
	g(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
	g(root, 'checkout', '-qb', 'task/X-3-x');
	fs.writeFileSync(path.join(root, 'README.md'), '# hi');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'docs');
	refused(() => markNa({ root, key: 'X-3', profile: 'web', reason: 'docs' }), /at least 8 characters/);
	refused(() => markNa({ root, key: 'X-3', profile: 'no-such-profile', reason: 'documentation only' }), /no noBehaviourGlobs/);
	// a repository's own file that lists only nonUiGlobs keeps working: they are the fallback
	fs.writeFileSync(path.join(root, 'dev-factory.qa.yaml'), 'web:\n  uiGlobs:\n    - "**/*.vue"\n  nonUiGlobs:\n    - "**/*.md"\n');
	assert.equal(markNa({ root, key: 'X-3', profile: 'web', reason: 'documentation only' }).verdict, 'not_applicable');
	assert.deepEqual(noBehaviourGlobsFor(root, 'web'), ['**/*.md']);
	assert.ok(noBehaviourGlobsFor(makeRepo(), 'service').includes('docs/**'), 'the shipped service profile');
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
	refused(() => markNa({ root, key: 'X-2', profile: 'mobile', reason: 'documentation only' }), /can alter behaviour.*Screen\.swift/);
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

test('triggeredAxes maps changed paths to specialist axes, and an unreadable base requires every configured axis', () => {
	const root = withDiff(['services/api/migrations/001.sql', 'src/a.js']);
	assert.deepEqual(triggeredAxes({ root, specialistAxes: AXES_CFG, base: 'origin-develop' }), ['data']);
	assert.deepEqual(
		triggeredAxes({ root, specialistAxes: AXES_CFG, base: 'no-such-ref' }),
		Object.keys(AXES_CFG).filter((a) => AXES_CFG[a].length),
		'not reading the diff is never a reason to skip a review',
	);
	assert.deepEqual(triggeredAxes({ root, specialistAxes: {}, base: 'no-such-ref' }), [], 'with nothing configured there is nothing to require');
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
	assert.match(attributionProblems(root, 'HEAD', 'origin/no-such-base')[0], /could not be read/, 'an unknown base is not a clean verdict');
});

// ---- verdicts survive a merge of the base ----
import { diffHash, dirtyFiles } from '../bin/qa.mjs';
import { seal } from '../scripts/env-build-files.mjs';

// develop (also origin/develop) plus a task branch with one commit of its own.
function branchWithWork() {
	const root = makeRepo();
	g(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
	g(root, 'checkout', '-qb', 'task/APP-1-x');
	fs.mkdirSync(path.join(root, 'src'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src/feature.js'), 'a\nb\nc\nd\ne\n');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'feature');
	return root;
}
// The base moves on (an unrelated file, and a line above the ticket's own code), then is merged into the branch.
function mergeBaseIn(root, { absorbTicketFile = false } = {}) {
	g(root, 'checkout', '-q', 'develop');
	fs.writeFileSync(path.join(root, 'other.txt'), 'base work\n');
	if (absorbTicketFile) {
		// the base lands the very same file: the ticket's change shrinks, so what was walked is no longer the change
		fs.mkdirSync(path.join(root, 'src'), { recursive: true });
		fs.writeFileSync(path.join(root, 'src/feature.js'), 'a\nb\nc\nd\ne\n');
	}
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'base moved');
	g(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
	g(root, 'checkout', '-q', 'task/APP-1-x');
	g(root, 'merge', '-q', '--no-edit', 'develop');
}

test('the change hash ignores a merged-in base and notices a different change', () => {
	const root = branchWithWork();
	const before = diffHash(root, 'HEAD', 'origin/develop');
	assert.match(before, /^[0-9a-f]{64}$/);
	mergeBaseIn(root);
	assert.equal(diffHash(root, 'HEAD', 'origin/develop'), before, 'same change after the merge');
	fs.appendFileSync(path.join(root, 'src/feature.js'), 'more\n');
	g(root, 'commit', '-qam', 'more');
	assert.notEqual(diffHash(root, 'HEAD', 'origin/develop'), before);
	assert.equal(diffHash(root, 'HEAD', 'origin/nope'), null);
});

test('a QA verdict and the reviews survive a merge of the base, and verify reports where they came from', () => {
	const root = branchWithWork();
	const run = passedRun(root);
	const h0 = head(root);
	reviewRecord({ root, axis: 'spec', head: h0, summary: SUMMARY, findings: '[]' });
	reviewRecord({ root, axis: 'standards', head: h0, summary: SUMMARY, findings: '[]' });
	mergeBaseIn(root);
	const h1 = head(root);
	assert.notEqual(h0, h1);
	const v = verify({ root, head: h1, key: 'APP-1', requireReview: true });
	assert.equal(v.ok, true);
	assert.equal(v.carriedFrom, h0);
	assert.equal(v.prHead, h1);
	const st = reviewStatus({ root, head: h1 });
	assert.equal(st.clean, true);
	assert.equal(st.axes.spec.carriedFrom, h0);
	// by run number too
	assert.equal(verify({ root, head: h1, run }).carriedFrom, h0);
	// at its own head nothing is "carried"
	assert.equal(verify({ root, head: h0, key: 'APP-1', requireReview: true }).carriedFrom, undefined);
});

test('a change to the ticket’s own diff, or a base merge that alters it, ends the carry', () => {
	const root = branchWithWork();
	passedRun(root);
	const h0 = head(root);
	reviewRecord({ root, axis: 'spec', head: h0, summary: SUMMARY, findings: '[]' });
	reviewRecord({ root, axis: 'standards', head: h0, summary: SUMMARY, findings: '[]' });
	fs.appendFileSync(path.join(root, 'src/feature.js'), 'f\n');
	g(root, 'commit', '-qam', 'own change after QA');
	refused(() => verify({ root, head: head(root), key: 'APP-1' }), /no QA run at|is not the PR head/);

	const other = branchWithWork();
	passedRun(other);
	const o0 = head(other);
	reviewRecord({ root: other, axis: 'spec', head: o0, summary: SUMMARY, findings: '[]' });
	mergeBaseIn(other, { absorbTicketFile: true });
	refused(() => verify({ root: other, head: head(other), key: 'APP-1' }), /no QA run at|is not the PR head/);
	assert.equal(reviewStatus({ root: other, head: head(other) }).axes.spec, null);
});

test('a failed run is never carried, and a head that is not a descendant is not either', () => {
	const root = branchWithWork();
	const m = start({ root, key: 'APP-1', profile: 'web' });
	record({ root, run: m.run, caseSlug: 'login', status: 'fail', assertion: 'login screen missing', screenshot: png(root, 'f1', 21) });
	record({ root, run: m.run, caseSlug: 'arm', status: 'pass', assertion: 'armed banner visible', screenshot: png(root, 'f2', 22) });
	done({ root, run: m.run });
	mergeBaseIn(root);
	refused(() => verify({ root, head: head(root), key: 'APP-1' }), /no QA run at/);
});

test('a not-applicable record is carried the same way', () => {
	const root = makeRepo();
	g(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
	g(root, 'checkout', '-qb', 'task/APP-1-x');
	fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
	fs.writeFileSync(path.join(root, 'docs/note.md'), 'note\n');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'docs only');
	markNa({ root, key: 'APP-1', profile: 'web', reason: 'documentation only change' });
	mergeBaseIn(root);
	const v = verify({ root, head: head(root), key: 'APP-1' });
	assert.equal(v.verdict, 'not_applicable');
	assert.ok(v.carriedFrom);
});

// ---- build files the environment step rewrote ----

test('a build file the environment rewrote does not dirty the tree, but the ticket’s own edit to it does', () => {
	const root = makeRepo();
	fs.mkdirSync(path.join(root, 'ios'), { recursive: true });
	fs.writeFileSync(path.join(root, 'ios/Podfile.lock'), 'PODS: []\n');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'pods');
	fs.writeFileSync(path.join(root, 'ios/Podfile.lock'), 'PODS: [rewritten-by-install]\n');
	assert.deepEqual(dirtyFiles(root), ['ios/Podfile.lock'], 'dirty before it is sealed');
	assert.deepEqual(seal({ worktree: root, globs: ['ios/Podfile.lock'] }).sealed, ['ios/Podfile.lock']);
	assert.deepEqual(dirtyFiles(root), [], 'sealed: the environment’s rewrite');
	const m = start({ root, key: 'APP-1', profile: 'web' });
	assert.equal(m.run, 1, 'a walk can start');
	fs.appendFileSync(path.join(root, 'ios/Podfile.lock'), '# the ticket edited this\n');
	assert.deepEqual(dirtyFiles(root), ['ios/Podfile.lock'], 'a ticket’s own edit is dirty again');
	fs.writeFileSync(path.join(root, 'ios/Podfile.lock'), 'PODS: [rewritten-by-install]\n');
	assert.deepEqual(dirtyFiles(root), [], 'back to what was sealed');
});

test('only files that match the globs and are changed are sealed', () => {
	const root = makeRepo();
	fs.writeFileSync(path.join(root, 'package-lock.json'), '{}\n');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'lock');
	fs.writeFileSync(path.join(root, 'package-lock.json'), '{"a":1}\n');
	fs.writeFileSync(path.join(root, 'src.js'), 'x\n');
	assert.deepEqual(seal({ worktree: root, globs: ['package-lock.json'] }).sealed, ['package-lock.json']);
	assert.deepEqual(dirtyFiles(root), ['src.js'], 'a file outside the globs stays dirty');
	assert.deepEqual(seal({ worktree: root, globs: ['nothing/**'] }).sealed, []);
});

// ---- api and worker cases, probes, videos and logs ----
import http from 'node:http';
import { caseSummary, listCaseFiles, probe } from '../bin/qa.mjs';
import { LIMITS, allowedHosts, checkRequest, probe as sendProbe } from '../scripts/probe-lib.mjs';

function serviceRepo({ env = null } = {}) {
	const root = makeRepo();
	const dir = path.join(root, '.factory/qa/cases/APP-2');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'create-order.api.md'), '# POST /orders answers 201\n');
	fs.writeFileSync(path.join(dir, 'send-receipt.worker.md'), '# the receipt job sends one email\n');
	fs.writeFileSync(path.join(dir, 'order-screen.yaml'), 'appId: x\n');
	fs.writeFileSync(path.join(dir, 'notes.md'), 'not a case\n');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'service cases');
	if (env) {
		fs.mkdirSync(path.join(root, '.dev-factory'), { recursive: true });
		fs.writeFileSync(path.join(root, '.dev-factory/env.json'), JSON.stringify(env));
	}
	return root;
}
const answer =
	(status, body = '{"ok":true}', headers = { 'content-type': 'application/json' }) =>
	async () =>
		new Response(body, { status, headers });
const mp4 = (root, name, seed = 5, size = 4096) => {
	const f = path.join(`${root}-shots`, `${name}.mp4`);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	const b = Buffer.alloc(size, seed);
	Buffer.from('00000018667479706d703432', 'hex').copy(b);
	fs.writeFileSync(f, b);
	return f;
};
const textFile = (root, name, text) => {
	const f = path.join(`${root}-shots`, name);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, text);
	return f;
};

test('a case file is a ui, api or worker case by its name, and the run counts them per kind', () => {
	const root = serviceRepo();
	assert.deepEqual(listCaseFiles(root, 'APP-2'), [
		{ slug: 'create-order.api', kind: 'api' },
		{ slug: 'order-screen', kind: 'ui' },
		{ slug: 'send-receipt.worker', kind: 'worker' },
	]);
	const m = start({ root, key: 'APP-2', profile: 'service' });
	assert.deepEqual(
		m.cases.map((c) => `${c.slug}:${c.kind}`),
		['create-order.api:api', 'order-screen:ui', 'send-receipt.worker:worker'],
	);
	assert.deepEqual(caseSummary([{ kind: 'api', status: 'pass' }, { kind: 'api', status: 'fail' }, { kind: 'ui' }, {}]), {
		api: { total: 2, passed: 1, failed: 1 },
		ui: { total: 2, passed: 0, failed: 0 },
	});
});

test('an api case passes on a probe that got the answer it expected, or on a screenshot; a probe that did not is not a pass', async () => {
	const root = serviceRepo();
	const m = start({ root, key: 'APP-2', profile: 'service' });
	const base = { root, run: m.run, caseSlug: 'create-order.api' };
	refused(() => record({ ...base, status: 'pass', assertion: 'the order was created' }), /at least one screenshot or probe/);
	const bad = await probe({
		...base,
		url: 'http://localhost:3000/orders',
		method: 'POST',
		body: '{"sku":1}',
		expectStatus: 201,
		fetchImpl: answer(500, 'boom'),
	});
	assert.equal(bad.ok, false);
	refused(() => record({ ...base, status: 'pass', assertion: 'the order was created' }), /did not get the expected answer/);
	const good = await probe({
		...base,
		url: 'http://localhost:3000/orders',
		method: 'POST',
		body: '{"sku":1}',
		expectStatus: 201,
		step: 2,
		fetchImpl: answer(201, '{"id":7}'),
	});
	assert.equal(good.ok, true);
	assert.equal(good.probe.status, 201);
	const r = record({ ...base, status: 'pass', assertion: 'POST /orders answered 201 with the new id' });
	assert.equal(r.case.status, 'pass');
	// the probe file is evidence: verify checks its hash
	const stored = JSON.parse(fs.readFileSync(path.join(root, good.file), 'utf8'));
	assert.equal(stored.status, 201);
	assert.equal(stored.bodyExcerpt, '{"id":7}');
	// a failing case needs no evidence
	assert.equal(record({ root, run: m.run, caseSlug: 'order-screen', status: 'fail', assertion: 'the screen did not render' }).case.status, 'fail');
});

test('a worker case passes on the worker’s own output, never on a video or a log alone', () => {
	const root = serviceRepo();
	const m = start({ root, key: 'APP-2', profile: 'service' });
	const base = { root, run: m.run, caseSlug: 'send-receipt.worker', status: 'pass', assertion: 'the receipt job sent one email' };
	refused(() => record(base), /at least one screenshot or piece of worker evidence/);
	refused(() => record({ ...base, video: mp4(root, 'v1') }), /a video or a log alone does not pass a case/);
	refused(() => record({ ...base, log: textFile(root, 'job.log', 'job started\njob done\n') }), /a video or a log alone does not pass a case/);
	refused(() => record({ ...base, kind: 'worker' }), /--kind worker together with --evidence-file/);
	refused(() => record({ ...base, evidenceFile: textFile(root, 'e.txt', 'x') }), /--kind worker together with --evidence-file/);
	refused(() => record({ ...base, kind: 'worker', evidenceFile: textFile(root, 'e.txt', 'sent') }), /at least 32 characters/);
	refused(
		() =>
			record({
				root,
				run: m.run,
				caseSlug: 'create-order.api',
				status: 'pass',
				assertion: 'an api case',
				kind: 'worker',
				evidenceFile: textFile(root, 'e2.txt', 'x'.repeat(60)),
			}),
		/belongs to a \.worker\.md case/,
	);
	const r = record({
		...base,
		kind: 'worker',
		evidenceFile: textFile(root, 'out.txt', 'job 41 finished; sent 1 email to the queue topic receipts; mail id 7'),
	});
	assert.equal(r.case.status, 'pass');
	assert.deepEqual(
		r.evidenceAdded.map((e) => e.type),
		['worker'],
	);
	// the same output cannot be reused for another case
	const other = start({ root, key: 'APP-2', profile: 'service' });
	record({
		root,
		run: other.run,
		caseSlug: 'send-receipt.worker',
		status: 'fail',
		assertion: 'first try failed',
		kind: 'worker',
		evidenceFile: textFile(root, 'again.txt', 'job 41 finished; sent 1 email to the queue topic receipts; mail id 7'),
	});
});

test('videos need the right magic bytes and size, logs are kept as a redacted tail, and both are only support', () => {
	const root = serviceRepo();
	const m = start({ root, key: 'APP-2', profile: 'service' });
	const base = { root, run: m.run, caseSlug: 'order-screen', status: 'pass', assertion: 'the order screen shows the new order' };
	const notVideo = path.join(`${root}-shots`, 'fake.mp4');
	fs.mkdirSync(path.dirname(notVideo), { recursive: true });
	fs.writeFileSync(notVideo, Buffer.alloc(4096, 7));
	refused(() => record({ ...base, video: notVideo }), /not an MP4, MOV or WebM/);
	refused(() => record({ ...base, video: mp4(root, 'tiny', 3, 100) }), /at least 1024/);
	const webm = path.join(`${root}-shots`, 'a.webm');
	fs.writeFileSync(webm, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(3000, 9)]));
	const noisy = [
		'start',
		...Array.from({ length: 400 }, (_, i) => `line ${i} user jane.doe@example.com token Bearer abcdefghijklmnop${i}`),
		'the end',
	].join('\n');
	const r = record({
		...base,
		screenshot: png(root, 'order', 31),
		video: webm,
		log: textFile(root, 'run.log', noisy),
		secrets: [],
	});
	assert.deepEqual(
		r.evidenceAdded.map((e) => e.type),
		['image', 'video', 'log'],
	);
	const log = fs.readFileSync(path.join(root, r.evidenceAdded[2].file), 'utf8');
	assert.ok(Buffer.byteLength(log) <= 8 * 1024, 'a tail, not the whole log');
	assert.match(log, /the end$/);
	assert.doesNotMatch(log, /jane\.doe|abcdefghijklmnop/);
	assert.match(log, /\[redacted:email address\]/);
	assert.doesNotMatch(log, /^start/m, 'the oldest lines are the ones dropped');
	const done1 = (() => {
		for (const slug of ['create-order.api', 'send-receipt.worker'])
			record({ root, run: m.run, caseSlug: slug, status: 'fail', assertion: `${slug} not walked here` });
		return done({ root, run: m.run });
	})();
	assert.equal(done1.verdict, 'fail');
	assert.deepEqual(done1.caseSummary, {
		api: { total: 1, passed: 0, failed: 1 },
		ui: { total: 1, passed: 1, failed: 0 },
		worker: { total: 1, passed: 0, failed: 1 },
	});
});

test('literal secrets named by env.json are removed from kept logs and worker output', () => {
	const root = serviceRepo({ env: { secretEnv: ['QA_ACCOUNT_PASSWORD'] } });
	process.env.QA_ACCOUNT_PASSWORD = 'correct-horse-battery';
	try {
		const m = start({ root, key: 'APP-2', profile: 'service' });
		const r = record({
			root,
			run: m.run,
			caseSlug: 'send-receipt.worker',
			status: 'pass',
			assertion: 'the worker sent the receipt mail',
			kind: 'worker',
			evidenceFile: textFile(root, 'w.txt', 'signed in with correct-horse-battery and sent the receipt'),
			secrets: ['correct-horse-battery'],
		});
		const stored = fs.readFileSync(path.join(root, r.evidenceAdded[0].file), 'utf8');
		assert.equal(stored, 'signed in with [redacted:secret] and sent the receipt');
	} finally {
		delete process.env.QA_ACCOUNT_PASSWORD;
	}
});

test('a probe is sent only to this machine or to a host env.json names, and nothing sensitive is kept or echoed', async () => {
	const env = { hosts: ['api.staging.test'], webBaseUrl: 'https://app.example.test:8443/x', remote: { url: 'https://r.example.test' } };
	assert.deepEqual([...allowedHosts(env)].sort(), ['127.0.0.1', '[::1]', 'api.staging.test', 'app.example.test', 'localhost', 'r.example.test']);
	const ok = (url, extra = {}) => checkRequest({ url, env, ...extra });
	for (const url of [
		'http://localhost:3000/x',
		'http://127.0.0.1/x',
		'http://[::1]:8080/x',
		'https://api.staging.test/x',
		'https://APP.example.test/x',
		'https://r.example.test/x',
	])
		assert.ok(ok(url).url, url);
	const refusedWith = (url, re, extra) =>
		assert.throws(
			() => ok(url, extra),
			(e) => re.test(e.message) && !e.message.includes(url),
			`${url}`,
		);
	refusedWith('https://evil.example/x', /not this machine and not named/);
	refusedWith('http://localhost.evil.test/x', /not this machine/);
	refusedWith('http://127.0.0.2/x', /not this machine/);
	refusedWith('http://0x7f.1/x'.replace('0x7f.1', '10.0.0.1'), /not this machine/);
	refusedWith('http://user:pw@localhost/x', /credentials/);
	refusedWith('http://:pw@localhost/x', /credentials/);
	refusedWith('ftp://localhost/x', /only http and https/);
	refusedWith('not a url', /does not parse/);
	refusedWith('http://localhost/x', /method must be/, { method: 'TRACE' });
	refusedWith('http://localhost/x', /over 65536 bytes/, { bodyBytes: LIMITS.requestBody + 1 });
	for (const bad of ['X-A: b\r\nX-Evil: 1', 'X-A: b\nX-Evil: 1', 'X-A: b\0', 'no colon', ': valuex', 'Bad Name: v'])
		assert.throws(
			() => ok('http://localhost/x', { headers: [bad] }),
			(e) => !e.message.includes('Evil') && !e.message.includes(bad),
			bad,
		);
	for (const h of ['Host: x', 'content-length: 5']) assert.throws(() => ok('http://localhost/x', { headers: [h] }), /set by the request itself/);
	assert.deepEqual(
		ok('http://localhost/x', { headers: ['Authorization: Bearer abc', 'X-Trace: 1'], method: 'post' }).headers.map(([n]) => n),
		['Authorization', 'X-Trace'],
	);
});

test('a probe keeps header names, never their values, and a little of the redacted answer', async () => {
	const seen = [];
	const fetchImpl = async (url, init) => (
		seen.push({ url: String(url), init }),
		new Response('hello jane.doe@example.com ' + 'x'.repeat(10_000), {
			status: 200,
			headers: { 'content-type': 'text/plain', 'set-cookie': 'sid=abc' },
		})
	);
	const rec = await sendProbe({
		url: 'http://localhost:3000/orders?token=SECRETQUERY&page=2',
		method: 'POST',
		headers: ['Authorization: Bearer abcdefghijklmnop1234', 'X-Req: 1'],
		body: '{"password":"hunter2"}',
		fetchImpl,
	});
	assert.equal(seen[0].init.redirect, 'manual', 'a redirect is never followed');
	assert.equal(seen[0].init.headers.Authorization, 'Bearer abcdefghijklmnop1234', 'the value is sent');
	const stored = JSON.stringify(rec);
	for (const leak of ['abcdefghijklmnop1234', 'hunter2', 'SECRETQUERY', 'jane.doe@example.com', 'sid=abc'])
		assert.ok(!stored.includes(leak), `${leak} is not kept`);
	assert.deepEqual(rec.requestHeaderNames, ['Authorization', 'X-Req']);
	assert.deepEqual(rec.queryNames, ['token', 'page']);
	assert.equal(rec.path, '/orders');
	assert.equal(rec.requestBodyBytes, 22);
	assert.ok(rec.responseHeaderNames.includes('content-type'), 'the names of the answer’s headers are kept');
	assert.ok(rec.bodyExcerpt.length <= LIMITS.excerpt);
	assert.equal(
		rec.bodyBytes,
		'hello jane.doe@example.com '.length + 10_000,
		'the whole answer was read (under 64 KB) and only the excerpt is kept',
	);
	assert.equal(rec.truncated, true);
	assert.match(rec.bodyExcerpt, /^hello \[redacted:email address\]/);
});

test('a probe reads at most 64 KB, ends at 15 seconds, and a failure names no request value', async () => {
	const big = new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(16 * 1024).fill(97)) }), { status: 200 });
	const rec = await sendProbe({ url: 'http://localhost/x', fetchImpl: async () => big });
	assert.equal(rec.bodyBytes, LIMITS.read);
	assert.equal(rec.truncated, true);
	const failing = async () => {
		throw Object.assign(new Error('connect ECONNREFUSED http://localhost/x?token=SECRETQUERY with Authorization: Bearer zzz'), {
			cause: { code: 'ECONNREFUSED' },
		});
	};
	await assert.rejects(
		sendProbe({ url: 'http://localhost/x?token=SECRETQUERY', headers: ['Authorization: Bearer zzz'], fetchImpl: failing }),
		(e) => /request failed \(ECONNREFUSED\)/.test(e.message) && !/SECRETQUERY|zzz|localhost/.test(e.message),
	);
	const slow = async (url, init) => {
		init.signal.throwIfAborted(); // the signal is already spent: that is what a 15 second wait looks like here
		return new Response('never');
	};
	const realTimeout = AbortSignal.timeout;
	AbortSignal.timeout = () => AbortSignal.abort(Object.assign(new Error('t'), { name: 'TimeoutError' }));
	try {
		await assert.rejects(sendProbe({ url: 'http://localhost/x', fetchImpl: slow }), /no answer within 15 seconds/);
	} finally {
		AbortSignal.timeout = realTimeout;
	}
	assert.equal(LIMITS.timeoutMs, 15_000);
});

test('qa.mjs probe sends a real request and registers it; the CLI refuses a host that is not allowed', async () => {
	const server = http.createServer((req, res) => {
		res.writeHead(201, { 'content-type': 'application/json' });
		res.end('{"id":7}');
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const port = server.address().port;
	try {
		const root = serviceRepo();
		const m = start({ root, key: 'APP-2', profile: 'service' });
		const run = (...a) =>
			new Promise((resolve) => {
				const c = spawn(process.execPath, [QA, ...a, '--worktree', root]);
				let stdout = '';
				let stderr = '';
				c.stdout.on('data', (d) => (stdout += d));
				c.stderr.on('data', (d) => (stderr += d));
				c.on('close', (status) => resolve({ status, stdout, stderr }));
			});
		const ok = await run(
			'probe',
			'--run',
			String(m.run),
			'--case',
			'create-order.api',
			'--url',
			`http://127.0.0.1:${port}/orders`,
			'--method',
			'POST',
			'--header',
			'X-A: 1',
			'--header',
			'X-B: 2',
			'--expect-status',
			'201',
		);
		assert.equal(ok.status, 0, ok.stderr);
		const out = JSON.parse(ok.stdout);
		assert.equal(out.probe.status, 201);
		assert.deepEqual(
			JSON.parse(fs.readFileSync(path.join(root, out.file), 'utf8')).requestHeaderNames,
			['X-A', 'X-B'],
			'a repeated --header is read each time',
		);
		const no = await run('probe', '--run', String(m.run), '--case', 'create-order.api', '--url', 'https://example.com/x');
		assert.equal(no.status, 1);
		assert.match(no.stderr, /probe refused or failed: that host is not this machine/);
		assert.doesNotMatch(no.stderr, /example\.com/);
		const rec = await run(
			'record',
			'--run',
			String(m.run),
			'--case',
			'create-order.api',
			'--status',
			'pass',
			'--assertion',
			'POST /orders answered 201 as expected',
		);
		assert.equal(rec.status, 0, rec.stderr);
	} finally {
		server.close();
	}
});

test('verify reports the case counts per kind and still checks every kind of evidence file', async () => {
	const root = serviceRepo();
	const m = start({ root, key: 'APP-2', profile: 'service' });
	const p = await probe({ root, run: m.run, caseSlug: 'create-order.api', url: 'http://localhost/o', expectStatus: 200, fetchImpl: answer(200) });
	record({ root, run: m.run, caseSlug: 'create-order.api', status: 'pass', assertion: 'GET /o answered 200' });
	record({
		root,
		run: m.run,
		caseSlug: 'send-receipt.worker',
		status: 'pass',
		assertion: 'the job sent the mail',
		kind: 'worker',
		evidenceFile: textFile(root, 'j.txt', 'job 9 finished and sent one mail to the queue'),
	});
	record({ root, run: m.run, caseSlug: 'order-screen', status: 'pass', assertion: 'the screen lists the order', screenshot: png(root, 's', 44) });
	done({ root, run: m.run });
	const v = verify({ root, head: head(root), run: m.run });
	assert.deepEqual(v.caseSummary, {
		api: { total: 1, passed: 1, failed: 0 },
		ui: { total: 1, passed: 1, failed: 0 },
		worker: { total: 1, passed: 1, failed: 0 },
	});
	fs.appendFileSync(path.join(root, p.file), ' ');
	refused(() => verify({ root, head: head(root), run: m.run }), /evidence changed since recorded/);
});

// ---- review findings ----
import { carried } from '../bin/qa.mjs';

test('a verdict is not carried to a commit that is not built on the one it was made at, even for an identical change', () => {
	const root = branchWithWork();
	passedRun(root);
	const h0 = head(root);
	// the same change, made again on its own branch from the base: same diff, a different history
	g(root, 'checkout', '-qb', 'task/APP-1-again', 'origin/develop');
	g(root, 'cherry-pick', '--no-commit', h0);
	g(root, 'commit', '-qm', 'the same change, made again'); // a different message: the same author, time and tree would give the same commit id
	const h1 = head(root);
	assert.notEqual(h0, h1);
	assert.equal(diffHash(root, h0, 'origin/develop'), diffHash(root, h1, 'origin/develop'), 'the change is the same');
	assert.equal(
		carried(root, { head: h0, diffHash: diffHash(root, h0, 'origin/develop') }, h1, 'origin/develop'),
		false,
		'the head is not a descendant',
	);
	refused(() => verify({ root, head: h1, key: 'APP-1' }), /no QA run at/);
});

test('the same lines moved elsewhere in a file are a different change', () => {
	const root = makeRepo();
	fs.mkdirSync(path.join(root, 'src'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src/a.js'), 'if (ok) {\n  x();\n}\ny();\nz();\n');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'file');
	g(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
	g(root, 'checkout', '-qb', 'inside');
	fs.writeFileSync(path.join(root, 'src/a.js'), 'if (ok) {\n  x();\n  guard();\n}\ny();\nz();\n');
	g(root, 'commit', '-qam', 'guard inside the block');
	const inside = diffHash(root, 'HEAD', 'origin/develop');
	g(root, 'checkout', '-qb', 'outside', 'origin/develop');
	fs.writeFileSync(path.join(root, 'src/a.js'), 'if (ok) {\n  x();\n}\ny();\n  guard();\nz();\n');
	g(root, 'commit', '-qam', 'guard after y');
	assert.notEqual(diffHash(root, 'HEAD', 'origin/develop'), inside);
	// ...while unrelated work above it, which only shifts line numbers, does not change the hash
	g(root, 'checkout', '-q', 'inside');
	g(root, 'checkout', '-q', 'develop');
	fs.writeFileSync(path.join(root, 'src/a.js'), '// header\n// header\nif (ok) {\n  x();\n}\ny();\nz();\n');
	g(root, 'commit', '-qam', 'base adds a header');
	g(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
	g(root, 'checkout', '-q', 'inside');
	g(root, 'merge', '-q', '--no-edit', 'develop');
	assert.equal(diffHash(root, 'HEAD', 'origin/develop'), inside, 'a header added above shifts numbers, not the change');
});

test('moving code to a documentation path is not a documentation change: a rename lists both paths', () => {
	const root = makeRepo();
	g(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
	g(root, 'checkout', '-qb', 'task/X-9-x');
	fs.mkdirSync(path.join(root, 'src'), { recursive: true });
	fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src/server.js'), 'listen();\n'.repeat(20));
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'server');
	g(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
	g(root, 'mv', 'src/server.js', 'docs/server.md');
	g(root, 'commit', '-qm', 'move the server into docs');
	refused(() => markNa({ root, key: 'X-9', profile: 'web', reason: 'documentation only' }), /src\/server\.js/);
});

test('evidence of a case is one file per step: a second probe takes the next step, a second capture at a taken step is refused', async () => {
	const root = serviceRepo();
	const m = start({ root, key: 'APP-2', profile: 'service' });
	const base = { root, run: m.run, caseSlug: 'create-order.api' };
	const first = await probe({ ...base, url: 'http://localhost/o', expectStatus: 201, fetchImpl: answer(500, 'boom') });
	const second = await probe({ ...base, url: 'http://localhost/o', expectStatus: 201, fetchImpl: answer(201, '{"id":1}') });
	assert.notEqual(first.file, second.file, 'the earlier answer stays on record');
	assert.match(second.file, /-probe-2\.json$/);
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, first.file), 'utf8')).status, 500);
	await assert.rejects(
		probe({ ...base, url: 'http://localhost/o', step: 2, fetchImpl: answer(200) }),
		/step 2 of case create-order\.api already holds evidence/,
	);
	record({ ...base, status: 'pass', assertion: 'POST /o answered 201 on the retry' });
	record({ root, run: m.run, caseSlug: 'order-screen', status: 'pass', assertion: 'the order screen shows it', screenshot: png(root, 'p1', 61) });
	refused(
		() =>
			record({
				root,
				run: m.run,
				caseSlug: 'order-screen',
				status: 'fail',
				assertion: 'a second look at the screen',
				screenshot: png(root, 'p2', 62),
			}),
		/step 1 of case order-screen already holds evidence/,
	);
	record({
		root,
		run: m.run,
		caseSlug: 'send-receipt.worker',
		status: 'pass',
		assertion: 'the job mailed the receipt',
		kind: 'worker',
		evidenceFile: textFile(root, 'wk.txt', 'job 12 finished and sent one email to the receipts queue topic'),
	});
	done({ root, run: m.run });
	assert.equal(
		verify({ root, head: head(root), run: m.run }).ok,
		true,
		'and the run still verifies, which an overwritten file would have prevented',
	);
});

test('a screen is shown by a picture: a probe cannot pass a ui case, nor worker output an api case', async () => {
	const root = serviceRepo();
	const m = start({ root, key: 'APP-2', profile: 'service' });
	await probe({ root, run: m.run, caseSlug: 'order-screen', url: 'http://localhost/o', fetchImpl: answer(200) });
	refused(
		() => record({ root, run: m.run, caseSlug: 'order-screen', status: 'pass', assertion: 'the order screen is up' }),
		/at least one screenshot/,
	);
	refused(
		() => record({ root, run: m.run, caseSlug: 'send-receipt.worker', status: 'pass', assertion: 'the job did it', screenshot: undefined }),
		/at least one screenshot or piece of worker evidence/,
	);
});

test('globs: ** is any depth of folders, not a prefix of a name', () => {
	const re = (g) => globToRegExp(g);
	assert.equal(re('**/tests/**').test('src/latests/handler.js'), false);
	assert.equal(re('**/tests/**').test('tests/a.js'), true);
	assert.equal(re('**/tests/**').test('a/b/tests/c/d.js'), true);
	assert.equal(re('**/*.md').test('README.md'), true);
	assert.equal(re('**/*.md').test('docs/a/b.md'), true);
	assert.equal(re('**/*.md').test('README.mdx'), false);
	assert.equal(re('docs/**').test('docs/a/b.md'), true);
	assert.equal(re('docs/**').test('xdocs/a.md'), false);
	assert.equal(re('.github/workflows/**').test('.github/workflows/ci.yml'), true);
	assert.equal(re('ios/*.xcodeproj/project.pbxproj').test('ios/App.xcodeproj/project.pbxproj'), true);
	assert.equal(re('*.json').test('a/b.json'), false, 'a single star stays in one folder');
	assert.equal(re('a?c').test('abc'), true);
});

test('ticket remote prints the Remote-QA request of a ticket, or null', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-remote-'));
	const f = path.join(dir, 't.md');
	const run = () => JSON.parse(spawnSync(process.execPath, [QA, 'ticket', 'remote', '--file', f], { encoding: 'utf8' }).stdout);
	fs.writeFileSync(f, 'Summary\nRemote-QA: staging (account: reviewer)\n');
	assert.deepEqual(run(), { remote: { env: 'staging', account: 'reviewer' } });
	fs.writeFileSync(f, 'Summary only\n');
	assert.deepEqual(run(), { remote: null });
});

test('a record is carried only to a descendant of the commit it was made at (carried checks ancestry, not just the change hash)', async () => {
	const { carried } = await import('../bin/qa.mjs');
	const root = branchWithWork();
	const h0 = head(root);
	const rec = { head: h0, diffHash: diffHash(root, h0, 'origin/develop') };
	// a sibling commit with the very same change: same diff hash, but not built on h0
	g(root, 'checkout', '-q', 'develop');
	g(root, 'checkout', '-qb', 'sibling');
	fs.mkdirSync(path.join(root, 'src'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src/feature.js'), 'a\nb\nc\nd\ne\n');
	g(root, 'add', '-A');
	g(root, 'commit', '-qm', 'the same change, made apart');
	const sibling = head(root);
	assert.notEqual(sibling, h0);
	assert.equal(diffHash(root, sibling, 'origin/develop'), rec.diffHash, 'the change is identical');
	assert.equal(carried(root, rec, sibling, 'origin/develop'), false, 'but the sibling is not a descendant');
	assert.equal(carried(root, rec, h0, 'origin/develop'), true);
});

test('a standards review can be recorded after the base was merged in, when the spec review is carried', () => {
	const root = branchWithWork();
	const h0 = head(root);
	reviewRecord({ root, axis: 'spec', head: h0, summary: SUMMARY, findings: '[]' });
	mergeBaseIn(root);
	const h1 = head(root);
	const r = reviewRecord({ root, axis: 'standards', head: h1, summary: SUMMARY, findings: '[]', base: 'origin/develop' });
	assert.equal(r.head, h1);
});

test('an assertion may mention a colour or a page, and may not lean on another run', () => {
	const root = makeRepo();
	const m = start({ root, key: 'APP-1', profile: 'web' });
	const base = { root, run: m.run, caseSlug: 'login', status: 'pass' };
	record({ ...base, assertion: 'the button is colour #3b82f6 and says previous page', screenshot: png(root, 'c1', 31) });
	for (const bad of ['same as run 2', 'as in run #3', 'previously passed', 'passed in the previous run', 'see walk 1 for this']) {
		refused(() => record({ ...base, caseSlug: 'arm', assertion: bad, screenshot: png(root, 'c2', 32) }), /another run/);
	}
});

test('probe reads its body from a file and says when the file is missing', async () => {
	const root = serviceRepo();
	const m = start({ root, key: 'APP-2', profile: 'service' });
	const base = { root, run: m.run, caseSlug: 'create-order.api', url: 'http://localhost:3000/orders', method: 'POST', expectStatus: 201 };
	let sent = null;
	const ok = await probe({
		...base,
		bodyFile: textFile(root, 'body.json', '{"sku":7}'),
		fetchImpl: async (url, init) => (
			(sent = init.body), new Response('{"id":1}', { status: 201, headers: { 'content-type': 'application/json' } })
		),
	});
	assert.equal(ok.ok, true);
	assert.equal(sent, '{"sku":7}');
	await assert.rejects(probe({ ...base, step: 2, bodyFile: path.join(root, 'nope.json'), fetchImpl: answer(201) }), /body file not found/);
});
