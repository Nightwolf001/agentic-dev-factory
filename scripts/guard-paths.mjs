// Path rules for the shell and edit guards (scripts/guard-lib.mjs): which words of a command name the machine's own state,
// a shell profile, the installed plugin or an env file, once quotes, `~`, `$HOME`, `$DF_STATE_DIR`, `..`, brace lists, attached
// option values and the directory a `cd` moved to are resolved. Pure functions, so they are unit-tested; nothing here reads
// the filesystem except `realPath`, which the edit guard uses to follow symlinks.
//
// A hook sees command strings only, so this is a guard against mistakes and ordinary bypasses, not a sandbox. It is built to
// be cheap and to give up safely: every loop is bounded, nothing uses a regular expression that can backtrack on its input,
// and a command that is too large or too slow to judge is refused (`Unjudgeable`) rather than let through.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LIMITS = {
	command: 65536, // characters in one command
	glob: 256, // characters in one glob pattern
	segments: 400, // commands in one command line
	words: 6000, // words in one command line
	expansions: 64, // alternatives one brace list may expand to
	budgetMs: 2000, // time to judge one command
};

export class Unjudgeable extends Error {}

// A function that throws once the time budget is spent. Call it in loops.
export function budget(ms = LIMITS.budgetMs) {
	const end = Date.now() + ms;
	return () => {
		if (Date.now() > end) throw new Unjudgeable('judging it took too long');
	};
}

// ---- globs ----

function compileGlob(pattern) {
	const out = [];
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === '*') {
			if (out[out.length - 1]?.t !== 'star') out.push({ t: 'star' });
		} else if (c === '?') out.push({ t: 'any' });
		else if (c === '[') {
			let j = i + 1;
			const neg = pattern[j] === '!' || pattern[j] === '^';
			if (neg) j++;
			const start = j;
			const ranges = [];
			for (; j < pattern.length && (pattern[j] !== ']' || j === start); j++) {
				if (pattern[j + 1] === '-' && pattern[j + 2] !== undefined && pattern[j + 2] !== ']') {
					ranges.push([pattern[j], pattern[j + 2]]);
					j += 2;
				} else ranges.push([pattern[j], pattern[j]]);
			}
			if (j >= pattern.length)
				out.push({ t: 'lit', c }); // no closing bracket: a plain [
			else {
				out.push({ t: 'set', neg, ranges });
				i = j;
			}
		} else out.push({ t: 'lit', c });
	}
	return out;
}

const matchOne = (tok, ch) =>
	tok.t === 'any' || (tok.t === 'lit' && tok.c === ch) || (tok.t === 'set' && tok.ranges.some(([lo, hi]) => ch >= lo && ch <= hi) !== tok.neg);

// Whether `pattern` (* ? [set]) matches all of `text`, ignoring case. Two pointers and one backtrack point: it never
// recurses and never backtracks over a nested choice, so a hostile pattern costs at most pattern x text steps.
export function globMatch(pattern, text) {
	if (pattern.length > LIMITS.glob) throw new Unjudgeable(`a glob longer than ${LIMITS.glob} characters`);
	const toks = compileGlob(pattern.toLowerCase());
	const t = text.toLowerCase();
	let pi = 0;
	let ti = 0;
	let starP = -1;
	let starT = 0;
	while (ti < t.length) {
		if (pi < toks.length && toks[pi].t === 'star') {
			starP = pi++;
			starT = ti;
		} else if (pi < toks.length && matchOne(toks[pi], t[ti])) {
			pi++;
			ti++;
		} else if (starP >= 0) {
			pi = starP + 1;
			ti = ++starT;
		} else return false;
	}
	while (pi < toks.length && toks[pi].t === 'star') pi++;
	return pi === toks.length;
}

