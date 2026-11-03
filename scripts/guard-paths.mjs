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

// `{a,b}` lists, as the shell expands them before anything else. `${...}` is left alone. Nested lists expand too.
export function braceExpand(word, limit = LIMITS.expansions) {
	const out = [];
	const walk = (w) => {
		if (out.length > limit) throw new Unjudgeable('a brace list that expands to too many words');
		for (let i = 0; i < w.length; i++) {
			if (w[i] === '$' && w[i + 1] === '{') {
				const close = w.indexOf('}', i);
				if (close < 0) break;
				i = close;
				continue;
			}
			if (w[i] !== '{') continue;
			let depth = 0;
			const cuts = [];
			let end = -1;
			for (let j = i; j < w.length; j++) {
				if (w[j] === '{') depth++;
				else if (w[j] === '}' && --depth === 0) {
					end = j;
					break;
				} else if (w[j] === ',' && depth === 1) cuts.push(j);
			}
			if (end < 0 || !cuts.length) continue;
			const alts = [];
			let from = i + 1;
			for (const c of [...cuts, end]) {
				alts.push(w.slice(from, c));
				from = c + 1;
			}
			for (const a of alts) walk(w.slice(0, i) + a + w.slice(end + 1));
			return;
		}
		out.push(w);
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

// ~ and the few variables a path is usually built from. Any other variable stays as text, so the path it makes is unknown.
export function expandVars(word, vars) {
	let w = word;
	if (w === '~' || w.startsWith('~/')) w = vars.HOME + w.slice(1);
	return w.replace(/\$(?:\{(\w+)[^}]*\}|(\w+))/g, (m, a, b) => vars[a ?? b] ?? m);
}

// Every path a token might name: the token, the value after `=` (--file=x, VAR=x), an option with its value attached (-ox),
// and the file of a redirection (>x, 2>>x). Each is brace-expanded, unquoted and variable-expanded.
export function candidates(token, vars) {
	const raw = new Set([token]);
	const eq = token.indexOf('=');
	if (eq > -1) raw.add(token.slice(eq + 1));
	const short = /^-[A-Za-z]([/~$.].*)$/.exec(token);
	if (short) raw.add(short[1]);
	for (const piece of token.split(/[<>|]+/)) if (piece) raw.add(piece);
	const out = new Set();
	for (const r of raw)
		for (const b of braceExpand(r))
			for (const part of [b, ...b.split(/[:,]/)]) {
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
const PROFILE_BASENAME = new RegExp(`^(${PROFILE_FILES.map((f) => f.replace('.', '\\.')).join('|')})$`, 'i');

export function envOf(ctx = {}) {
	const env = ctx.env ?? process.env;
	const home = ctx.home ?? env.HOME ?? os.homedir();
	const stateDir = ctx.stateDir ?? env.DF_STATE_DIR ?? path.join(home, '.dev-factory');
	return { env, home, stateDir };
}

const lower = (p) => p.toLowerCase();
const within = (p, dir) => p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/');

// -> a short name for what an absolute path is, or null. Paths are compared in lower case (macOS volumes ignore case).
//   state    the machine state folder (secrets, locks, logs, the run pointer, the settings a pass runs with)
//   profile  a shell start-up file, which runs in every later shell
//   plugin   the installed plugin or any plugin, under .claude/plugins
//   claude   Claude Code's own settings
export function protectedPlace(abs, ctx = {}) {
	const { home, stateDir } = envOf(ctx);
	const p = lower(path.posix.normalize(abs));
	const h = lower(home);
	if (within(p, lower(stateDir))) return 'state';
	if (PROFILE_BASENAME.test(path.posix.basename(p))) return 'profile';
	if (within(p, `${h}/.config/fish`)) return 'profile';
	if (/(^|\/)\.claude\/plugins(\/|$)/.test(p)) return 'plugin';
	if (p === `${h}/.claude.json` || new RegExp(`^${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.claude/settings[^/]*\\.json$`).test(p))
		return 'claude';
	return null;
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
