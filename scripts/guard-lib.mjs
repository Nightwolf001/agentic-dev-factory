// Deny rules for a factory agent's shell. Pure function so it is unit-tested; guard-bash.sh feeds it
// the PreToolUse hook input. A hook sees command strings only, so this is a guard against mistakes
// and against ordinary bypasses (wrappers, global options, substitutions, inline interpreters), not a
// sandbox: an agent that writes and runs its own program is stopped by the real separation, which is that
// the builder has no Jira or GitHub tools, the scheduler holds the credentials, and a person merges.
const PROTECTED = new Set(['develop', 'preprod', 'main', 'master']);
const READ_ONLY_ROLES = new Set(['reviewer', 'debugger', 'researcher']);

const base = (t) => t.replace(/^\\/, '').replace(/^.*\//, '');

// Splits on ; && || | & and newlines outside quotes, so `grep -E "a|b"` stays one command. Null when a quote is open.
function splitTop(command) {
	const parts = [];
	let cur = '';
	let q = null;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		const n = command[i + 1];
		if (q) {
			cur += c;
			if (c === '\\' && q === '"' && n !== undefined) cur += command[++i];
			else if (c === q) q = null;
			continue;
		}
		if (c === '\\' && n !== undefined) {
			cur += c + command[++i];
			continue;
		}
		if (c === "'" || c === '"') {
			q = c;
			cur += c;
			continue;
		}
		if (c === '>' && n === '&') {
			cur += c + command[++i];
			while (/[\d-]/.test(command[i + 1] ?? '')) cur += command[++i];
			continue;
		}
		if (c === '&' && n === '>') {
			cur += '>';
			i++;
			continue;
		}
		if (';|&\n'.includes(c)) {
			parts.push(cur);
			cur = '';
			if ((c === '&' || c === '|') && n === c) i++;
			continue;
		}
		cur += c;
	}
	parts.push(cur);
	return q ? null : parts;
}

