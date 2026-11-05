import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BaseError, addWorktree, attachWorktree, parseBase, resolveBase } from '../scripts/worktree.mjs';

const SCRIPT = new URL('../scripts/worktree.mjs', import.meta.url).pathname;
const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();

// A bare "origin" with develop and a feature branch, plus a clone that is the user's checkout.
function repos() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-wt-'));
	const origin = path.join(dir, 'origin.git');
	const clone = path.join(dir, 'clone');
	execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', origin]);
	execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' });
	g(clone, 'checkout', '-q', '-b', 'develop');
	fs.writeFileSync(path.join(clone, 'a.txt'), 'a\n');
	g(clone, 'add', '.');
	g(clone, 'commit', '-q', '-m', 'init');
	g(clone, 'push', '-q', 'origin', 'develop');
	g(clone, 'checkout', '-q', '-b', 'feature/X-1-base');
	fs.writeFileSync(path.join(clone, 'b.txt'), 'b\n');
	g(clone, 'add', '.');
	g(clone, 'commit', '-q', '-m', 'feature work');
	g(clone, 'push', '-q', 'origin', 'feature/X-1-base');
	g(clone, 'checkout', '-q', 'develop');
	return { dir, origin, clone };
}

test('a ticket names its base branch on a "Base branch:" line, in any common markup', () => {
	assert.equal(parseBase('Summary\n\nBase branch: feature/X-1-base\n\nAcceptance criteria\n- x'), 'feature/X-1-base');
	assert.equal(parseBase('**Base branch:** `feature/X-1-base`'), 'feature/X-1-base');
	assert.equal(parseBase('- base branch: release/5.53'), 'release/5.53');
	assert.equal(parseBase('We could base the work on another branch, maybe.'), null);
	assert.equal(parseBase(''), null);
});

test('a branch name that could be read as an option or climbs out of refs is refused', () => {
	for (const bad of ['--upload-pack=x', '-x', 'a..b', 'a b', 'a;rm', 'x/', '/x', 'x.lock']) {
		assert.equal(parseBase(`Base branch: ${bad}`), null, bad);
	}
});

test('no base given resolves to origin/develop, the configured default', () => {
	const { clone } = repos();
	const r = resolveBase({ repo: clone, defaultBase: 'develop' });
	assert.deepEqual({ name: r.name, ref: r.ref, usedDefault: r.usedDefault }, { name: 'develop', ref: 'origin/develop', usedDefault: true });
});

test('a pushed branch is used through its origin ref', () => {
	const { clone } = repos();
	const r = resolveBase({ repo: clone, name: 'feature/X-1-base', defaultBase: 'develop' });
	assert.equal(r.ref, 'origin/feature/X-1-base');
	assert.equal(r.usedDefault, false);
});

test('a branch that exists only locally is refused: the factory never pushes a base and a PR needs it on origin', () => {
	const { clone } = repos();
	g(clone, 'branch', 'feature/local-only');
	assert.throws(
		() => resolveBase({ repo: clone, name: 'feature/local-only', defaultBase: 'develop' }),
		(e) => e instanceof BaseError && e.code === 3 && /not on origin/.test(e.message) && /exists locally/.test(e.message),
	);
});

test('a local branch ahead of origin is refused so the PR base matches what was built on', () => {
	const { clone } = repos();
	g(clone, 'checkout', '-q', 'feature/X-1-base');
	fs.writeFileSync(path.join(clone, 'c.txt'), 'c\n');
	g(clone, 'add', '.');
	g(clone, 'commit', '-q', '-m', 'unpushed');
	assert.throws(
		() => resolveBase({ repo: clone, name: 'feature/X-1-base', defaultBase: 'develop' }),
		(e) => e instanceof BaseError && e.code === 3 && /1 commit/.test(e.message) && /push/i.test(e.message),
	);
});

test('an unknown branch is a clear error', () => {
	const { clone } = repos();
	assert.throws(
		() => resolveBase({ repo: clone, name: 'nope/none', defaultBase: 'develop' }),
		(e) => e instanceof BaseError && e.code === 2 && /does not exist/.test(e.message),
	);
});