export const hasGlob = (w) => /[*?[]/.test(w);

// ---- words ----

// `{a,b}` lists, as the shell expands them before anything else. `${...}` is left alone. Nested lists expand too. The groups of a
// word are found in one pass with a stack, so a word made of thousands of braces costs a pass, not a pass per brace.
function braceGroups(w) {
	const stack = [];
	const groups = [];
	for (let i = 0; i < w.length; i++) {
		const c = w[i];
		if (c === '{') stack.push({ open: i, dollar: w[i - 1] === '$', commas: [] });
		else if (c === ',' && stack.length && !stack[stack.length - 1].dollar) stack[stack.length - 1].commas.push(i);
		else if (c === '}' && stack.length) {
			const g = stack.pop();
			if (!g.dollar && g.commas.length) groups.push({ ...g, close: i });
		}
	}
	return groups;
}

export function braceExpand(word, limit = LIMITS.expansions) {
	const out = [];
	const walk = (w) => {
		if (out.length > limit) throw new Unjudgeable('a brace list that expands to too many words');
		const groups = braceGroups(w);
		if (!groups.length) return void out.push(w);
		const g = groups.reduce((a, b) => (b.open < a.open ? b : a)); // the leftmost; its inner lists expand in the recursion
		const cuts = [...g.commas, g.close];
		let from = g.open + 1;
		for (const c of cuts) {
			walk(w.slice(0, g.open) + w.slice(from, c) + w.slice(g.close + 1));
			from = c + 1;
		}
	};
	walk(word);
	return out;
}

// The word the shell would pass on: quotes and backslashes removed, $'...' decoded. Variables stay as they are.
export function unquote(word) {
	let out = '';
	for (let i = 0; i < word.length; i++) {
		const c = word[i];
		if (c === '\\') {
			if (i + 1 < word.length) out += word[++i];
		} else if (c === "'") {
			const end = word.indexOf("'", i + 1);
			out += word.slice(i + 1, end < 0 ? undefined : end);
			if (end < 0) break;
			i = end;
		} else if (c === '"') {
			for (i++; i < word.length && word[i] !== '"'; i++) {
				if (word[i] === '\\' && i + 1 < word.length && '"\\$`'.includes(word[i + 1])) i++;
				out += word[i];
			}
		} else if (c === '$' && word[i + 1] === "'") {
			let j = i + 2;
			let s = '';
			for (; j < word.length && word[j] !== "'"; j++) {
				if (word[j] === '\\' && j + 1 < word.length) {
					const x = /^x([0-9a-fA-F]{1,2})/.exec(word.slice(j + 1, j + 4)) ?? /^([0-7]{1,3})/.exec(word.slice(j + 1, j + 4));
					if (x) {
						s += String.fromCharCode(parseInt(x[1], x[0].startsWith('x') ? 16 : 8));
						j += x[0].length;
					} else s += word[++j];
				} else s += word[j];
			}
			out += s;
			i = j;
		} else out += c;
	}
	return out;
}

// ~ and the few variables a path is usually built from. Any other variable stays as text, so the path it makes is unknown. One
// pass, with the name read from a bounded slice: an unclosed `${aaaa...` costs nothing extra.
export function expandVars(word, vars) {
	let w = word;
	if (w === '~' || w.startsWith('~/')) w = vars.HOME + w.slice(1);
	if (!w.includes('$')) return w;
	let out = '';
	for (let i = 0; i < w.length; i++) {
		if (w[i] !== '$') {
			out += w[i];
			continue;
		}
		const braced = w[i + 1] === '{';
		const start = i + (braced ? 2 : 1);
		const name = /^\w{1,64}/.exec(w.slice(start, start + 64))?.[0];
		if (name && Object.hasOwn(vars, name)) {
			if (!braced) {
				out += vars[name];
				i = start + name.length - 1;
				continue;
			}
			const close = w.indexOf('}', start + name.length);
			if (close > 0) {
				out += vars[name];
				i = close;
				continue;
			}
		}
		out += '$';
	}
	return out;
}

// Every path a token might name: the token, the value after `=` (--file=x, VAR=x), an option with its value attached (-ox),
// and the file of a redirection (>x, 2>>x). Each is brace-expanded, unquoted and variable-expanded.
export function candidates(token, vars) {
	const raw = new Set([token]);
	const eq = token.indexOf('=');
	if (eq > -1) raw.add(token.slice(eq + 1));
	const short = /^-[A-Za-z]([/~$.].*)$/.exec(token);
	if (short) raw.add(short[1]);
	for (const piece of token.split(/[<>|()]+/)) if (piece) raw.add(piece);
	raw.add(token.replace(/[)}]+$/, ''));
	const out = new Set();
	for (const r of raw)
		for (const b of braceExpand(r))
			for (const part of [b, ...b.split(/[:,=]/)]) {
				const u = expandVars(unquote(part), vars);
				if (u) out.add(u);
			}
	return [...out];
}