// Command substitutions (balanced, so $(a $(b)) yields the outer text and the recursion in segments() reaches the inner)
// and `sh -c` payloads run as commands of their own, so each is judged on its own.
function nested(command) {
	const out = [];
	for (let i = 0; i < command.length - 1; i++) {
		if (command[i + 1] !== '(' || !'$<>'.includes(command[i])) continue;
		let depth = 1;
		let j = i + 2;
		for (; j < command.length && depth; j++) depth += command[j] === '(' ? 1 : command[j] === ')' ? -1 : 0;
		out.push(command.slice(i + 2, depth ? j : j - 1));
		i = j - 1;
	}
	for (const m of command.matchAll(/`([^`]*)`/g)) out.push(m[1]);
	for (const m of command.matchAll(/\b(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*-\w*c\s+(?:'([^']*)'|"([^"]*)")/g)) out.push(m[1] ?? m[2]);
	return out;
}

// Words of a segment, split on whitespace outside quotes, so FOO="a b" is one word.
function tokenize(seg) {
	const out = [];
	let cur = '';
	let q = null;
	for (const c of seg) {
		if (q) {
			cur += c;
			if (c === q) q = null;
		} else if (c === "'" || c === '"') {
			q = c;
			cur += c;
		} else if (/\s/.test(c)) {
			if (cur) out.push(cur);
			cur = '';
		} else cur += c;
	}
	if (cur) out.push(cur);
	return out;
}

const KEYWORD = /^(then|do|else|elif|if|while|until|!|\{|\()\s+/;

// Strips leading VAR=value assignments and control keywords.
export function segments(command, depth = 0) {
	const own = (splitTop(command) ?? command.split(/&&|\|\||[;&|\n]/))
		.map((s) => {
			let t = s.trim();
			for (let prev = ''; prev !== t; ) {
				prev = t;
				t = t.replace(/^(\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '').replace(KEYWORD, '');
			}
			return t;
		})
		.filter(Boolean);
	return depth > 3 ? own : [...own, ...nested(command).flatMap((n) => segments(n, depth + 1))];
}

// Commands that run another command: a wrapper hides git or gh from a check on the first word.
const WRAPPERS = {
	command: [],
	builtin: [],
	exec: [],
	nohup: [],
	time: [],
	setsid: [],
	env: ['-u', '-C', '-S'],
	sudo: ['-u', '-g', '-h', '-p', '-C', '-U', '-T'],
	nice: ['-n'],
	xargs: ['-n', '-I', '-L', '-P', '-s', '-d', '-E', '-a', '-R', '-S'],
	timeout: ['-s', '-k'],
	stdbuf: ['-i', '-o', '-e'],
};

// -> { cmd, args, tokens }: the command a segment really runs, past wrappers, with its basename.
function invocation(seg) {
	const tokens = tokenize(seg);
	let t = tokens;
	for (;;) {
		while (t.length && /^\w+=/.test(t[0])) t = t.slice(1);
		const head = base(t[0] ?? '');
		if (!Object.hasOwn(WRAPPERS, head)) break;
		t = t.slice(1);
		while (t.length && (t[0].startsWith('-') || /^\w+=/.test(t[0]))) t = WRAPPERS[head].includes(t[0]) ? t.slice(2) : t.slice(1);
		if (head === 'timeout' && /^\d/.test(t[0] ?? '')) t = t.slice(1);
	}
	return { cmd: base(t[0] ?? ''), args: t.slice(1), tokens };
}

const GIT_VALUE_OPTS = new Set([
	'-C',
	'-c',
	'--git-dir',
	'--work-tree',
	'--namespace',
	'--exec-path',
	'--super-prefix',
	'--config-env',
	'--attr-source',
]);
// Config a one-off `git -c` may set: nothing that rewrites aliases, hooks, remotes, credentials or programs.
const SAFE_GIT_CONFIG = /^(advice\.\w+|color\.\w+|core\.(quotepath|safecrlf|autocrlf)|user\.(name|email))=/;

function gitParts(args) {
	for (let i = 0; i < args.length; i++) {
		if (!args[i].startsWith('-')) return { sub: args[i], rest: args.slice(i + 1), globals: args.slice(0, i) };
		if (GIT_VALUE_OPTS.has(args[i])) i++;
	}
	return { sub: undefined, rest: [], globals: args };
}

function denyGit(args, ctx, seg) {
	const { sub, rest, globals } = gitParts(args);
	for (let i = 0; i < globals.length; i++) {
		if (globals[i] === '-c' && !SAFE_GIT_CONFIG.test(globals[i + 1] ?? '')) return `git -c ${globals[i + 1] ?? ''} is not allowed`;
	}
	if (sub === 'push') {
		if (/\s(--force|-f|--force-with-lease|--delete|-d|--mirror|--all)\b/.test(seg) || /\s\+\S/.test(seg))
			return 'git push with force, delete or mirror flags is not allowed';
		if (!ctx.branch) return 'a push needs a known ticket branch; the scheduler does not push';
		const refspecs = rest.filter((a) => !a.startsWith('-')).slice(1);
		for (const r of refspecs) {
			if (r.startsWith(':')) return 'deleting a remote ref is not allowed';
			const target = r.includes(':') ? r.split(':')[1] : r;
			const name = target === 'HEAD' ? ctx.branch : target.replace(/^refs\/heads\//, '');
			if (PROTECTED.has(name)) return `pushing to ${name} is not allowed`;
			if (name !== ctx.branch) return `only the ticket branch ${ctx.branch} may be pushed (got ${name})`;
		}
		if (!refspecs.length && PROTECTED.has(ctx.branch)) return `current branch ${ctx.branch} is protected`;
	}
	if (sub === 'reset' && /--hard/.test(seg)) return 'git reset --hard is not allowed';
	if (sub === 'branch' && /\s-D\b/.test(seg)) return 'git branch -D is not allowed';
	if (sub === 'clean' && /\s-\w*f/.test(seg)) return 'git clean -f is not allowed';
	if ((sub === 'checkout' || sub === 'switch') && rest.some((a) => PROTECTED.has(a))) return 'switching to a protected branch is not allowed';
	return null;
}

// Positional words of a gh command, past the flags that take a value and may precede the subcommand.
const ghPositionals = (args) => {
	const out = [];
	for (let i = 0; i < args.length; i++) {
		if (['-R', '--repo', '--hostname'].includes(args[i])) i++;
		else if (!args[i].startsWith('-')) out.push(args[i]);
	}
	return out;
};

// `gh api` is a POST as soon as it carries a body field or input, with no -X at all.
function ghApiWrites(args) {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (/^(-X|--method)(=|$)/.test(a)) {
			const value = a.includes('=') ? a.split('=')[1] : args[i + 1];
			if (!/^GET$/i.test(value ?? '')) return true;
		}
		if (/^-[fF]/.test(a) || /^--(field|raw-field|input)(=|$)/.test(a)) return true;
	}
	return false;
}

function denyGh(args) {
	const p = ghPositionals(args);
	if (p[0] === 'pr' && ['merge', 'review', 'ready', 'close', 'reopen'].includes(p[1])) return `gh pr ${p[1]} is reserved for people`;
	if (p[0] === 'api' && ghApiWrites(args)) return 'gh api writes are not allowed: no -X other than GET, no body field, no --input';
	if (['release', 'alias', 'secret', 'variable'].includes(p[0]) || (p[0] === 'repo' && ['delete', 'edit', 'archive'].includes(p[1])))
		return `gh ${p[0]} is not allowed`;
	return null;
}

const ENV_FILE = /(^|[\s/='"])\.env(\.(?!example\b)[\w.-]*)?(?=$|[\s'"])/;
// A run of inline interpreter code can write anything the hook cannot see.
const INLINE_CODE = [
	[/^(node|nodejs|bun)$/, /^(-e|--eval|-p|--print|-pe|-ep)$/],
	[/^(python[\d.]*|pypy[\d.]*)$/, /^-\w*c$/],
	[/^(ruby|lua|osascript)$/, /^-e$/],
	[/^perl$/, /^-\w*[eE]$/],
	[/^php$/, /^-r$/],
	[/^deno$/, /^eval$/],
];
const PROGRAM_RUNNERS = /^(awk|gawk|mawk|nawk)$/;

function denyCommon(seg, tokens, cmd) {
	if (ENV_FILE.test(seg)) return 'env files hold credentials and are not readable from the shell';
	if (cmd === 'eval') return 'eval is not allowed';
	for (let i = 0; i < tokens.length; i++) {
		const name = base(tokens[i]);
		if (PROGRAM_RUNNERS.test(name)) return 'awk programs can run commands and write files';
		for (const [runner, flag] of INLINE_CODE)
			if (runner.test(name) && tokens.slice(i + 1).some((a) => flag.test(a)))
				return 'inline interpreter code is not allowed; put it in a test or a script file in the repository';
	}
	return null;
}

// A reviewer reads and records; it never edits, installs or pushes. Everything it runs must match one of these.
const REVIEWER_ALLOWED = [
	// a dispatched agent's shell starts in the scheduler's directory and a cd does not carry to its next call,
	// so a read-only role moves into the worktree inside the same command: `cd <worktree> && git diff ...`
	/^cd\s+[\w./~-]+$/,
	/^git\s+(diff|log|show|status|rev-parse|merge-base|ls-files|cat-file|blame|grep|rev-list|diff-tree)\b/,
	/^node\s+\S*dev-factory\/bin\/qa\.mjs\s+(review|learnings)\b/,
	/^(grep|rg|ls|cat|head|tail|wc|sort|uniq|jq|nl|pwd|echo|basename|dirname|stat|file)\b/,
	// print-only sed: any other script (w, e) can write or run a command
	/^sed\s+-n\s+(['"]?)\d+(,(\d+|\$))?p\1\s+[^\s;&|<>$`]+$/,
	/^find\b(?!.*\s-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b)/,
];

