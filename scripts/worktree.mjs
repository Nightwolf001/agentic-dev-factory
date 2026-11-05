// Chooses the branch a run builds on and creates its worktree. The base is the first of: an explicit --base, a
// "Base branch:" line in the ticket, then git.baseBranch from config (null means the repository's default branch on origin). A base must be on origin and not
// behind the user's local copy of it: the factory never pushes a base branch, and a PR needs the same commits on both sides.
//
//   worktree.mjs resolve [--base NAME] [--repo DIR]                          print {name, ref, usedDefault}; exit 3 when the base cannot be used
//   worktree.mjs add --branch NEW --path DIR [--base NAME] [--repo DIR]      resolve, then git worktree add -b NEW DIR <ref>. A second pass over a ticket
//                                                                            finds what the first left: a worktree whose commits are pushed is reused (stale
//                                                                            done/blocked markers cleared), an empty one is made again (its diff is backed up
//                                                                            under <state>/backups first), real unpushed work is refused with exit 3.
//                                                                            The prints include settled: new|adopted|recreated. The repository's
//                                                                            settings (.devfactory/config.json and qa.yaml, or the old
//                                                                            dev-factory.config.json and dev-factory.qa.yaml) are copied in, kept out of git.
//   worktree.mjs attach --branch EXISTING --path DIR [--repo DIR]            worktree on an existing remote branch (fix passes)
//   worktree.mjs root [--repo DIR]                                           print the folder worktrees are created in (git.worktreeRoot)
//   worktree.mjs default-branch [--repo DIR]                                 print the branch a run builds on when no base is named
//   worktree.mjs parse --file F                                              print the "Base branch:" name from a ticket, or nothing
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get } from './config.mjs';
import { isMain } from './is-main.mjs';
import { LEGACY_FILES, PROJECT_DIR, PROJECT_FILES, ensureProjectDir } from './project-dir.mjs';

export class BaseError extends Error {
	constructor(message, code = 3) {
		super(message);
		this.code = code;
	}
}

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitOk = (repo, ...args) => {
	try {
		git(repo, ...args);
		return true;
	} catch {
		return false;
	}
};

// Not an option, no "..", no space or shell characters, no trailing slash or .lock: a name that is safe in a command and a ref.
export const validName = (n) =>
	typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(n) && !n.includes('..') && !n.endsWith('/') && !n.endsWith('.lock');

// "Base branch: feature/X-1-foo", also as a list item, bold, or in backticks.
export function parseBase(text) {
	const m = /^\s*(?:[-*+]\s*)?(?:\*\*|__)?\s*base branch\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*`?([^\s`*_][^\s`]*?)`?\s*(?:\*\*|__)?\s*$/im.exec(
		text || '',
	);
	return m && validName(m[1]) ? m[1] : null;
}

