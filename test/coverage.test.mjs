import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { addedLines, classifyTestFile, lcovEntryFor, parseLcov, ranges, report, summary } from '../scripts/coverage-lib.mjs';
import { build, readTests, recordTests } from '../scripts/coverage.mjs';
import { load, merge, validate } from '../scripts/config.mjs';

const LCOV = `TN:
SF:/work/app/src/orders.ts
DA:1,1
DA:2,1
DA:3,0
DA:4,0
DA:5,2
DA:9,0
end_of_record
SF:src/util.ts
DA:1,3
DA:2,3
end_of_record
`;
const DIFF = `diff --git a/src/orders.ts b/src/orders.ts
--- a/src/orders.ts
+++ b/src/orders.ts
@@ -1,0 +1,5 @@
+a
+b
+c
+d
+e
@@ -8 +9 @@
-old
+new
diff --git a/src/gone.ts b/src/gone.ts
--- a/src/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-x
-y
-z
diff --git a/src/orders.test.ts b/src/orders.test.ts
--- /dev/null
+++ b/src/orders.test.ts
@@ -0,0 +1,2 @@
+t
+t
`;

test('lcov is parsed into executable lines and their hits', () => {
	const m = parseLcov(LCOV);
	assert.deepEqual([...m.keys()], ['/work/app/src/orders.ts', 'src/util.ts']);
	assert.equal(m.get('/work/app/src/orders.ts').get(5), 2);
	assert.equal(m.get('/work/app/src/orders.ts').has(6), false, 'a line with no DA is not executable');
	assert.equal(parseLcov('garbage\nDA:1,1\n').size, 0, 'a DA line outside a record is ignored');
});

test('the lines a change added are read from a zero-context diff, deletions and removed files count for nothing', () => {
	const a = addedLines(DIFF);
	assert.deepEqual([...a.get('src/orders.ts')], [1, 2, 3, 4, 5, 9]);
	assert.deepEqual([...a.get('src/orders.test.ts')], [1, 2]);
	assert.equal(a.has('src/gone.ts'), false);
});

test('an added line that reads like a file header is not one, and a quoted name is read as the file it is', () => {
	const tricky = [
		'diff --git a/src/a.js b/src/a.js',
		'--- a/src/a.js',
		'+++ b/src/a.js',
		'@@ -1,0 +1,2 @@',
		'+++ looks like a header',
		'+real line',
		'diff --git "a/src/\\303\\274.js" "b/src/\\303\\274.js"',
		'--- "a/src/\\303\\274.js"',
		'+++ "b/src/\\303\\274.js"',
		'@@ -0,0 +1 @@',
		'+x',
		'',
	].join('\n');
	const a = addedLines(tricky);
	assert.deepEqual([...a.keys()], ['src/a.js', 'src/ü.js']);
	assert.deepEqual([...a.get('src/a.js')], [1, 2], 'both lines are the change’s own');
	assert.deepEqual([...a.get('src/ü.js')], [1]);
});

test('an lcov path is matched to a repository file by absolute path, by suffix, and not at all when it is another file', () => {
	const lcov = parseLcov(LCOV);
	assert.equal(lcovEntryFor('src/orders.ts', lcov, '/work/app'), '/work/app/src/orders.ts');
	assert.equal(lcovEntryFor('packages/api/src/util.ts', lcov, '/work/app'), 'src/util.ts', 'lcov written relative to a package');
	assert.equal(lcovEntryFor('src/other.ts', lcov, '/work/app'), null);
	assert.equal(lcovEntryFor('xsrc/util.ts', lcov, '/work/app'), null, 'a suffix must be a whole path part');
});

test('the report counts the changed lines a test run reached and names the ones it did not', () => {
	const r = report({ diff: DIFF, lcovText: LCOV, root: '/work/app', unitGlobs: ['**/*.test.*'], functionalGlobs: ['**/e2e/**'] });
	assert.deepEqual(r.totals, { changed: 8, instrumented: 6, reached: 3, pct: 50 });
	assert.deepEqual(r.files, [{ file: 'src/orders.ts', changed: 6, instrumented: 6, reached: 3, missing: '3-4, 9' }]);
	assert.deepEqual(r.notInLcov, ['src/orders.test.ts']);
	assert.deepEqual(r.changedTests, { unit: 1, functional: 0 });
	assert.equal(r.note, null);
	assert.match(summary(r), /changed lines reached by a test run: 3 of 6 executable \(50%\)/);
	assert.match(summary(r), /src\/orders\.ts: 3\/6, not reached: 3-4, 9/);
	assert.equal(ranges([1, 2, 3, 7, 9, 10]), '1-3, 7, 9-10');
	assert.equal(classifyTestFile('e2e/a.spec.ts', { unitGlobs: ['**/*.spec.*'], functionalGlobs: ['**/e2e/**'] }), 'functional', 'functional wins');
	assert.equal(classifyTestFile('src/a.ts', { unitGlobs: ['**/*.test.*'] }), null);
});