// A debugger also reads the ticket's own stack (compose ps and logs, pm2 logs and process list, curl against
// *.olarm.local) and records through qa.mjs debug and scrub. It still never edits, installs or pushes.
const DEBUGGER_EXTRA = [
	/^node\s+\S*dev-factory\/bin\/qa\.mjs\s+(debug|scrub)\b/,
	/^docker\s+compose\s+(-f\s+\S+\s+)?(-p\s+\S+\s+)?(ps|logs)\b/,
	/^docker\s+compose\s+(-f\s+\S+\s+)?(-p\s+\S+\s+)?exec\s+-T\s+(-u\s+\S+\s+)?devcontainer\s+pm2\s+(logs\s+--nostream|jlist|status|list)\b/,
	// the red loop: a test runner or curl inside the ticket's own devcontainer
	/^docker\s+compose\s+(-f\s+\S+\s+)*(-p\s+\S+\s+)?exec\s+-T\s+(-u\s+\S+\s+)?(-w\s+\S+\s+)?devcontainer\s+(npx\s+(vitest|jest|playwright\s+test)|npm\s+(test|run\s+test\S*)|node\s+--test|yarn\s+(test|vitest|jest))\b/,
	// the whole segment must be one plain URL: a trailing $(...) or second URL is not a read of the ticket stack
	/^curl\s+(-[ksfSLI]+\s+)*https?:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.olarm\.local(:\d+)?(\/[\w\-./?=%:,+@]*)?$/,
];
const CURL_WRITE = /\s(-X|--request|-d|--data\S*|-F|--form|-T|--upload-file|-o|--output|-O)\b/;
// Substitution, process substitution and variables run or read things the allowlist never saw; single quotes are literal.
const EXPANSION = /\$\(|\$\{|\$[A-Za-z_]|`|<\(|>\(/;

function denyForReadOnly(seg, extra = []) {
	if (EXPANSION.test(seg.replace(/'[^']*'/g, "''"))) return 'shell expansion is not allowed for this role';
	if (/(^|[^2&])>{1,2}\s*[^&\s]/.test(seg.replace(/\d?>\s*\/dev\/null/g, ''))) return 'this role does not write files';
	if (/\bsed\b.*\s-i/.test(seg)) return 'this role does not edit files';
	if (/^curl\b/.test(seg) && CURL_WRITE.test(seg)) return 'curl is read-only here: no method override, body or output file';
	if (/^git\b/.test(seg) && /(^|\s)(--output\b|-O\S*|--open-files-in-pager\b|--ext-diff\b|--textconv\b)/.test(seg))
		return 'git output files, pagers and external diff programs are not allowed';
	if (/^sort\b/.test(seg) && /\s(-[a-zA-Z]*o[a-zA-Z]*(\s|$)|--output\b|--compress-program\b)/.test(seg)) return 'sort may not write an output file';
	if (/^rg\b/.test(seg) && /\s--pre(-glob)?\b/.test(seg)) return 'rg --pre runs a command';
	if (
		/^uniq\b/.test(seg) &&
		seg
			.split(/\s+/)
			.slice(1)
			.filter((a) => !a.startsWith('-')).length > 1
	)
		return 'uniq may not write an output file';
	if ([...REVIEWER_ALLOWED, ...extra].some((re) => re.test(seg))) return null;
	return extra.length
		? 'a debugger may only read the diff, the ticket stack logs and record through qa.mjs debug'
		: 'a reviewer may only read the diff and record its review (git diff/log/show, grep, ls, cat, qa.mjs review)';
}

export function evaluate(command, ctx = {}) {
	const readOnly = READ_ONLY_ROLES.has(ctx.role);
	for (const seg of segments(command)) {
		const { cmd, args, tokens } = invocation(seg);
		const deny = (why) => ({ deny: true, reason: `dev-factory guard: ${why} [${seg.slice(0, 80)}]` });
		const common = denyCommon(seg, tokens, cmd);
		if (common) return deny(common);
		if (readOnly) {
			const why = denyForReadOnly(seg, ctx.role === 'debugger' ? DEBUGGER_EXTRA : []);
			if (why) return deny(why);
			continue;
		}
		const touchesProtected = PROTECTED_BASH.test(seg);
		if (touchesProtected && WRITE_LIKE.test(seg) && !/^node\s+\S*dev-factory\/bin\/qa\.mjs\s/.test(seg)) {
			return deny('factory files and run state are changed only through qa.mjs and the scheduler');
		}
		if (ctx.role === 'promoter' && WRITE_LIKE.test(seg) && !/^(git|gh|node)\s/.test(seg) && !SENTINEL_SHELL.test(seg)) {
			return deny('a promoter changes files only through the edit tools');
		}
		const body = [cmd, ...args].join(' ');
		let reason = null;
		if (cmd === 'git') reason = denyGit(args, ctx, seg);
		else if (cmd === 'gh') reason = denyGh(args);
		if (!reason && /\b(curl|wget|http|https)\b.*atlassian\.net/.test(seg)) reason = 'direct Jira access is reserved for the scheduler';
		if (!reason && /^docker\s+(system|volume|image|builder|network|container)\s+prune/.test(body)) reason = 'docker prune is not allowed';
		if (
			!reason &&
			/^(npm\s+(--prefix\s+\S+\s+)?(install|i|ci|test|run\s+test)\b|npx\s+(vitest|jest|playwright\s+test)\b|yarn\s+(--cwd\s+\S+\s+)?(test|jest|vitest)\b|pnpm\s+(install|i|test|run\s+test|jest|vitest)\b)/.test(
				body,
			)
		) {
			reason = 'services are installed and tested inside the devcontainer, not on the host (docker compose exec ... devcontainer ...)';
		}
		if (reason) return deny(reason);
	}
	return { deny: false };
}

// Shell writes to the factory directory (its own QA cases aside), run state, evidence and review records, hook wiring and husky are refused.
const PROTECTED_BASH =
	/\.dev-factory\/(review|qa|evidence|debug)(\/|\s|$)|\.dev-factory\/(run|env)\.json|(^|[\s/'"])dev-factory\/(?!qa\/cases\/)|\.dev-factory\/compose\.override\.yml|\.claude\/|\.github\/workflows|\.husky\//;
const WRITE_LIKE = /(^|[^2&0-9])>{1,2}\s*[^&\s]|\btee\b|\b(cp|mv|rm|ln|truncate|dd|install)\b|\bsed\s+-i|\bperl\s+-i/;

const FORBIDDEN = new RegExp(['co[-_ ]?' + 'work', 'co[-_ ]?' + 'lab', 'night[-_ ]?' + 'shift', 'day[-_ ]?' + 'shift'].join('|'), 'i');

// Hand-off files every role may write with the edit tools: the stop gate waits on them.
const SENTINEL = /^\.dev-factory\/(blocked\.json|improve\.done|promote\.done|needs_debug\.json)$/;
const SENTINEL_SHELL = /\.dev-factory\/(blocked\.json|improve\.done|promote\.done|needs_debug\.json)\b/;

const normalize = (p, root) => {
	const abs = p.startsWith('/') ? p : `${root}/${p}`;
	return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
};

// Edit, Write and MultiEdit. Vocabulary applies to everyone editing dev-factory/; path protection only inside a factory run.
export function evaluateEdit({ filePath, text = '', root, active = false, run = null }) {
	if (typeof filePath !== 'string' || !filePath) return { deny: false };
	const rel = normalize(filePath, root);
	if (/^dev-factory\//.test(rel) && FORBIDDEN.test(text)) {
		return { deny: true, reason: 'dev-factory guard: this vocabulary is not allowed under dev-factory/ (see scripts/lint-vocabulary.sh)' };
	}
	if (!active) return { deny: false };
	if (SENTINEL.test(rel)) return { deny: false };
	if (run?.role === 'reviewer' || run?.role === 'debugger') return { deny: true, reason: `dev-factory guard: ${run.role}s do not edit files` };
	if (run?.role === 'promoter') {
		// A promoter appends short rules to AGENTS.md files; qa.mjs promote check proves nothing else changed.
		return /(^|\/)AGENTS\.md$/.test(rel) && !rel.startsWith('dev-factory/') && !rel.includes('..')
			? { deny: false }
			: { deny: true, reason: `dev-factory guard: a promoter edits only AGENTS.md files outside dev-factory/ (got ${rel})` };
	}
	if (run?.role === 'researcher') {
		const own = `docs/plans/${run.key}/research.md`;
		return rel === own ? { deny: false } : { deny: true, reason: `dev-factory guard: a researcher writes only ${own}` };
	}
	if (run?.role === 'improver') {
		// An improver may change the factory, except the files that enforce its own limits.
		const enforcement =
			/^dev-factory\/(scripts\/(guard-lib|guard-bash|edit-guard|stop-gate|stop-gate-lib|mcp-guard|mcp-guard-lib|scrub-lib|debug-lib)\.|bin\/qa\.mjs|hooks\/|settings\.factory\.json|config\.json|plugins\.json)/;
		if (enforcement.test(rel))
			return {
				deny: true,
				reason: `dev-factory guard: ${rel} enforces the factory's own limits; changes to it are made by a person, file a Jira issue instead`,
			};
		if (rel.startsWith('dev-factory/') && !rel.includes('..')) return { deny: false };
		return { deny: true, reason: `dev-factory guard: an improver changes only dev-factory/ (got ${rel})` };
	}
	const ownCase = run?.key && rel.startsWith(`dev-factory/qa/cases/${run.key}/`);
	const protectedPath =
		/^(dev-factory\/|\.claude\/|\.github\/|\.husky\/|\.dev-factory\/(review|qa|evidence|debug)\/|\.dev-factory\/(run|env)\.json|\.dev-factory\/compose\.override\.yml)/.test(
			rel,
		);
	if (protectedPath && !ownCase) {
		return {
			deny: true,
			reason: `dev-factory guard: ${rel} is part of the factory or its run state; a ticket changes only its own code, tests and qa/cases/${run?.key ?? '<KEY>'}/`,
		};
	}
	return { deny: false };
}