// git.baseBranch when set, otherwise the branch origin/HEAD points at, otherwise main.
export function defaultBranch({ repo, configured }) {
	if (configured) return configured;
	try {
		return git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '');
	} catch {
		return gitOk(repo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master') &&
			!gitOk(repo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main')
			? 'master'
			: 'main';
	}
}

export function resolveBase({ repo, name, defaultBase, fetch = true }) {
	const base = name || defaultBase;
	if (!validName(base)) throw new BaseError(`'${base}' is not a usable branch name`, 2);
	if (fetch) gitOk(repo, 'fetch', '--quiet', 'origin', base);
	const remote = gitOk(repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`);
	const local = gitOk(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${base}`);
	if (!remote) {
		if (local)
			throw new BaseError(
				`base '${base}' is not on origin (it exists locally). Push it first: the factory never pushes a base branch, and a PR needs it on origin.`,
			);
		throw new BaseError(`base '${base}' does not exist locally or on origin`, 2);
	}
	if (local) {
		const ahead = Number(git(repo, 'rev-list', '--count', `origin/${base}..${base}`));
		if (ahead > 0)
			throw new BaseError(
				`local '${base}' has ${ahead} commit${ahead === 1 ? '' : 's'} that ${ahead === 1 ? 'is' : 'are'} not on origin/${base}. Push it first so the PR base matches what the work is built on.`,
			);
	}
	return { name: base, ref: `origin/${base}`, usedDefault: !name };
}

// The ignore rule for .dev-factory/ only exists on branches that carry the plugin. info/exclude is shared by every worktree of a clone, so this is written once per clone.
function exclude(worktree, names = ['.dev-factory/']) {
	const file = path.resolve(worktree, git(worktree, 'rev-parse', '--git-path', 'info/exclude'));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	let have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
	for (const n of names) {
		if (new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(have)) continue;
		have += `${have && !have.endsWith('\n') ? '\n' : ''}${n}\n`;
	}
	fs.writeFileSync(file, have);
}

// The repository's own settings are not in git on a branch (the owner keeps them beside the checkout), so a fresh worktree
// would run on the defaults. They are copied in and kept out of git: a ticket must never commit them. A file the branch
// tracks is already there and is left alone. The ones in .devfactory/ need no info/exclude line: that folder ignores itself.
// The old places stay in the list for the release in which a repository moves its files.
export const LOCAL_SETTINGS = [PROJECT_FILES.config, PROJECT_FILES.qa, LEGACY_FILES.config, LEGACY_FILES.qa];
// Whether or not anything is carried, the worktree gets its `.devfactory/` with the .gitignore that keeps it out of git: a
// builder's scratch QA cases are written there, and the edit guard does not let it make that file itself.
function carrySettings(repo, dest) {
	ensureProjectDir(dest);
	const copied = [];
	const excluded = [];
	for (const f of LOCAL_SETTINGS) {
		const from = path.join(repo, f);
		if (!fs.existsSync(from) || !fs.statSync(from).isFile() || gitOk(dest, 'ls-files', '--error-unmatch', f)) continue;
		const inFolder = f.startsWith(`${PROJECT_DIR}/`);
		fs.copyFileSync(from, path.join(dest, f));
		copied.push(f);
		if (!inFolder) excluded.push(f);
	}
	if (excluded.length) exclude(dest, excluded);
	return copied;
}

// Hand-off markers a finished or blocked pass leaves in .dev-factory/. Left in place, a builder started again after an
// answer would find "blocked" or "done" and stop at once.
const MARKERS = ['blocked.json', 'needs_debug.json', 'build.done', 'ship.done', 'improve.done', 'promote.done', 'stop-nudges'];
function clearMarkers(worktree) {
	const cleared = [];
	for (const m of MARKERS) {
		const f = path.join(worktree, '.dev-factory', m);
		if (fs.existsSync(f)) {
			fs.rmSync(f, { recursive: true, force: true });
			cleared.push(m);
		}
	}
	return cleared;
}

const stateDir = () => process.env.DF_STATE_DIR || path.join(os.homedir(), '.dev-factory');

// The uncommitted changes of a worktree as one patch under <state>/backups, untracked files included, before anything is removed.
// -> { file, skipped }: `file` is null when there was nothing to save, `skipped` names what the patch could not hold (a file over
// 1 MiB, one past the first 200, one git could not diff), so that a caller about to delete the worktree can refuse instead.
function backupDiff(worktree, branch) {
	const t = spawnSync('git', ['-C', worktree, 'diff', 'HEAD', '--binary'], { encoding: 'utf8', maxBuffer: 256 << 20 });
	if (t.error || t.status !== 0)
		throw new BaseError(
			`could not read the uncommitted changes of ${worktree} to back them up (${t.error?.code ?? `git exit ${t.status}`}); nothing was changed`,
		);
	const tracked = t.stdout ?? '';
	const all = git(worktree, 'ls-files', '--others', '--exclude-standard')
		.split('\n')
		.filter((f) => f && !f.startsWith('.dev-factory/'));
	const skipped = all.slice(200);
	let extra = '';
	for (const f of all.slice(0, 200)) {
		let stat;
		try {
			stat = fs.statSync(path.join(worktree, f));
		} catch {
			skipped.push(f);
			continue;
		}
		if (!stat.isFile() || stat.size > 1 << 20) {
			skipped.push(f);
			continue;
		}
		const d = spawnSync('git', ['-C', worktree, 'diff', '--no-index', '--binary', '--', '/dev/null', f], {
			encoding: 'utf8',
			maxBuffer: 16 << 20,
		});
		if (d.error || (d.status !== 0 && d.status !== 1)) skipped.push(f);
		else extra += d.stdout ?? '';
	}
	if (!tracked.trim() && !extra.trim()) return { file: null, skipped };
	const dir = path.join(stateDir(), 'backups');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${branch.replace(/[^\w.-]+/g, '-')}-${new Date().toISOString().replace(/[:.]/g, '-')}.patch`);
	fs.writeFileSync(file, tracked + extra);
	return { file, skipped };
}

const realOrSelf = (p) => {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
};

// -> { branch, head } when `dest` is a worktree of this repository
function registered(repo, dest) {
	const want = realOrSelf(dest);
	let cur = null;
	for (const line of git(repo, 'worktree', 'list', '--porcelain').split('\n')) {
		if (line.startsWith('worktree ')) cur = { path: line.slice(9), branch: null };
		else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
		else if (line === '' && cur) {
			if (realOrSelf(cur.path) === want) return cur;
			cur = null;
		}
	}
	return cur && realOrSelf(cur.path) === want ? cur : null;
}

// Commits of `branch` that exist nowhere else: ahead of its own remote branch, or ahead of the base when it was never pushed.
function unpushed(repo, branch, baseRef) {
	const remote = gitOk(repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`);
	const count = Number(git(repo, 'rev-list', '--count', `${remote ? `origin/${branch}` : baseRef}..${branch}`));
	return { remote, count };
}

