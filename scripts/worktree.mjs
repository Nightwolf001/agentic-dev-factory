// Chooses the branch a run builds on and creates its worktree. The base is the first of: an explicit --base, a
// "Base branch:" line in the ticket, then git.baseBranch from config.json (develop). A base must be on origin and not
// behind the user's local copy of it: the factory never pushes a base branch, and a PR needs the same commits on both sides.
//
//   worktree.mjs resolve [--base NAME] [--repo DIR]                          print {name, ref, usedDefault}; exit 3 when the base cannot be used
//   worktree.mjs add --branch NEW --path DIR [--base NAME] [--repo DIR]      resolve, then git worktree add -b NEW DIR <ref>
//   worktree.mjs attach --branch EXISTING --path DIR [--repo DIR]            worktree on an existing remote branch (fix passes)
//   worktree.mjs parse --file F                                              print the "Base branch:" name from a ticket, or nothing
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { get } from './config.mjs';
import { isMain } from './is-main.mjs';

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
function exclude(worktree) {
	const file = path.resolve(worktree, git(worktree, 'rev-parse', '--git-path', 'info/exclude'));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
	if (!/^\.dev-factory\/$/m.test(have)) fs.appendFileSync(file, `${have && !have.endsWith('\n') ? '\n' : ''}.dev-factory/\n`);
}

export function addWorktree({ repo, branch, name, defaultBase, dest, fetch = true }) {
	if (!validName(branch)) throw new BaseError(`'${branch}' is not a usable branch name`, 2);
	const r = resolveBase({ repo, name, defaultBase, fetch });
	git(repo, 'worktree', 'add', '-q', '-b', branch, dest, r.ref);
	exclude(dest);
	return { worktree: path.resolve(dest), branch, base: r.name, baseRef: r.ref, usedDefault: r.usedDefault };
}

export function attachWorktree({ repo, branch, dest }) {
	if (!validName(branch)) throw new BaseError(`'${branch}' is not a usable branch name`, 2);
	git(repo, 'fetch', '--quiet', 'origin', branch);
	git(repo, 'worktree', 'add', '-q', '-B', branch, dest, `origin/${branch}`);
	exclude(dest);
	return { worktree: path.resolve(dest), branch };
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
	const defaultBase = a.default || get('git.baseBranch');
	try {
		const cmd = a._[0];
		if (cmd === 'resolve') console.log(JSON.stringify(resolveBase({ repo, name: a.base, defaultBase })));
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
