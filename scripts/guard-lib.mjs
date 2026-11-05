// Deny rules for a factory agent's shell. Pure function so it is unit-tested; guard-bash.sh feeds it
// the PreToolUse hook input. A hook sees command strings only, so this is a guard against mistakes
// and against ordinary bypasses (wrappers, global options, substitutions, inline interpreters), not a
// sandbox: an agent that writes and runs its own program is stopped by the real separation, which is that
// the builder has no task-tracker or GitHub tools, the scheduler holds the credentials, and a person merges.
import path from 'node:path';
import {
	LIMITS,
	Unjudgeable,
	ancestorOfProtected,
	budget,
	candidates,
	envOf,
	namesEnvFile,
	protectedPlace,
	realPath,
	resolveWord,
	runStatePlace,
	runStateRoot,
	unquote as shellUnquote,
	triesTakeover,
} from './guard-paths.mjs';
import { PLUGIN_ROOT } from './plugin-root.mjs';

// `node <plugin>/bin/qa.mjs <rest>`: the real script of this plugin (its own directory, quoted or not), or one vendored at
// dev-factory/ in the working directory (`dev-factory/bin/qa.mjs`, with or without `./`). A file called qa.mjs that an agent wrote
// elsewhere, `./evil/dev-factory/bin/qa.mjs` included, is not it.
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function qaBin(rest = '') {
	const own = `"?${escapeRe(PLUGIN_ROOT)}/bin/qa\\.mjs"?`;
	return new RegExp(`^node\\s+(?:${own}|(?:\\./)?dev-factory/bin/qa\\.mjs)\\s${rest ? `+${rest}` : ''}`);
}

// `node <plugin>/scripts/config.mjs get <one.setting>`: a read-only role may read one setting of the merged configuration (the
// repository skills of its phase, the files a reviewer reads first). Nothing but a dotted name follows `get`.
export function configGet() {
	const own = `"?${escapeRe(PLUGIN_ROOT)}/scripts/config\\.mjs"?`;
	return new RegExp(`^node\\s+(?:${own}|(?:\\./)?dev-factory/scripts/config\\.mjs)\\s+get\\s+[A-Za-z][\\w.]*$`);
}

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

// A heredoc with a quoted tag (<<'EOF') is text: nothing in it expands, so its lines are not commands, unless the command reading it
// is an interpreter (bash <<'EOF' runs them). An unquoted tag expands $(...) in its body, so those lines stay to be judged.
const INTERPRETERS =
	/^(?:\w+=\S*\s+)*(?:sudo\s+|env\s+|exec\s+|command\s+)*(?:ba|z|da|k)?sh\b|^(?:\w+=\S*\s+)*(?:sudo\s+|env\s+|exec\s+)*(node|nodejs|bun|deno|python[\d.]*|ruby|perl|php|lua|osascript|awk|xargs|source|\.|eval)\b/;
export function stripHeredocs(command) {
	if (!command.includes('<<')) return command;
	const lines = command.split('\n');
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		out.push(lines[i]);
		const m = /<<-?\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\(\w+))/.exec(lines[i]);
		if (!m || /<<</.test(lines[i]) || INTERPRETERS.test(lines[i].replace(/^[\s({]+/, ''))) continue;
		const tag = m[1] ?? m[2] ?? m[3];
		const stripTabs = /<<-/.test(lines[i]);
		let end = -1;
		for (let j = i + 1; j < lines.length; j++) {
			if ((stripTabs ? lines[j].replace(/^\t+/, '') : lines[j]) === tag) {
				end = j;
				break;
			}
		}
		if (end > i) i = end; // the body and its tag line are data
	}
	return out.join('\n');
}

// Strips leading VAR=value assignments and control keywords.
export function segments(command, depth = 0) {
	command = stripHeredocs(command);
	const own = (splitTop(command) ?? command.split(/&&|\|\||[;&|\n]/))
		.map((s) => {
			let t = s.trim();
			for (let prev = ''; prev !== t; ) {
				prev = t;
				t = t.replace(/^(\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '').replace(KEYWORD, '');
			}
			// a subshell or group written without a space, (git push) or {git push}: the command inside is judged, not the bracket
			const opened = /^[({]/.test(t);
			t = t.replace(/^[({]+\s*/, '');
			if (opened) t = t.replace(/\s*[)}]+$/, '');
			// a group opened in an earlier part of the line closes in this one: (git status; ls)
			else if (/[)}]$/.test(t)) {
				const count = (re) => (t.match(re) ?? []).length;
				while (/[)}]$/.test(t) && count(/\)/g) > count(/\(/g) && !/\$\([^)]*\)$/.test(t)) t = t.replace(/\s*[)}]$/, '');
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
	const tokens = tokenize(seg).map(shellUnquote);
	let t = tokens;
	for (;;) {
		while (t.length && /^\w+=/.test(t[0])) t = t.slice(1);
		const head = base(t[0] ?? '');
		if (!Object.hasOwn(WRAPPERS, head)) break;
		t = t.slice(1);
		while (t.length && (t[0].startsWith('-') || /^\w+=/.test(t[0]))) t = WRAPPERS[head].includes(t[0]) ? t.slice(2) : t.slice(1);
		if (head === 'timeout' && /^\d/.test(t[0] ?? '')) t = t.slice(1);
	}
	return { cmd: base(t[0] ?? ''), args: t.slice(1), tokens, head: t[0] ?? '' };
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