test('the worktree branches off the chosen base, keeps run state out of git, and works when the base has no dev-factory folder', () => {
	const { dir, clone } = repos();
	const wt = path.join(dir, 'wt-feature');
	const out = addWorktree({ repo: clone, branch: 'task/X-2-child', name: 'feature/X-1-base', defaultBase: 'develop', dest: wt });
	assert.equal(out.base, 'feature/X-1-base');
	assert.equal(g(wt, 'rev-parse', 'HEAD'), g(clone, 'rev-parse', 'origin/feature/X-1-base'));
	assert.ok(fs.existsSync(path.join(wt, 'b.txt')), 'carries the feature branch work');
	fs.mkdirSync(path.join(wt, '.dev-factory'));
	fs.writeFileSync(path.join(wt, '.dev-factory', 'run.json'), '{}');
	assert.equal(g(wt, 'status', '--porcelain'), '', '.dev-factory/ is excluded');
	assert.equal(fs.existsSync(path.join(wt, 'dev-factory')), false);
});

test('the default worktree branches off origin/develop and not off the checkout the user is on', () => {
	const { dir, clone } = repos();
	g(clone, 'checkout', '-q', 'feature/X-1-base');
	const wt = path.join(dir, 'wt-default');
	const out = addWorktree({ repo: clone, branch: 'task/X-3-default', defaultBase: 'develop', dest: wt });
	assert.equal(out.base, 'develop');
	assert.equal(g(wt, 'rev-parse', 'HEAD'), g(clone, 'rev-parse', 'origin/develop'));
	assert.equal(fs.existsSync(path.join(wt, 'b.txt')), false);
});

test('the CLI prints json and exits 3 with the reason when the base is not on origin', () => {
	const { clone } = repos();
	g(clone, 'branch', 'feature/local-only');
	const ok = spawnSync('node', [SCRIPT, 'resolve', '--repo', clone, '--base', 'feature/X-1-base', '--default', 'develop'], { encoding: 'utf8' });
	assert.equal(ok.status, 0);
	assert.equal(JSON.parse(ok.stdout).ref, 'origin/feature/X-1-base');
	const bad = spawnSync('node', [SCRIPT, 'resolve', '--repo', clone, '--base', 'feature/local-only', '--default', 'develop'], { encoding: 'utf8' });
	assert.equal(bad.status, 3);
	assert.match(bad.stderr, /not on origin/);
});

// ---- a second pass over the same ticket ----

function ticket() {
	const r = repos();
	const state = path.join(r.dir, 'state');
	process.env.DF_STATE_DIR = state;
	const dest = path.join(r.dir, 'wt', 'APP-1');
	const branch = 'task/APP-1-thing';
	const add = () => addWorktree({ repo: r.clone, branch, defaultBase: 'develop', dest });
	const commit = (file = 'work.txt') => {
		fs.writeFileSync(path.join(dest, file), 'w\n');
		g(dest, 'add', file);
		g(dest, 'commit', '-q', '-m', 'work');
	};
	return { ...r, state, dest, branch, add, commit };
}

test('a first pass creates the worktree and copies the repository’s own settings in, out of git', () => {
	const t = ticket();
	fs.writeFileSync(path.join(t.clone, 'dev-factory.config.json'), '{"tasks":{"source":"local"}}\n');
	fs.writeFileSync(path.join(t.clone, 'dev-factory.qa.yaml'), 'profiles: {}\n');
	const r = t.add();
	assert.equal(r.settled, 'new');
	assert.deepEqual(r.copied.sort(), ['dev-factory.config.json', 'dev-factory.qa.yaml']);
	assert.equal(fs.readFileSync(path.join(t.dest, 'dev-factory.config.json'), 'utf8'), '{"tasks":{"source":"local"}}\n');
	assert.equal(g(t.dest, 'status', '--porcelain'), '', 'untracked and ignored: a ticket cannot commit them');
});