// A second pass finds what the first left. Reuse a worktree whose commits are pushed, drop an empty one, and never touch
// real unpushed work. -> { settled: 'new' | 'adopted' | 'recreated', backup, cleared }
function settle({ repo, branch, dest, baseRef }) {
	git(repo, 'worktree', 'prune');
	gitOk(repo, 'fetch', '--quiet', 'origin', branch);
	const abs = path.resolve(dest);
	const wt = registered(repo, abs);
	if (!wt) {
		if (fs.existsSync(abs) && fs.readdirSync(abs).length)
			throw new BaseError(`${dest} exists and is not a worktree of this repository; move it away, nothing was changed`);
		if (!gitOk(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) return { settled: 'new' };
		// a branch left behind with no worktree
		const { remote, count } = unpushed(repo, branch, baseRef);
		if (count > 0)
			throw new BaseError(
				`branch ${branch} has ${count} commit${count === 1 ? '' : 's'} that ${count === 1 ? 'is' : 'are'} not pushed and no worktree; push it or move it first, nothing was changed`,
			);
		if (remote) return { settled: 'adopted', attach: true };
		git(repo, 'branch', '-D', branch);
		return { settled: 'new' };
	}
	if (wt.branch !== branch) throw new BaseError(`${dest} is a worktree of ${wt.branch ?? 'a detached head'}, not ${branch}; nothing was changed`);
	const { remote, count } = unpushed(repo, branch, baseRef);
	if (count > 0)
		throw new BaseError(
			`${dest} holds ${count} commit${count === 1 ? '' : 's'} of ${branch} that ${count === 1 ? 'is' : 'are'} not pushed; push ${count === 1 ? 'it' : 'them'} or move the worktree, nothing was changed`,
		);
	const { file: backup, skipped } = backupDiff(abs, branch);
	if (!remote && Number(git(repo, 'rev-list', '--count', `${baseRef}..${branch}`)) === 0) {
		// nothing committed anywhere: start clean, unless that would delete files the backup does not hold
		if (skipped.length)
			throw new BaseError(
				`${dest} holds ${skipped.length} untracked file${skipped.length === 1 ? '' : 's'} the backup cannot keep (${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ', ...' : ''}); move ${skipped.length === 1 ? 'it' : 'them'} away or remove ${skipped.length === 1 ? 'it' : 'them'} yourself, nothing was changed`,
			);
		git(repo, 'worktree', 'remove', '--force', abs);
		git(repo, 'branch', '-D', branch);
		return { settled: 'recreated', backup };
	}
	return { settled: 'adopted', backup, cleared: clearMarkers(abs), existing: true };
}

export function addWorktree({ repo, branch, name, defaultBase, dest, fetch = true }) {
	if (!validName(branch)) throw new BaseError(`'${branch}' is not a usable branch name`, 2);
	const r = resolveBase({ repo, name, defaultBase, fetch });
	const s = settle({ repo, branch, dest, baseRef: r.ref });
	if (s.existing) {
		const copied = carrySettings(repo, dest);
		exclude(dest);
		return {
			worktree: path.resolve(dest),
			branch,
			base: r.name,
			baseRef: r.ref,
			usedDefault: r.usedDefault,
			settled: s.settled,
			backup: s.backup ?? null,
			cleared: s.cleared,
			copied,
		};
	}
	if (s.attach) git(repo, 'worktree', 'add', '-q', '-B', branch, dest, `origin/${branch}`);
	else git(repo, 'worktree', 'add', '-q', '-b', branch, dest, r.ref);
	exclude(dest);
	const copied = carrySettings(repo, dest);
	return {
		worktree: path.resolve(dest),
		branch,
		base: r.name,
		baseRef: r.ref,
		usedDefault: r.usedDefault,
		settled: s.settled,
		backup: s.backup ?? null,
		copied,
	};
}

export function attachWorktree({ repo, branch, dest }) {
	if (!validName(branch)) throw new BaseError(`'${branch}' is not a usable branch name`, 2);
	git(repo, 'worktree', 'prune');
	const abs = path.resolve(dest);
	const wt = registered(repo, abs);
	if (wt) {
		// a fix pass over a ticket whose worktree is still there: use it, clear the markers the last pass left
		if (wt.branch !== branch)
			throw new BaseError(`${dest} is a worktree of ${wt.branch ?? 'a detached head'}, not ${branch}; nothing was changed`, 3);
		exclude(abs);
		return { worktree: abs, branch, copied: carrySettings(repo, abs), cleared: clearMarkers(abs), existing: true };
	}
	if (fs.existsSync(abs) && fs.readdirSync(abs).length)
		throw new BaseError(`${dest} exists and is not a worktree of this repository; move it away, nothing was changed`, 3);
	git(repo, 'fetch', '--quiet', 'origin', branch);
	git(repo, 'worktree', 'add', '-q', '-B', branch, dest, `origin/${branch}`);
	exclude(dest);
	return { worktree: abs, branch, copied: carrySettings(repo, dest) };
}

function args(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
		else out._.push(argv[i]);
	}
	return out;
}