// Words of a command line, split on whitespace outside quotes.
export function words(text) {
	const out = [];
	let cur = '';
	let q = null;
	for (const c of text) {
		if (q) {
			cur += c;
			if (c === q) q = null;
		} else if (c === "'" || c === '"') {
			q = c;
			cur += c;
		} else if (/\s|[;&|()]/.test(c)) {
			if (cur) out.push(cur);
			cur = '';
		} else cur += c;
		if (out.length > LIMITS.words) throw new Unjudgeable('too many words');
	}
	if (cur) out.push(cur);
	return out;
}

// ---- protected places ----

const PROFILE_FILES = [
	'.zshrc',
	'.zshenv',
	'.zprofile',
	'.zlogin',
	'.zlogout',
	'.bashrc',
	'.bash_profile',
	'.bash_login',
	'.bash_logout',
	'.profile',
];

export function envOf(ctx = {}) {
	const env = ctx.env ?? process.env;
	const home = ctx.home ?? env.HOME ?? os.homedir();
	const stateDir = ctx.stateDir ?? env.DF_STATE_DIR ?? path.join(home, '.dev-factory');
	return { env, home, stateDir };
}

const lower = (p) => p.toLowerCase();
const comps = (p) => lower(path.posix.normalize(p)).split('/').filter(Boolean);

// A path component against a pattern component: equal, or, when either side has a glob, a match (a shell would expand the glob
// against what is on disk; here every name the protected side could be is tried). Case never matters (macOS volumes ignore it).
const compEq = (c, pat) => {
	if (!hasGlob(c) && !hasGlob(pat)) return c === pat;
	const [glob, name] = hasGlob(pat) ? [pat, c] : [c, pat];
	if (name.startsWith('.') && !glob.startsWith('.')) return false; // a shell's * does not match a name that starts with a dot
	// a pattern that is nearly all wildcard (`*`, `*.ts`) names nothing in particular: it takes a few literal characters to be
	// read as aimed at a plain name such as dev-factory
	if (!name.startsWith('.') && glob.replace(/[*?[\]!^-]/g, '').length < 4) return false;
	return globMatch(glob, name);
};
const startsWith = (cs, ps) => cs.length >= ps.length && ps.every((p, i) => compEq(cs[i], p));
const containsSeq = (cs, ps) => {
	for (let i = 0; i + ps.length <= cs.length; i++) if (ps.every((p, j) => compEq(cs[i + j], p))) return true;
	return false;
};

// Folders and files under the user's home that no run touches, by what they are for. Paths are components relative to home.
const HOME_PLACES = [
	['home', ['.claude', 'commands']],
	['home', ['.claude', 'agents']],
	['home', ['.claude', 'skills']],
	['home', ['.claude', 'hooks']],
	['home', ['.claude', 'claude.md']],
	['home', ['.claude', 'keybindings.json']],
	['home', ['.gitconfig']],
	['home', ['.config', 'git']],
	['home', ['library', 'launchagents']],
	['home', ['library', 'launchdaemons']],
	['profile', ['.config', 'fish']],
	['secret', ['.ssh']],
	['secret', ['.aws']],
	['secret', ['.gnupg']],
	['secret', ['.netrc']],
	['secret', ['.config', 'gh']],
	['secret', ['.docker', 'config.json']],
	['secret', ['library', 'keychains']],
];