// Commits and PR text carry the person's own identity, never an agent's: no Co-Authored-By or "generated with" line, no
// author override, no identity set through config or environment. Switched off with git.agentAttribution.
const AGENT_MARK = /co-authored-by|noreply@anthropic\.com|generated with\b.{0,40}claude/i;
const PROGRAM_ENV =
	/(^|[\s;&|(])(GIT_(SSH|SSH_COMMAND|ASKPASS|EXTERNAL_DIFF|PAGER|EDITOR|SEQUENCE_EDITOR|EXEC_PATH|PROXY_COMMAND|CONFIG_(COUNT|KEY_\d+|VALUE_\d+|GLOBAL|SYSTEM|PARAMETERS))|BASH_ENV|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_(INSERT_LIBRARIES|LIBRARY_PATH)|PROMPT_COMMAND)=/;
const IDENTITY_ENV = /(^|\s)GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)=/;
function denyAttribution(sub, rest, seg) {
	if (sub === 'commit') {
		if (rest.some((a) => /^--(author|reset-author|trailer)\b/.test(a)))
			return 'commits use the git user of this machine: no --author, --reset-author or --trailer';
		if (AGENT_MARK.test(seg)) return 'commit messages carry no Co-Authored-By or generated-by line (git.agentAttribution is false)';
	}
	if (sub === 'config') {
		// reading user.name is fine; giving it a value, or unsetting it, changes whose commits these are
		const at = rest.findIndex((a) => /^user\./i.test(a));
		const writes = rest.some((a) => /^--(unset|unset-all|add|replace-all|edit)$/.test(a));
		if (at > -1 && (writes || rest.slice(at + 1).some((a) => !a.startsWith('-'))))
			return "the git identity is the person's own: user.* is not changed";
	}
	return null;
}

