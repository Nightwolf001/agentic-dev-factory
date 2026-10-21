import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BaseError, addWorktree, parseBase, resolveBase } from '../scripts/worktree.mjs';

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