// Every absolute entry a run must not change, as [place, components]. Used for the ancestors too.
export function protectedPaths(ctx = {}) {
	const { home, stateDir } = envOf(ctx);
	const h = comps(home);
	return [['state', comps(stateDir)], ...HOME_PLACES.map(([place, rel]) => [place, [...h, ...rel]])];
}

// -> a short name for what an absolute path is, or null. The path may hold globs (`~/.dev-fac*`), and is compared in lower case.
//   state    the machine state folder (secrets, locks, logs, the run pointer, the settings a pass runs with)
//   profile  a shell start-up file, which runs in every later shell
//   plugin   the installed plugin or any plugin, under .claude/plugins
//   claude   Claude Code's own settings
//   home     what Claude Code, git and launchd run on this machine's behalf (commands, agents, skills, hooks, ~/.gitconfig, LaunchAgents)
//   git      a repository's hooks and configuration: a program put there runs the next time the scheduler uses git
//   secret   credentials (ssh and cloud keys, the gh token): not read either
export function protectedPlace(abs, ctx = {}) {
	const { home } = envOf(ctx);
	const cs = comps(abs);
	if (!cs.length) return null;
	for (const [place, ps] of protectedPaths(ctx)) if (startsWith(cs, ps)) return place;
	const h = comps(home);
	if (PROFILE_FILES.some((f) => startsWith(cs, [...h, f.toLowerCase()]))) return 'profile';
	if (containsSeq(cs, ['.claude', 'plugins'])) return 'plugin';
	if (containsSeq(cs, ['.git', 'hooks']) || containsSeq(cs, ['.git', 'config'])) return 'git';
	if (startsWith(cs, [...h, '.claude.json']) || startsWith(cs, [...h, '.claude', 'settings*.json'])) return 'claude';
	return null;
}

// Whether `abs` is the root, the home folder, or a folder that holds a protected entry: removing, moving, mounting or linking it
// takes the protected entry with it. Globs are not ancestors; they are matched as paths by protectedPlace.
export function ancestorOfProtected(abs, ctx = {}) {
	const cs = comps(abs);
	if (hasGlob(abs)) return false;
	if (!cs.length) return true;
	const h = comps(envOf(ctx).home);
	if (cs.length === h.length && h.every((c, i) => c === cs[i])) return true;
	return protectedPaths(ctx).some(([, ps]) => cs.length < ps.length && cs.every((c, i) => c === ps[i]));
}

// Run state and factory files inside a worktree. A ticket changes only its own code, tests and cases; these are the factory's.
const RUN_STATE = [
	['.dev-factory', 'run.json'],
	['.dev-factory', 'env.json'],
	['.dev-factory', 'env-sealed.json'],
	['.dev-factory', 'env-prechanged.json'],
	['.dev-factory', 'metro.pid'],
	['.dev-factory', 'emulator.pid'],
	['.dev-factory', 'compose.override.yml'],
	['.dev-factory', 'review'],
	['.dev-factory', 'qa'],
	['.dev-factory', 'evidence'],
	['.dev-factory', 'debug'],
	['.factory', 'tasks'],
	['dev-factory'],
	['dev-factory.config.json'],
	// the owner's settings (config, QA profiles, MCP servers), at any depth; a builder's own scratch cases are the one exception
	['.devfactory'],
	['.claude'],
	['.github', 'workflows'],
	['.husky'],
];

// Whether an absolute path (globs allowed) IS one of the folders that hold run state or factory files: removing or moving it whole
// takes everything in it. (Writing a hand-off file inside .dev-factory is fine; deleting .dev-factory is not.)
export function runStateRoot(abs) {
	const last = comps(abs).at(-1);
	return !!last && ['.dev-factory', '.devfactory', '.factory', 'dev-factory', '.claude', '.husky'].some((n) => compEq(last, n));
}