if (isMain(import.meta.url)) {
	const a = args(process.argv.slice(2));
	const repo = a.repo || process.cwd();
	const defaultBase = defaultBranch({ repo, configured: a.default || get('git.baseBranch') });
	try {
		const cmd = a._[0];
		if (cmd === 'default-branch') console.log(defaultBase);
		else if (cmd === 'root') console.log(path.resolve(repo, get('git.worktreeRoot') || '../.worktrees'));
		else if (cmd === 'resolve') console.log(JSON.stringify(resolveBase({ repo, name: a.base, defaultBase })));
		else if (cmd === 'add' && a.branch && a.path)
			console.log(JSON.stringify(addWorktree({ repo, branch: a.branch, name: a.base, defaultBase, dest: a.path })));
		else if (cmd === 'attach' && a.branch && a.path) console.log(JSON.stringify(attachWorktree({ repo, branch: a.branch, dest: a.path })));
		else if (cmd === 'parse' && a.file) {
			const name = parseBase(fs.readFileSync(a.file, 'utf8'));
			if (name) console.log(name);
		} else throw new BaseError('usage: worktree.mjs resolve|add|attach|parse (see the header of this file)', 3);
	} catch (e) {
		console.error(`worktree: ${e.message}`);
		process.exit(e instanceof BaseError ? e.code : 1);
	}
}