test('a file the branch tracks is left alone, and nothing is copied when the checkout has none', () => {
	const t = ticket();
	assert.deepEqual(t.add().copied, []);
	const u = ticket();
	fs.writeFileSync(path.join(u.clone, 'dev-factory.config.json'), '{"tracked":true}\n');
	g(u.clone, 'add', '.');
	g(u.clone, 'commit', '-q', '-m', 'config');
	g(u.clone, 'push', '-q', 'origin', 'develop');
	fs.writeFileSync(path.join(u.clone, 'dev-factory.config.json'), '{"tracked":false}\n');
	const r = u.add();
	assert.deepEqual(r.copied, []);
	assert.equal(fs.readFileSync(path.join(u.dest, 'dev-factory.config.json'), 'utf8'), '{"tracked":true}\n');
});

test('a second pass adopts a worktree whose commits are pushed, and clears the markers that would stop the builder at once', () => {
	const t = ticket();
	t.add();
	t.commit();
	g(t.dest, 'push', '-q', '-u', 'origin', t.branch);
	fs.mkdirSync(path.join(t.dest, '.dev-factory'), { recursive: true });
	for (const m of ['blocked.json', 'build.done', 'ship.done', 'needs_debug.json', 'run.json'])
		fs.writeFileSync(path.join(t.dest, '.dev-factory', m), '{}');
	const r = t.add();
	assert.equal(r.settled, 'adopted');
	assert.deepEqual(r.cleared.sort(), ['blocked.json', 'build.done', 'needs_debug.json', 'ship.done']);
	assert.ok(fs.existsSync(path.join(t.dest, '.dev-factory/run.json')), 'run.json is not a marker');
	assert.ok(fs.existsSync(path.join(t.dest, 'work.txt')), 'the pushed work is still there');
	assert.equal(r.backup, null);
});

test('an empty worktree is removed and made again, with a clean tree backed up first', () => {
	const t = ticket();
	t.add();
	assert.equal(t.add().settled, 'recreated');
	fs.writeFileSync(path.join(t.dest, 'half-done.txt'), 'wip\n');
	fs.writeFileSync(path.join(t.dest, 'a.txt'), 'edited\n');
	const r = t.add();
	assert.equal(r.settled, 'recreated');
	assert.ok(r.backup && fs.existsSync(r.backup), 'the diff was kept');
	assert.ok(r.backup.startsWith(t.state));
	const patch = fs.readFileSync(r.backup, 'utf8');
	assert.match(patch, /half-done\.txt/, 'untracked files are in the backup');
	assert.match(patch, /\+edited/);
	assert.equal(fs.existsSync(path.join(t.dest, 'half-done.txt')), false, 'the new worktree is clean');
});

test('real unpushed work is never touched: the pass refuses and says what to do', () => {
	const t = ticket();
	t.add();
	t.commit();
	assert.throws(
		() => t.add(),
		(e) =>
			e instanceof BaseError &&
			e.code === 3 &&
			/1 commit/.test(e.message) &&
			/not pushed/.test(e.message) &&
			/nothing was changed/.test(e.message),
	);
	assert.ok(fs.existsSync(path.join(t.dest, 'work.txt')));
	// pushed once, then one more commit: still refused
	g(t.dest, 'push', '-q', '-u', 'origin', t.branch);
	t.commit('more.txt');
	assert.throws(() => t.add(), /1 commit/);
	assert.ok(fs.existsSync(path.join(t.dest, 'more.txt')));
});

test('a path that is not this ticket’s worktree is refused, not overwritten', () => {
	const t = ticket();
	fs.mkdirSync(t.dest, { recursive: true });
	fs.writeFileSync(path.join(t.dest, 'precious.txt'), 'mine\n');
	assert.throws(() => t.add(), /not a worktree of this repository/);
	assert.equal(fs.readFileSync(path.join(t.dest, 'precious.txt'), 'utf8'), 'mine\n');
	const u = ticket();
	addWorktree({ repo: u.clone, branch: 'task/APP-2-other', defaultBase: 'develop', dest: u.dest });
	assert.throws(() => u.add(), /worktree of task\/APP-2-other/);
});

