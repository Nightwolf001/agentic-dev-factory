import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LEGACY_FILES, PROJECT_DIR, PROJECT_FILES, applyMigration, ensureProjectDir, planMigration, projectRoot } from '../scripts/project-dir.mjs';

const SCRIPT = new URL('../scripts/project-dir.mjs', import.meta.url).pathname;
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();

function repo() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-pd-')));
	execFileSync('git', ['init', '-q', dir]);
	return dir;
}
const write = (root, rel, text = 'x\n') => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), text);
};

// A repository with the three legacy locations: config and cases committed, the QA file untracked.
function legacyRepo() {
	const root = repo();
	write(root, LEGACY_FILES.config, '{}\n');
	write(root, `${LEGACY_FILES.cases}/A-1/x.yaml`);
	g(root, 'add', '-A');
	g(root, 'commit', '-q', '-m', 'init');
	write(root, LEGACY_FILES.qa, 'qa: 1\n');
	return root;
}

test('the constants name the project folder and its files', () => {
	assert.equal(PROJECT_DIR, '.devfactory');
	assert.deepEqual(PROJECT_FILES, {
		config: '.devfactory/config.json',
		qa: '.devfactory/qa.yaml',
		cases: '.devfactory/qa/cases',
		mcp: '.devfactory/mcp.json',
	});
	assert.deepEqual(LEGACY_FILES, { config: 'dev-factory.config.json', qa: 'dev-factory.qa.yaml', cases: '.factory/qa/cases' });
});

test('ensureProjectDir makes a folder git ignores', () => {
	const root = repo();
	assert.equal(ensureProjectDir(root), path.join(root, '.devfactory'));
	write(root, PROJECT_FILES.config, '{}\n');
	g(root, 'add', '-A');
	assert.equal(g(root, 'status', '--porcelain'), '');
	assert.equal(
		fs.readFileSync(path.join(root, '.devfactory', '.gitignore'), 'utf8'),
		'# written by dev-factory: this folder stays out of git\n*\n',
	);
});

test('ensureProjectDir keeps an existing gitignore and is idempotent', () => {
	const root = repo();
	write(root, '.devfactory/.gitignore', 'foo\n');
	ensureProjectDir(root);
	const file = path.join(root, '.devfactory', '.gitignore');
	assert.equal(fs.readFileSync(file, 'utf8'), 'foo\n*\n');
	ensureProjectDir(root);
	assert.equal(fs.readFileSync(file, 'utf8'), 'foo\n*\n');
});

test('ensureProjectDir leaves a gitignore that already ignores everything untouched', () => {
	const root = repo();
	write(root, '.devfactory/.gitignore', '*\n!keep\n');
	ensureProjectDir(root);
	assert.equal(fs.readFileSync(path.join(root, '.devfactory', '.gitignore'), 'utf8'), '*\n!keep\n');
});

test('planMigration lists each legacy path with tracked and conflict', () => {
	const root = legacyRepo();
	const plan = planMigration(root);
	assert.deepEqual(
		plan.map((m) => [m.from, m.to, m.tracked, m.conflict]),
		[
			['dev-factory.config.json', '.devfactory/config.json', true, false],
			['dev-factory.qa.yaml', '.devfactory/qa.yaml', false, false],
			['.factory/qa/cases', '.devfactory/qa/cases', true, false],
		],
	);
});

test('planMigration lists nothing when no legacy path exists and flags an occupied destination', () => {
	const root = repo();
	assert.deepEqual(planMigration(root), []);
	write(root, LEGACY_FILES.qa);
	write(root, PROJECT_FILES.qa);
	assert.deepEqual(
		planMigration(root).map((m) => [m.from, m.conflict]),
		[[LEGACY_FILES.qa, true]],
	);
});

