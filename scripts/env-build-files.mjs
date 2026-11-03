// Build files the environment step rewrites in a worktree (a lockfile a package manager refreshes, a native project file
// a pod install touches) are modified files in git's eyes, so `qa.mjs` would call the tree dirty before the ticket has
// changed anything. The environment step records a content hash of each such file once it is done (`seal`); qa.mjs then
// ignores a file only while its content is still exactly that. A ticket's own edit to the same file changes the hash, so the
// tree is dirty again.
//
//   env-build-files.mjs seal --worktree DIR     seal the changed files that match mobile.nativeInputs (under mobile.appDir)
//                                               and environment.buildFiles
//   env-build-files.mjs show --worktree DIR     print what is sealed
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';

// A glob as a regular expression over a repository path. `**/` is any number of folders (including none), a trailing `/**` is anything
// below, `*` is a name or part of one and never crosses a `/`. So `**/tests/**` is a folder called tests, not `latests`.
export function globToRegExp(glob) {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === '*') {
			if (glob[i + 1] === '*') {
				const atStart = i === 0 || glob[i - 1] === '/';
				if (glob[i + 2] === '/' && atStart) {
					re += '(?:.*/)?';
					i += 2;
				} else {
					re += '.*';
					i++;
				}
			} else re += '[^/]*';
		} else if (ch === '?') re += '[^/]';
		else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${re}$`);
}

export const sealedFile = (worktree) => path.join(worktree, '.dev-factory', 'env-sealed.json');
const hashOf = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function readSealed(worktree) {
	try {
		const j = JSON.parse(fs.readFileSync(sealedFile(worktree), 'utf8'));
		return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
	} catch {
		return {};
	}
}

// Whether `file` (relative to the worktree) is a sealed build file still in the state the environment left it.
export function stillSealed(worktree, file, sealed = readSealed(worktree)) {
	const want = sealed[file];
	if (typeof want !== 'string') return false;
	const abs = path.join(worktree, file);
	try {
		return fs.statSync(abs).isFile() && hashOf(abs) === want;
	} catch {
		return false;
	}
}

// Globs, relative to the worktree, of the files the environment step may rewrite.
export function buildGlobs(cfg = load()) {
	const appDir = (get('mobile.appDir', { config: cfg }) || '').replace(/^\.?\/?|\/$/g, '');
	const native = (get('mobile.nativeInputs', { config: cfg }) ?? []).map((g) => (appDir ? `${appDir}/${g}` : g));
	return [...native, ...(get('environment.buildFiles', { config: cfg }) ?? [])];
}

function changedFiles(worktree) {
	const out = execFileSync('git', ['-C', worktree, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
	return out
		.split('\n')
		.filter(Boolean)
		.map((l) => l.slice(3))
		.filter((f) => !f.includes(' -> ') && !f.startsWith('.dev-factory/'));
}

export function seal({ worktree, globs }) {
	const res = globs.map(globToRegExp);
	const sealed = readSealed(worktree);
	const added = [];
	for (const f of changedFiles(worktree)) {
		if (!res.some((re) => re.test(f))) continue;
		const abs = path.join(worktree, f);
		if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
		sealed[f] = hashOf(abs);
		added.push(f);
	}
	if (added.length) {
		fs.mkdirSync(path.dirname(sealedFile(worktree)), { recursive: true });
		fs.writeFileSync(sealedFile(worktree), JSON.stringify(sealed, null, 2) + '\n');
	}
	return { sealed: added };
}

if (isMain(import.meta.url)) {
	const argv = process.argv.slice(2);
	const val = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
	const worktree = path.resolve(val('worktree') ?? process.cwd());
	try {
		if (argv[0] === 'seal') console.log(JSON.stringify(seal({ worktree, globs: buildGlobs() })));
		else if (argv[0] === 'show') console.log(JSON.stringify(readSealed(worktree), null, 2));
		else throw new Error('usage: env-build-files.mjs seal|show --worktree DIR');
	} catch (e) {
		console.error(`env-build-files: ${e.message}`);
		process.exit(1);
	}
}