test('the report says plainly when it has nothing to say: no data, no changed file in the data, nothing executable', () => {
	const noData = report({ diff: DIFF, lcovText: null, lcovPath: 'coverage/lcov.info' });
	assert.match(noData.note, /no coverage data was found at coverage\/lcov\.info: run the coverage command/);
	assert.equal(noData.totals.pct, null);
	const other = report({ diff: DIFF, lcovText: 'SF:/elsewhere/x.ts\nDA:1,1\nend_of_record\n', root: '/work/app', lcovPath: 'cov/lcov.info' });
	assert.match(other.note, /none of the 2 changed files is in the coverage data \(cov\/lcov\.info\): this report says nothing about the change/);
	assert.equal(other.files.length, 0);
	assert.match(report({ diff: '', lcovText: LCOV }).note, /adds no lines/);
	const comment = report({ diff: '--- a/src/util.ts\n+++ b/src/util.ts\n@@ -5 +5 @@\n+// c\n', lcovText: LCOV, root: '/work/app' });
	assert.match(comment.note, /not executable code/);
});

// ---- on a real repository ----
function repo() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-cov-')));
	const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
	g('init', '-q', '-b', 'develop');
	g('config', 'user.email', 't@t');
	g('config', 'user.name', 't');
	fs.mkdirSync(path.join(root, 'src'));
	fs.writeFileSync(path.join(root, 'src/orders.ts'), 'l1\nl2\n');
	g('add', '-A');
	g('commit', '-qm', 'base');
	g('update-ref', 'refs/remotes/origin/develop', 'HEAD');
	g('checkout', '-qb', 'task/X-1-x');
	fs.writeFileSync(path.join(root, 'src/orders.ts'), 'l1\nl2\nnew3\nnew4\nnew5\n');
	fs.writeFileSync(path.join(root, 'src/orders.test.ts'), 't\n');
	g('add', '-A');
	g('commit', '-qm', 'work');
	return root;
}

test('build reads the diff against the base and the lcov file from the configured path', () => {
	const root = repo();
	fs.mkdirSync(path.join(root, 'coverage'));
	fs.writeFileSync(path.join(root, 'coverage/lcov.info'), `SF:${root}/src/orders.ts\nDA:3,1\nDA:4,0\nDA:5,1\nend_of_record\n`);
	const r = build({ root, base: 'origin/develop' });
	assert.deepEqual(r.totals, { changed: 4, instrumented: 3, reached: 2, pct: 66.7 });
	assert.equal(r.files[0].missing, '4');
	assert.deepEqual(r.changedTests, { unit: 1, functional: 0 });
	const custom = merge(load(), { coverage: { lcovPath: 'out/missing.info' } });
	assert.match(build({ root, base: 'origin/develop', cfg: custom }).note, /no coverage data was found at out\/missing\.info/);
});

test('the builder’s test counts are kept per kind, validated, and shown as reported', () => {
	const root = repo();
	assert.equal(readTests(root), null);
	recordTests({ root, kind: 'unit', tests: 41, suites: 6, failed: 0, command: 'npm test', now: new Date('2026-10-01T10:00:00Z') });
	const all = recordTests({ root, kind: 'functional', tests: 3, now: new Date('2026-10-01T10:05:00Z') });
	assert.deepEqual(all.unit, { tests: 41, suites: 6, failed: 0, command: 'npm test', at: '2026-10-01T10:00:00.000Z' });
	assert.deepEqual(all.functional, { tests: 3, suites: null, failed: 0, command: null, at: '2026-10-01T10:05:00.000Z' });
	assert.equal(recordTests({ root, kind: 'unit', tests: 44, suites: 6 }).unit.tests, 44, 'the latest run replaces the earlier one');
	assert.throws(() => recordTests({ root, kind: 'smoke', tests: 1 }), /unit or functional/);
	assert.throws(() => recordTests({ root, kind: 'unit' }), /--tests is required/);
	assert.throws(() => recordTests({ root, kind: 'unit', tests: -1 }), /whole number/);
	assert.throws(() => recordTests({ root, kind: 'unit', tests: 'many' }), /whole number/);
	const text = summary(report({ diff: '', lcovText: null, tests: readTests(root) }));
	assert.match(text, /unit tests: 44 in 6 suite\(s\), 0 failed \(reported by the builder\)/);
	assert.match(text, /functional tests: 3 in \? suite\(s\)/);
});

test('the CLI records and reports, and its settings are validated', () => {
	const root = repo();
	const cli = (...a) =>
		spawnSync(process.execPath, [new URL('../scripts/coverage.mjs', import.meta.url).pathname, ...a, '--worktree', root], { encoding: 'utf8' });
	assert.equal(cli('record-tests', '--kind', 'unit', '--tests', '5').status, 0);
	const r = cli('report', '--base', 'origin/develop');
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /no coverage data was found at coverage\/lcov\.info/);
	assert.match(r.stdout, /unit tests: 5/);
	assert.equal(JSON.parse(cli('report', '--base', 'origin/develop', '--json').stdout).tests.unit.tests, 5);
	assert.equal(cli('bogus').status, 1);
	assert.equal(load().coverage.command, null);
	assert.equal(load().coverage.lcovPath, 'coverage/lcov.info');
	assert.deepEqual(
		validate(
			merge(load(), { coverage: { command: 'npm test -- --coverage', lcovPath: 'c/lcov.info', unitGlobs: ['**/*.t.*'], functionalGlobs: [] } }),
		),
		[],
	);
	for (const bad of [{ command: 5 }, { lcovPath: '' }, { unitGlobs: 'x' }, { functionalGlobs: [1] }])
		assert.match(validate(merge(load(), { coverage: bad })).join('\n'), /coverage\./, JSON.stringify(bad));
});