test('applyMigration skips a conflict and leaves both files', () => {
	const root = repo();
	write(root, LEGACY_FILES.config, 'old\n');
	write(root, PROJECT_FILES.config, 'new\n');
	const r = applyMigration(root, planMigration(root));
	assert.deepEqual(r, { moved: [], skipped: [{ from: LEGACY_FILES.config, reason: 'already exists: .devfactory/config.json' }], untrack: [] });
	assert.equal(fs.readFileSync(path.join(root, LEGACY_FILES.config), 'utf8'), 'old\n');
	assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.config), 'utf8'), 'new\n');
});

test('applyMigration moves files and folders and returns untrack commands for tracked sources only', () => {
	const root = legacyRepo();
	const r = applyMigration(root, planMigration(root));
	assert.deepEqual(r.moved, [LEGACY_FILES.config, LEGACY_FILES.qa, LEGACY_FILES.cases]);
	assert.deepEqual(r.skipped, []);
	assert.deepEqual(r.untrack, ['git rm -r --cached -- dev-factory.config.json', 'git rm -r --cached -- .factory/qa/cases']);
	assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.config), 'utf8'), '{}\n');
	assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.qa), 'utf8'), 'qa: 1\n');
	assert.ok(fs.existsSync(path.join(root, PROJECT_FILES.cases, 'A-1', 'x.yaml')));
	assert.ok(!fs.existsSync(path.join(root, LEGACY_FILES.config)));
	assert.ok(!fs.existsSync(path.join(root, LEGACY_FILES.cases)));
	// applying runs no git write: the old paths are still in the index until the person runs the commands.
	assert.match(g(root, 'ls-files'), /dev-factory\.config\.json/);
});

test('projectRoot finds the repository from a subfolder and returns null outside one', () => {
	const root = repo();
	const sub = path.join(root, 'a', 'b');
	fs.mkdirSync(sub, { recursive: true });
	assert.equal(projectRoot(sub), root);
	assert.equal(projectRoot(root), root);
	const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-pd-out-')));
	assert.equal(projectRoot(outside), null);
});

test('projectRoot accepts a worktree, whose .git is a file', () => {
	const root = repo();
	write(root, 'a.txt');
	g(root, 'add', '-A');
	g(root, 'commit', '-q', '-m', 'init');
	const wt = path.join(root, '..', path.basename(root) + '-wt');
	g(root, 'worktree', 'add', '-q', '-b', 'x', wt);
	assert.equal(projectRoot(fs.realpathSync(wt)), fs.realpathSync(wt));
});

test('the CLI plans by default and moves with --apply', () => {
	const root = legacyRepo();
	const run = (...args) => spawnSync('node', [SCRIPT, 'migrate', ...args], { cwd: root, encoding: 'utf8' });
	const plan = run();
	assert.equal(plan.status, 0, plan.stderr);
	assert.match(plan.stdout, /^plan {2}dev-factory\.config\.json -> \.devfactory\/config\.json$/m);
	assert.ok(fs.existsSync(path.join(root, LEGACY_FILES.config)));
	const done = run('--apply');
	assert.equal(done.status, 0, done.stderr);
	assert.match(done.stdout, /^do {2}dev-factory\.qa\.yaml -> \.devfactory\/qa\.yaml$/m);
	assert.match(done.stdout, /^git rm -r --cached -- \.factory\/qa\/cases$/m);
	assert.ok(fs.existsSync(path.join(root, PROJECT_FILES.config)));
});

test('the CLI reports a conflict as skip and fails outside a repository', () => {
	const root = repo();
	write(root, LEGACY_FILES.config, 'old\n');
	write(root, PROJECT_FILES.config, 'new\n');
	const r = spawnSync('node', [SCRIPT, 'migrate', '--apply'], { cwd: root, encoding: 'utf8' });
	assert.match(r.stdout, /^skip {2}dev-factory\.config\.json: already exists: \.devfactory\/config\.json$/m);
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'df-pd-out-'));
	const bad = spawnSync('node', [SCRIPT, 'migrate'], { cwd: outside, encoding: 'utf8' });
	assert.notEqual(bad.status, 0);
});