function denyGit(args, ctx, seg) {
	const { sub, rest, globals } = gitParts(args);
	if (ctx.noAttribution) {
		const why = denyAttribution(sub, rest, seg);
		if (why) return why;
	}
	for (let i = 0; i < globals.length; i++) {
		if (globals[i] === '-c' && ctx.noAttribution && /^user\./i.test(globals[i + 1] ?? ''))
			return "the git identity is the person's own: -c user.* is not allowed";
		if (globals[i] === '-c' && !SAFE_GIT_CONFIG.test(globals[i + 1] ?? '')) return `git -c ${globals[i + 1] ?? ''} is not allowed`;
	}
	if (sub === 'push') {
		const flat = ` ${args.join(' ')}`;
		// -f also hides in a cluster (-fu, -uf), and the words are judged after their quotes are gone
		if (
			/\s(--force|--force-with-lease|--force-if-includes|--delete|--mirror|--all)\b/.test(flat) ||
			/\s-[A-Za-z]*[fd][A-Za-z]*(\s|$)/.test(flat) ||
			/\s\+\S/.test(flat)
		)
			return 'git push with force, delete or mirror flags is not allowed';
		if (rest.some((a) => /^--(repo|receive-pack|exec)\b/.test(a))) return 'git push --repo, --receive-pack and --exec are not allowed';
		// the remote is a name from the repository's own configuration, never an address: a push to one would send the branch elsewhere
		const remote = rest.filter((a) => !a.startsWith('-'))[0];
		if (remote !== undefined && !/^[A-Za-z0-9_-]+$/.test(remote))
			return `git push goes to a configured remote by name, not to ${remote.slice(0, 40)}`;
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
	// configuration and remotes decide what program git runs and where it sends things: a run does not change them
	if (sub === 'config') {
		const keys = rest.filter((a) => !a.startsWith('-'));
		const reads = rest.some((a) => /^(--get|--get-all|--get-regexp|--get-urlmatch|-l|--list|--show-origin|--show-scope|--name-only|-z)$/.test(a));
		const writes =
			!reads &&
			(keys.length > 1 || rest.some((a) => /^(--add|--unset|--unset-all|--replace-all|--edit|-e|--rename-section|--remove-section)$/.test(a)));
		const key = (keys[0] ?? '').toLowerCase();
		if (writes && !/^(advice\.\w+|color\.\w+|core\.(quotepath|safecrlf|autocrlf))$/.test(key))
			return `git config ${key.slice(0, 40)} can make git run a program or send to another address, so a run does not set it`;
	}
	if (sub === 'remote' && rest.some((a) => /^(add|set-url|rename|remove|rm|set-branches|set-head)$/.test(a)))
		return 'git remote changes are not made from a run';
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

// The one request to a tracker the scheduler makes with curl: Notion hands out an upload URL for each QA screenshot
// (notion-create-file-upload) and the file goes there as multipart. Only an evidence image, only to a file-upload URL.
const NOTION_UPLOAD_URL = /^https:\/\/api\.notion\.com\/v1\/(?:mcp\/)?file_uploads\/[0-9a-f-]{32,36}\/send$/i;
const EVIDENCE_FILE = /^file=@(?:[^\s"']*\/)?\.dev-factory\/evidence\/[\w.-]+\/run-\d+\/[\w.-]+(;type=image\/[\w.+-]+)?$/;
const unquote = (t) => t.replace(/^(["'])(.*)\1$/, '$2');
function notionUpload(cmd, args) {
	// the helper checks its own file, URL and size (scripts/notion-upload-lib.mjs)
	if (cmd === 'node' && /(^|\/)scripts\/notion-upload\.mjs$/.test(unquote(args[0] ?? ''))) return true;
	if (cmd !== 'curl') return false;
	let urls = 0;
	for (let i = 0; i < args.length; i++) {
		const a = unquote(args[i]);
		const next = unquote(args[i + 1] ?? '');
		if (/^-[sSf]+$/.test(a) || /^--(fail|silent|show-error)$/.test(a)) continue;
		if (a === '-X' && next === 'POST') i++;
		else if (a === '-H' && next && !/[$`]/.test(next)) i++;
		else if (a === '-F' && EVIDENCE_FILE.test(next) && !next.includes('..')) i++;
		else if (NOTION_UPLOAD_URL.test(a)) urls++;
		else return false;
	}
	return urls === 1;
}

// The scheduler resolves the review threads it has answered, and reads them; a graphql mutation is allowed only for that.
function schedulerGraphql(args) {
	if (ghPositionals(args)[1] !== 'graphql') return false;
	if (args.some((a) => /^(--input|-X|--method)(=|$)/.test(a))) return false;
	const q = args.map((a, i) => (/^(-f|-F|--field|--raw-field)$/.test(args[i - 1] ?? '') ? unquote(a) : '')).find((a) => a.startsWith('query='));
	if (!q) return false;
	if (!/\bmutation\b/.test(q)) return true;
	const fields = [...q.matchAll(/(\w+)\s*\(\s*input\s*:/g)].map((m) => m[1]);
	return fields.length === 1 && fields[0] === 'resolveReviewThread';
}

const FACTORY_ROLES = new Set(['builder', 'reviewer', 'debugger', 'researcher', 'improver', 'promoter']);
const ISSUE_WRITES = ['create', 'edit', 'close', 'reopen', 'comment', 'delete', 'transfer', 'lock', 'unlock', 'pin', 'unpin', 'develop'];

function denyGh(args, ctx = {}, seg = '') {
	const p = ghPositionals(args);
	if (FACTORY_ROLES.has(ctx.role) && p[0] === 'issue' && ISSUE_WRITES.includes(p[1]))
		return 'issues are the task tracker: only the scheduler writes to it, a factory agent does not (gh issue ' + p[1] + ')';
	if (ctx.noAttribution && p[0] === 'pr' && ['create', 'edit', 'comment'].includes(p[1]) && AGENT_MARK.test(seg))
		return 'PR text carries no Co-Authored-By or generated-by line (git.agentAttribution is false)';
	if (p[0] === 'pr' && ['merge', 'review', 'ready', 'close', 'reopen'].includes(p[1])) return `gh pr ${p[1]} is reserved for people`;
	if (p[0] === 'api' && ghApiWrites(args) && (FACTORY_ROLES.has(ctx.role) || !schedulerGraphql(args)))
		return 'gh api writes are not allowed: no -X other than GET, no body field, no --input';
	if (
		p[0] === 'auth' &&
		(p[1] === 'token' || p[1] === 'refresh' || p[1] === 'login' || p[1] === 'logout' || args.includes('--show-token') || args.includes('-t'))
	)
		return 'the gh token is not shown or changed from a run';
	if (['release', 'alias', 'secret', 'variable'].includes(p[0]) || (p[0] === 'repo' && ['delete', 'edit', 'archive'].includes(p[1])))
		return `gh ${p[0]} is not allowed`;
	return null;
}

const ENV_FILE = /(^|[\s/='"])\.env(\.(?!example\b)[\w.-]*)?(?=$|[\s'"])/i;
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

// `env` with options and assignments only prints the environment; env is a wrapper, so invocation() looks past it.
function listsByEnv(tokens) {
	let t = tokens;
	while (t.length && /^\w+=/.test(t[0])) t = t.slice(1);
	if (base(t[0] ?? '') !== 'env') return false;
	return !t.slice(1).some((x) => !x.startsWith('-') && !/^\w+=/.test(x));
}

function denyCommon(seg, tokens, cmd, vars, ctxRole) {
	// by name as written, and by name as the shell would build it: quotes, case, globs such as .env.loca? and brace lists
	if (ENV_FILE.test(seg) || tokens.some((t) => namesEnvFile(t, vars))) return 'env files hold credentials and are not readable from the shell';
	if (cmd === 'eval') return 'eval is not allowed';
	// the QA account of a remote environment is in the pass's environment so that qa-login.sh and the cases can use it; a run does not print it
	if (FACTORY_ROLES.has(ctxRole)) {
		if (/DF_REMOTE_\w*_(USER|PASSWORD)/i.test(seg) || /\/proc\/[\w$]+\/environ/.test(seg))
			return 'the QA account variables (DF_REMOTE_*) are used by qa-login.sh and by cases through the environment; a command does not name or print them';
		if (
			cmd === 'printenv' ||
			listsByEnv(tokens) ||
			(/^(export|declare|typeset|compgen)$/.test(cmd) && !tokens.slice(1).some((t) => /^\w+=/.test(t))) ||
			(cmd === 'set' && tokens.length === 1)
		)
			return 'listing the environment would show secrets that the pass holds; read the one variable a script needs through that script';
	}
	// code read from standard input is inline code too: python3 - <<'EOF', node -, ruby < file
	if (
		/^(node|nodejs|bun|deno|python[\d.]*|pypy[\d.]*|ruby|perl|php|lua|osascript)$/.test(cmd) &&
		(/<<|<</.test(seg) || tokens.slice(1).includes('-'))
	)
		return 'inline interpreter code is not allowed, also on standard input; put it in a test or a script file in the repository';
	if (cmd === 'find' && tokens.some((t) => /^-(fls|fprint0?|fprintf)$/.test(t))) return 'find -fls, -fprint and -fprintf write files';
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
	qaBin('(review|learnings)\\b'),
	configGet(),
	/^(grep|rg|ls|cat|head|tail|wc|sort|uniq|jq|nl|pwd|echo|basename|dirname|stat|file)\b/,
	// print-only sed: any other script (w, e) can write or run a command
	/^sed\s+-n\s+(['"]?)\d+(,(\d+|\$))?p\1\s+[^\s;&|<>$`]+$/,
	/^find\b(?!.*\s-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b)/,
];

// A debugger also reads the ticket's own stack (compose ps and logs, pm2 logs and process list, curl against
// localhost and *.local / *.test hosts) and records through qa.mjs debug and scrub. It still never edits, installs or pushes.
const DEBUGGER_EXTRA = [
	qaBin('(debug|scrub)\\b'),
	/^docker\s+compose\s+(-f\s+\S+\s+)*(-p\s+\S+\s+)?(ps|logs)\b/,
	/^docker\s+compose\s+(-f\s+\S+\s+)*(-p\s+\S+\s+)?exec\s+-T\s+(-u\s+\S+\s+)?[A-Za-z][\w.-]*\s+pm2\s+(logs\s+--nostream|jlist|status|list)\b/,
	// the red loop: a test runner or curl inside the ticket's own devcontainer
	/^docker\s+compose\s+(-f\s+\S+\s+)*(-p\s+\S+\s+)?exec\s+-T\s+(-u\s+\S+\s+)?(-w\s+\S+\s+)?[A-Za-z][\w.-]*\s+(npx\s+(vitest|jest|playwright\s+test)|npm\s+(test|run\s+test\S*)|node\s+--test|yarn\s+(test|vitest|jest))\b/,
	// the whole segment must be one plain URL: a trailing $(...) or second URL is not a read of the ticket stack
	/^curl\s+(-[ksfSLI]+\s+)*https?:\/\/(localhost|127\.0\.0\.1|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.(local|localhost|test))(:\d+)?(\/[\w\-./?=%:,+@]*)?$/,
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

// Stopping things other than the run's own. The cleanup script tears down exactly what the run started; anything beyond that
// (killing other processes, stopping other containers, shutting simulators down) is the takeover toggle's, and even then a
// few targets stay refused: pid 0/1/-1, the parent, the shell, Claude, the terminal, the scheduler's own job, mass docker
// commands and wiping devices.
const PROTECTED_NAMES =
	/(^|[\s/'"])(-?(zsh|bash|fish|sh)|claude|anthropic|launchd|sshd|WindowServer|loginwindow|Finder|Dock|SystemUIServer|Terminal|iTerm2?|tmux|screen|node)(['"]|$)/i;
const DOCKER_STOPS = new Set(['stop', 'kill', 'rm', 'restart', 'pause', 'rmi']);

function denyProcessControl(seg, cmd, args, ctx) {
	const tokens = args.filter((a) => !a.startsWith('-'));
	const kill = (hard, soft) => (hard ? `${hard} (never allowed)` : ctx.takeover ? null : soft);
	const SOFT =
		'stopping what the run did not start is off: tear down the run with scripts/cleanup.mjs, or have the owner set DF_TAKEOVER=1 in the environment the scheduler starts with';
	if (cmd === 'kill') {
		if (/^%/.test(tokens[0] ?? '') && tokens.length === 1) return null; // a job of this shell
		const hard = args.some((a) => /^(0|1|-1|-0)$/.test(a) || /\$(\$|PPID|\{PPID\})/.test(a))
			? 'kill of pid 0/1/-1, the parent or the shell'
			: null;
		return kill(hard, SOFT);
	}
	if (cmd === 'pkill' || cmd === 'killall') {
		const hard =
			args.includes('-u') || args.includes('-U') || args.includes('-g') || tokens.some((t) => PROTECTED_NAMES.test(t) || /^\.?\*?$/.test(t))
				? `${cmd} of a user, a group, a shell, Claude or the terminal`
				: null;
		return kill(hard, SOFT);
	}
	if (cmd === 'docker') {
		const sub = tokens[0] === 'container' ? tokens[1] : tokens[0];
		if (!DOCKER_STOPS.has(sub) || tokens[0] === 'compose') return null;
		const hard = /\$\(|`|\bxargs\b/.test(seg) ? 'docker stop/kill/rm of everything at once' : null;
		return kill(hard, SOFT);
	}
	if (cmd === 'xcrun' && tokens[0] === 'simctl') {
		if (['erase', 'delete', 'uninstall'].includes(tokens[1]))
			return 'simctl erase/delete/uninstall destroys a device or its data (never allowed)';
		if (tokens[1] === 'shutdown') return kill(null, SOFT);
		return null;
	}
	if (cmd === 'launchctl' && ['bootout', 'unload', 'remove', 'kill', 'disable'].includes(tokens[0])) {
		return kill(/dev-?factory/i.test(seg) ? "stopping the factory's own scheduler job" : null, SOFT);
	}
	return null;
}

// ---- machine state, shell profiles and the installed plugin ----
// A run changes its worktree and what the factory records for it. It does not change the machine it runs on: the state folder
// (secrets, locks, the settings a pass runs with), the shell start-up files that run in every later shell, and the installed
// plugin. A command that names one of them is allowed only when it reads. Words are judged as the shell will build them
// (see scripts/guard-paths.mjs), in the directory the command has moved to.
const READERS = new Set([
	...['cat', 'head', 'tail', 'ls', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'stat', 'file', 'nl', 'diff', 'cmp', 'jq', 'du', 'tree'],
	...['readlink', 'realpath', 'basename', 'dirname', 'pwd', 'echo', 'printf', 'test', '[', 'cd', 'pushd', 'popd', 'true', 'false', 'which', 'type'],
	...['strings', 'od', 'xxd', 'shasum', 'md5', 'md5sum', 'sha256sum', 'cksum'],
]);
const GIT_READ = new Set([
	'status',
	'log',
	'diff',
	'show',
	'rev-parse',
	'ls-files',
	'cat-file',
	'blame',
	'grep',
	'rev-list',
	'diff-tree',
	'merge-base',
]);
const GIT_READ_MORE = new Set(['describe', 'shortlog', 'ls-tree', 'name-rev', 'for-each-ref', 'show-ref', 'count-objects']);
// commands whose plain arguments are files they change
const FILE_WRITERS = new Set([
	'rm',
	'mv',
	'cp',
	'ln',
	'touch',
	'mkdir',
	'rmdir',
	'truncate',
	'dd',
	'install',
	'chmod',
	'chown',
	'chgrp',
	'unlink',
	'shred',
	'rsync',
	'tee',
]);
const RUNNERS = new Set(['node', 'nodejs', 'bash', 'sh', 'zsh']);

function readsOnly(seg, cmd, args) {
	// any redirection that is not to /dev/null or a file descriptor writes a file
	if (/>/.test(seg.replace(/\d*>>?\s*\/dev\/null/g, '').replace(/\d*>&\d*-?/g, ''))) return false;
	if (READERS.has(cmd)) return !(cmd === 'rg' && args.some((a) => /^--pre(-glob)?\b/.test(a)));
	if (cmd === 'find') return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fls|fprint0?|fprintf)$/.test(a));
	if (cmd === 'git') {
		const { sub } = gitParts(args);
		return (GIT_READ.has(sub) || GIT_READ_MORE.has(sub)) && !args.some((a) => /^(--output\b|-O\S*|--ext-diff\b|--textconv\b)/.test(a));
	}
	if (cmd === 'sed') return args[0] === '-n' && /^(['"]?)\d*(,(\d+|\$))?p\1$/.test(args[1] ?? '') && args.length <= 3;
	return false;
}

const MACHINE_WHY = {
	state: "the machine's state folder (secrets, locks, the settings a pass runs with)",
	profile: 'a shell start-up file',
	plugin: 'the installed plugin',
	claude: "Claude Code's own settings",
	home: 'files that change what Claude Code, git and launchd run on this machine (commands, agents, skills, hooks, ~/.gitconfig, LaunchAgents)',
	git: "a repository's hooks and configuration (a program put there runs the next time the scheduler uses git)",
	secret: 'credentials (ssh and cloud keys, the gh token)',
};

// -> a reason, or null. `st` carries the directory the command is in and the variables paths are built from.
function denyMachinePaths(seg, inv, ctx, st) {
	const { cmd, args, tokens, head } = inv;
	const hits = [];
	let runState = false;
	let runStateDir = false;
	let ancestor = false;
	const writer = FILE_WRITERS.has(cmd);
	// the message of a commit or of PR text is prose, not a path
	const words = writesText(cmd, args) ? stripMessages(cmd, tokens) : tokens;
	let prev = '';
	for (const tok of words) {
		// a bare word is a file name for a command that changes the files it is given, and after a redirection
		const bareOk = writer || tok.includes('>') || /^\d*>>?&?$/.test(prev);
		prev = tok;
		for (const c of candidates(tok, st.vars)) {
			if (!(c.includes('/') || c.startsWith('.') || c.startsWith('~') || bareOk || /[*?[]/.test(c) || /dev-factory/i.test(c))) continue;
			const abs = resolveWord(c, st.cwd);
			if (!abs) continue;
			if (runStatePlace(abs)) runState = true;
			if (runStateRoot(abs)) runStateDir = true;
			let place = protectedPlace(abs, ctx);
			if (!place && abs.startsWith('/') && !/[*?[]/.test(abs)) {
				const real = realPath(abs);
				place = protectedPlace(real, ctx);
				if (!place && runStatePlace(real)) runState = true;
			}
			// the scheduler's own passes keep their state; only a factory agent is kept out of it
			if (place === 'state' && !FACTORY_ROLES.has(ctx.role)) continue;
			if (place) hits.push({ tok, place });
			else if (ancestorOfProtected(abs, ctx)) ancestor = true;
		}
	}
	// credentials are not read either
	const secret = hits.find((h) => h.place === 'secret');
	if (secret) return `${MACHINE_WHY.secret} are not available to a run, not even to read`;
	// the folder that holds run state or the factory's files, removed or moved whole
	if (runStateDir && /^(rm|rmdir|mv|unlink|shred|truncate)$/.test(cmd))
		return 'the folders that hold run state and factory files (.dev-factory, .factory, dev-factory, .claude) are not removed or moved from a run';
	// run state and factory files: changed only through qa.mjs and the scheduler (reading them is fine)
	if (runState && WRITE_LIKE.test(seg) && !qaBin('').test(seg) && !readsOnly(seg, cmd, args))
		return 'factory files and run state are changed only through qa.mjs and the scheduler';
	if (cmd === 'ln' && (hits.length || ancestor || runState || tokens.some((t) => /(^|\/)\.?(dev-factory|factory|claude|git)(\/|$)/i.test(t))))
		return 'a symlink into run state, a repository’s git folder or a machine folder is not made from a run';
	if (!hits.length && !ancestor) return null;
	if (readsOnly(seg, cmd, args)) return null;
	// the home folder or the root, or a folder that holds a protected place: removing, moving, mounting or linking it takes that along
	if (!hits.length && ancestor) {
		if (cmd === 'cd' || cmd === 'pushd') return null;
		if (writer || ['docker', 'podman', 'tar', 'unzip', 'zip', 'ditto', 'xargs', 'find', 'git'].includes(cmd) || /^(rm|mv|chmod|chown)$/.test(cmd))
			return 'the home folder, the root, or a folder that holds the machine state, profiles or credentials cannot be removed, moved, mounted or written into from a run';
		return null;
	}
	// running a script that is part of the installed plugin, or the launcher the installer put in the state folder, is not changing them
	const script = args.find((a) => !a.startsWith('-'));
	if (
		RUNNERS.has(cmd) &&
		script &&
		hits.every((h) => h.tok === script && h.place === 'plugin') &&
		!/>/.test(seg.replace(/\d*>>?\s*\/dev\/null/g, '').replace(/\d*>&\d*-?/g, ''))
	)
		return null;
	const { stateDir } = envOf(ctx);
	const launcher = path.posix.resolve(st.cwd, candidates(head, st.vars)[0] ?? head);
	if (hits.every((h) => h.tok === head) && launcher.toLowerCase() === path.posix.join(stateDir, 'bin', 'dev-factory').toLowerCase()) return null;
	const what = [...new Set(hits.map((h) => MACHINE_WHY[h.place]))].join(' and ');
	return `${what} cannot be changed from a run (it only reads them); this command names it`;
}

// ---- the task tracker's own hosts ----
// Reaching the tracker is the scheduler's alone, by whatever program: curl, node -e, git clone, gh api, python. Commands that
// only print or search text are not reaching anything, and the quoted message of a commit or of PR/issue text may mention a
// tracker's address; a `$(...)` inside it is judged on its own as a command.
const TRACKER_HOSTS = ['atlassian.net', 'api.notion.com', 'notion.so'];
const TEXT_OPTION = /^(--message|--body|--title|--subject|--notes|--description)$/;
const TEXT_ATTACHED = /^(--(message|body|title|subject|notes|description)=|-[mbt].)/;
const hostRegex = (h) => new RegExp(`(^|[^a-z0-9-])${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-]|\\.[a-z0-9])`, 'i');

function writesText(cmd, args) {
	if (cmd === 'git') return ['commit', 'tag', 'notes', 'merge', 'revert', 'stash'].includes(gitParts(args).sub);
	if (cmd === 'gh') {
		const p = ghPositionals(args);
		return (
			['pr', 'issue', 'release', 'gist'].includes(p[0]) &&
			['create', 'edit', 'comment', 'review', 'close', 'reopen', 'merge', 'ready'].includes(p[1])
		);
	}
	return false;
}

// the tokens of a commit or PR/issue text command without the values of its message options
function stripMessages(cmd, tokens) {
	const short = cmd === 'git' ? /^-[A-Za-z]*m$/ : /^-[bt]$/;
	const words = [];
	for (let i = 0; i < tokens.length; i++) {
		if (TEXT_OPTION.test(tokens[i]) || short.test(tokens[i])) i++;
		else if (!TEXT_ATTACHED.test(tokens[i])) words.push(tokens[i]);
	}
	return words;
}

export function hitsTrackerHost(inv, ctx = {}, vars = {}) {
	const { cmd, args, tokens } = inv;
	const hosts = [...TRACKER_HOSTS, ...(ctx.trackerHosts ?? [])]
		.map((h) =>
			String(h)
				.trim()
				.replace(/^[a-z]+:\/\//i, '')
				.replace(/[/:].*$/, ''),
		)
		.filter(Boolean);
	if (readsOnly(tokens.join(' '), cmd, args)) return false; // printing or searching text reaches nothing
	let words = tokens;
	if (writesText(cmd, args)) {
		words = [];
		// git takes its message after -m, also inside a cluster such as -am; gh after -b or -t
		const short = cmd === 'git' ? /^-[A-Za-z]*m$/ : /^-[bt]$/;
		for (let i = 0; i < tokens.length; i++) {
			if (TEXT_OPTION.test(tokens[i]) || short.test(tokens[i])) i++;
			else if (!TEXT_ATTACHED.test(tokens[i])) words.push(tokens[i]);
		}
	}
	const regexes = hosts.map(hostRegex);
	for (const w of words) {
		for (const c of [w, ...candidates(w, vars)]) if (regexes.some((re) => re.test(c))) return true;
	}
	return false;
}

const TAKEOVER_REFUSAL =
	'dev-factory guard: takeover is switched on by the machine owner (DF_TAKEOVER in the environment the scheduler starts with), not by an agent';
const UNJUDGEABLE = (why) => ({ deny: true, reason: `dev-factory guard: this command cannot be judged (${why}); split it into smaller commands` });

// ctx: branch, role, containerOnly, service, noAttribution, takeover, plus for the path rules cwd (the directory the command
// starts in), home, stateDir and env (default: the process's), and trackerHosts (hosts beyond the built-in ones).
export function evaluate(command, ctx = {}) {
	try {
		return judge(String(command ?? ''), ctx);
	} catch (e) {
		// a command that cannot be judged is refused, never let through
		return UNJUDGEABLE(e instanceof Unjudgeable ? e.message : 'the guard failed on it');
	}
}

function judge(command, ctx) {
	if (command.length > LIMITS.command) throw new Unjudgeable(`longer than ${LIMITS.command} characters`);
	const check = budget();
	const readOnly = READ_ONLY_ROLES.has(ctx.role);
	// leading VAR=value words are stripped from each segment, so the identity variables are looked for in the whole command
	if (ctx.noAttribution && IDENTITY_ENV.test(command) && /\bgit\b/.test(command))
		return {
			deny: true,
			reason: 'dev-factory guard: commits are made as the git user of this machine: GIT_AUTHOR_* and GIT_COMMITTER_* are not allowed',
		};
	// variables that make git, the shell or the loader run a program of the agent's choosing
	if (FACTORY_ROLES.has(ctx.role) && PROGRAM_ENV.test(command))
		return {
			deny: true,
			reason: 'dev-factory guard: GIT_SSH_COMMAND, GIT_ASKPASS, GIT_EXTERNAL_DIFF, GIT_CONFIG_*, BASH_ENV, LD_PRELOAD and the like make a program run; a run does not set them',
		};
	// the toggle is the owner's: an agent does not switch it on for itself, however the name is written
	if (FACTORY_ROLES.has(ctx.role) && !ctx.takeover && triesTakeover(command)) return { deny: true, reason: TAKEOVER_REFUSAL };
	const segs = segments(command);
	if (segs.length > LIMITS.segments) throw new Unjudgeable(`more than ${LIMITS.segments} commands`);
	const { home, stateDir } = envOf(ctx);
	const st = { cwd: ctx.cwd || process.cwd(), vars: { HOME: home, DF_STATE_DIR: stateDir, PWD: ctx.cwd || process.cwd() } };
	for (const seg of segs) {
		check();
		const inv = invocation(seg);
		const { cmd, args, tokens } = inv;
		const deny = (why) => ({ deny: true, reason: `dev-factory guard: ${why} [${seg.slice(0, 80)}]` });
		// the message of a commit or of PR text is prose: ".env" or "rm" in it is not a command touching a file
		const prose = writesText(cmd, args);
		const common = denyCommon(
			prose ? stripMessages(cmd, tokens).join(' ') : seg,
			prose ? stripMessages(cmd, tokens) : tokens,
			cmd,
			st.vars,
			ctx.role,
		);
		if (common) return deny(common);
		const machine = denyMachinePaths(seg, inv, ctx, st);
		if (machine) return deny(machine);
		if (cmd === 'cd' || cmd === 'pushd') {
			const target = args.find((a) => !a.startsWith('-'));
			const to = target ? candidates(target, st.vars)[0] : home;
			if (to && !to.includes('$')) {
				st.cwd = path.posix.resolve(st.cwd, to);
				st.vars.PWD = st.cwd;
			}
		}
		if (readOnly) {
			const why = denyForReadOnly(seg, ctx.role === 'debugger' ? DEBUGGER_EXTRA : []);
			if (why) return deny(why);
			continue;
		}
		// the message of a commit or of PR text is prose: a path named in it is not a path the command touches
		const pathText = writesText(cmd, args) ? stripMessages(cmd, tokens).join(' ') : seg;
		const touchesProtected = PROTECTED_BASH.test(pathText);
		if (touchesProtected && WRITE_LIKE.test(pathText) && !qaBin('').test(seg)) {
			return deny('factory files and run state are changed only through qa.mjs and the scheduler');
		}
		if (ctx.role === 'promoter' && WRITE_LIKE.test(seg) && !/^(git|gh|node)\s/.test(seg) && !SENTINEL_SHELL.test(seg)) {
			return deny('a promoter changes files only through the edit tools');
		}
		const body = [cmd, ...args].join(' ');
		let reason = null;
		if (cmd === 'git') reason = denyGit(args, ctx, seg);
		else if (cmd === 'gh') reason = denyGh(args, ctx, seg);
		if (!reason && hitsTrackerHost(inv, ctx, st.vars) && (FACTORY_ROLES.has(ctx.role) || !notionUpload(cmd, args)))
			reason = 'direct task-tracker access is reserved for the scheduler, which sends only QA screenshots to a Notion upload URL';
		if (!reason && FACTORY_ROLES.has(ctx.role) && /^node\s+\S*tasks\.mjs"?\s+(set-state|comment|label|link|block|create|init)\b/.test(seg))
			reason = 'the task tracker is written only by the scheduler, not by a factory agent (tasks.mjs ' + seg.split(/\s+/)[2] + ')';
		// run.json records the role and limits a run is judged by: a factory agent does not rewrite its own
		if (!reason && FACTORY_ROLES.has(ctx.role) && /^node\s+\S*run-context\.mjs"?\s+write\b/.test(seg))
			reason = 'run state is written only by the scheduler, not by a factory agent (run-context.mjs write)';
		if (!reason && /^docker\s+(system|volume|image|builder|network|container)\s+prune/.test(body)) reason = 'docker prune is not allowed';
		if (!reason && FACTORY_ROLES.has(ctx.role)) reason = denyProcessControl(seg, cmd, args, ctx);
		if (
			!reason &&
			ctx.containerOnly &&
			/^(npm\s+(--prefix\s+\S+\s+)?(install|i|ci|test|run\s+test)\b|npx\s+(vitest|jest|playwright\s+test)\b|yarn\s+(--cwd\s+\S+\s+)?(test|jest|vitest)\b|pnpm\s+(install|i|test|run\s+test|jest|vitest)\b)/.test(
				body,
			)
		) {
			reason = `dependencies are installed and tests run inside the ticket's environment container, not on the host (docker compose exec ... ${ctx.service || '<service>'} ...)`;
		}
		if (reason) return deny(reason);
	}
	return { deny: false };
}

// Shell writes to the factory directory (its own QA cases aside), run state, evidence and review records, hook wiring and husky are refused.
const PROTECTED_BASH =
	/\.factory\/tasks\/|\.dev-factory\/(review|qa|evidence|debug)(\/|\s|$)|\.dev-factory\/((run|env|env-sealed|env-prechanged)\.json|(metro|emulator)\.pid)|(^|[\s/'"])dev-factory\/(?!qa\/cases\/)|\.dev-factory\/compose\.override\.yml|(^|[\s/'"])dev-factory\.config\.json|\.claude\/|\.github\/workflows|\.husky\//;
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
// ctx (home, stateDir, env) overrides where the machine's own folders are, for tests.
export function evaluateEdit({ filePath, text = '', root, active = false, run = null, ...ctx }) {
	if (typeof filePath !== 'string' || !filePath) return { deny: false };
	const rel = normalize(filePath, root);
	if ((/^dev-factory\//.test(rel) || (run?.role === 'improver' && run.factoryPrefix === '')) && FORBIDDEN.test(text)) {
		return { deny: true, reason: 'dev-factory guard: this vocabulary is not allowed under dev-factory/ (see scripts/lint-vocabulary.sh)' };
	}
	if (!active) return { deny: false };
	// First, what no run may change whatever its role: judged on the real location, so a symlink inside the worktree that
	// points at one of them is refused too, and in lower case because the volume ignores it.
	const abs = path.posix.resolve(root, filePath);
	const real = realPath(abs);
	const place = protectedPlace(abs, ctx) ?? protectedPlace(real, ctx);
	if (place && !(place === 'state' && !run))
		return { deny: true, reason: `dev-factory guard: ${MACHINE_WHY[place]} cannot be changed from a run (${rel})` };
	// Where the file really is, relative to the worktree's real location: a link inside the worktree that leads to run state is run
	// state, so the whole judgement is made again on the real path.
	const realRoot = realPath(root);
	const relReal = real.startsWith(`${realRoot}/`) ? real.slice(realRoot.length + 1) : real;
	if (relReal !== rel && !relReal.startsWith('/')) {
		const viaLink = evaluateEdit({ filePath: relReal, text, root: realRoot, active, run, ...ctx });
		if (viaLink.deny) return viaLink;
	}
	// run state or a factory file of some other worktree, named by its absolute path
	if (!abs.startsWith(`${root}/`) && runStatePlace(real))
		return { deny: true, reason: `dev-factory guard: ${rel} is run state or a factory file of another worktree` };
	const lowerRel = rel.toLowerCase();
	const name = path.posix.basename(lowerRel);
	if (
		name === 'dev-factory.config.json' ||
		(name === 'dev-factory.qa.yaml' && lowerRel === name) ||
		/(^|\/)\.claude\/settings[^/]*\.json$/.test(lowerRel)
	)
		return {
			deny: true,
			reason: `dev-factory guard: ${rel} sets what the factory allows a run to do; the owner changes it, a run does not`,
		};
	if (SENTINEL.test(rel) && relReal === rel) return { deny: false };
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
		// the factory is a folder of this repository (`dev-factory/`, the default) or the repository itself (factoryPrefix '')
		const prefix = run.factoryPrefix ?? 'dev-factory/';
		const enforcement = new RegExp(
			`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(scripts/(guard-lib|guard-paths|guard-bash|edit-guard|stop-gate|stop-gate-lib|mcp-guard|mcp-guard-lib|scrub-lib|probe-lib|debug-lib|plugin-root)\\.|bin/qa\\.mjs|hooks/|settings\\.factory\\.json|config\\.json|plugins\\.json)`,
		);
		if (enforcement.test(rel))
			return {
				deny: true,
				reason: `dev-factory guard: ${rel} enforces the factory's own limits; changes to it are made by a person, file a task instead`,
			};
		const inside = prefix === '' ? !/^(\.git|\.github|\.claude|\.dev-factory)(\/|$)/.test(rel) : rel.startsWith(prefix);
		if (inside && !rel.includes('..') && !path.isAbsolute(rel)) return { deny: false };
		return { deny: true, reason: `dev-factory guard: an improver changes only the factory${prefix ? ` under ${prefix}` : ''} (got ${rel})` };
	}
	const ownCase = run?.key && (rel.startsWith(`.factory/qa/cases/${run.key}/`) || rel.startsWith(`dev-factory/qa/cases/${run.key}/`));
	// the installed plugin is outside the worktree, in the plugin cache: no ticket edits it by absolute path
	if (/(^|\/)\.claude\/plugins\//i.test(abs)) return { deny: true, reason: 'dev-factory guard: the installed plugin is not edited by a ticket' };
	const protectedPath =
		/^(dev-factory\.config\.json$|\.factory\/(tasks|qa\/cases)\/|dev-factory\/|\.claude\/|\.github\/|\.husky\/|\.dev-factory\/(review|qa|evidence|debug)\/|\.dev-factory\/((run|env|env-sealed|env-prechanged)\.json|(metro|emulator)\.pid)|\.dev-factory\/compose\.override\.yml)/i.test(
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