test('a branch left behind without a worktree is reused when pushed, dropped when empty, refused when it holds unpushed work', () => {
	const t = ticket();
	t.add();
	t.commit();
	g(t.dest, 'push', '-q', '-u', 'origin', t.branch);
	g(t.clone, 'worktree', 'remove', '--force', t.dest);
	const r = t.add();
	assert.equal(r.settled, 'adopted');
	assert.ok(fs.existsSync(path.join(t.dest, 'work.txt')));

	const e = ticket();
	e.add();
	g(e.clone, 'worktree', 'remove', '--force', e.dest);
	assert.equal(e.add().settled, 'new');

	const u = ticket();
	u.add();
	u.commit();
	g(u.clone, 'worktree', 'remove', '--force', u.dest);
	assert.throws(() => u.add(), /not pushed and no worktree/);
	assert.ok(g(u.clone, 'rev-parse', '--verify', u.branch), 'the branch is still there');
});

test('the CLI prints how the worktree was settled', () => {
	const t = ticket();
	const run = () =>
		spawnSync('node', [SCRIPT, 'add', '--branch', t.branch, '--path', t.dest, '--repo', t.clone, '--default', 'develop'], {
			encoding: 'utf8',
			env: { ...process.env, DF_STATE_DIR: t.state },
		});
	assert.equal(JSON.parse(run().stdout).settled, 'new');
	assert.equal(JSON.parse(run().stdout).settled, 'recreated');
	t.commit();
	const refused = run();
	assert.equal(refused.status, 3);
	assert.match(refused.stderr, /not pushed/);
});

test('an empty worktree holding a file too big for the backup is not deleted', () => {
	const t = ticket();
	t.add();
	fs.writeFileSync(path.join(t.dest, 'big.bin'), Buffer.alloc((1 << 20) + 1, 1));
	assert.throws(
		() => t.add(),
		(e) => e instanceof BaseError && /cannot keep \(big\.bin\)/.test(e.message) && /nothing was changed/.test(e.message),
	);
	assert.ok(fs.existsSync(path.join(t.dest, 'big.bin')), 'the file is still there');
	fs.rmSync(path.join(t.dest, 'big.bin'));
	assert.equal(t.add().settled, 'recreated');
});

test('attach on a fix pass reuses the ticket’s existing worktree and clears the markers, instead of failing inside git', () => {
	const t = ticket();
	t.add();
	t.commit();
	g(t.dest, 'push', '-q', '-u', 'origin', t.branch);
	fs.mkdirSync(path.join(t.dest, '.dev-factory'), { recursive: true });
	for (const m of ['blocked.json', 'ship.done', 'run.json']) fs.writeFileSync(path.join(t.dest, '.dev-factory', m), '{}');
	const r = attachWorktree({ repo: t.clone, branch: t.branch, dest: t.dest });
	assert.equal(r.existing, true);
	assert.deepEqual(r.cleared.sort(), ['blocked.json', 'ship.done']);
	assert.ok(fs.existsSync(path.join(t.dest, 'work.txt')));
	// another branch's worktree, or a plain folder, is refused with nothing changed
	assert.throws(() => attachWorktree({ repo: t.clone, branch: 'task/APP-9-other', dest: t.dest }), /not task\/APP-9-other/);
	const plain = path.join(t.dir, 'plain');
	fs.mkdirSync(plain);
	fs.writeFileSync(path.join(plain, 'x'), 'x');
	assert.throws(() => attachWorktree({ repo: t.clone, branch: t.branch, dest: plain }), /not a worktree of this repository/);
	// and with no worktree yet it still checks the pushed branch out
	fs.rmSync(t.dest, { recursive: true, force: true });
	const again = attachWorktree({ repo: t.clone, branch: t.branch, dest: t.dest });
	assert.ok(!again.existing && fs.existsSync(path.join(t.dest, 'work.txt')));
});