// Whether an absolute path (globs allowed) is run state or a factory file, wherever the worktree is. `key` is the ticket the
// caller runs for: the one folder of QA cases inside .devfactory/ that is its own (with no key, any single ticket's folder is).
export function runStatePlace(abs, key = null) {
	const cs = comps(abs);
	for (let i = 0; i < cs.length; i++) {
		for (const ps of RUN_STATE) {
			if (!ps.every((p, j) => cs[i + j] !== undefined && compEq(cs[i + j], p))) continue;
			// a ticket's own QA cases live under the vendored folder
			if (ps.length === 1 && ps[0] === 'dev-factory' && cs[i + 1] === 'qa' && cs[i + 2] === 'cases') continue;
			if (ps.length === 1 && ps[0] === '.devfactory' && cs[i + 1] === 'qa' && cs[i + 2] === 'cases' && cs[i + 3] !== undefined) {
				const own = key ? cs[i + 3] === key.toLowerCase() : !hasGlob(cs[i + 3]);
				if (own) continue;
			}
			return true;
		}
	}
	return false;
}

// The folder of a path that exists, resolved through symlinks, with the rest of the path kept: a file that is not there yet is
// judged by where it would be created.
export function realPath(abs) {
	let rest = '';
	let dir = abs;
	for (let i = 0; i < 64; i++) {
		try {
			return path.join(fs.realpathSync(dir), rest);
		} catch {
			const up = path.dirname(dir);
			if (up === dir) break;
			rest = path.join(path.basename(dir), rest);
			dir = up;
		}
	}
	return abs;
}

// Absolute form of a word given the directory the command runs in. null when the word is not path-like enough to matter.
export function resolveWord(word, cwd) {
	if (!word || word.length > 4096) return null;
	return path.posix.resolve(cwd, word);
}

// ---- env files ----

// Names an env file can have. A glob that can match one of them is treated as naming it.
const ENV_NAMES = [
	'.env',
	'.env.local',
	'.env.development',
	'.env.production',
	'.env.test',
	'.env.staging',
	'.env.preview',
	'.env.development.local',
	'.env.production.local',
	'.env.test.local',
	'.env.secret',
	'.env.secrets',
];
const ENV_FILE_NAME = /^\.env(\.(?!example\b).*)?$/i;

// Whether one path component is, or by globbing can be, an env file (.env.example excepted). A pattern that does not start
// with a literal dot does not match dot files in a shell, so `*` and `?env` are not env files.
export function isEnvComponent(c) {
	if (!c) return false;
	if (!hasGlob(c)) return ENV_FILE_NAME.test(c);
	if (!c.startsWith('.')) return false;
	return ENV_NAMES.some((n) => globMatch(c, n));
}

export function namesEnvFile(token, vars) {
	for (const cand of candidates(token, vars)) {
		for (const part of cand.split('/')) if (isEnvComponent(part)) return true;
	}
	return false;
}

// ---- takeover ----

// An attempt to set the owner's takeover toggle, or to hide that it is one: the name written in pieces, quoted, in a brace
// list, or built from other variables (indirect expansion, namerefs, printf -v, a name that starts with $).
export function triesTakeover(command) {
	for (const w of words(command)) {
		for (const b of braceExpand(w)) {
			const u = unquote(b);
			if (/DF_TAKEOVER/i.test(u) || /^--takeover\b/i.test(u)) return true;
		}
	}
	return (
		/\$\{!/.test(command) ||
		/\b(declare|typeset|local)\s+(-\w*\s+)*-\w*n\b/.test(command) ||
		/\bprintf\s+(-\w+\s+)*-v\b/.test(command) ||
		/\b(export|declare|typeset|readonly|local|env)\s+(-\w+\s+)*["']?\$/.test(command)
	);
}
