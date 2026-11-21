import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const read = (f) => fs.readFileSync(new URL(`../commands/${f}`, import.meta.url), 'utf8');
const FILES = ['build.md', 'quick.md', 'tick.md'];
const spans = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

// A worktree cut from a base that lacks the plugin has no dev-factory/ folder, so a command run from inside it cannot find the scripts.
test('no command tells the session to cd into the worktree', () => {
	for (const f of FILES) assert.doesNotMatch(read(f), /change into (the worktree|it)\b|\bcd <worktree>/i, f);
});

test('every worktree-scoped script call names its worktree instead of relying on the current directory', () => {
	const scoped = /e2e-env\.sh (up|down|verify)\b|qa\.mjs (verify|mark-na|start|review status|debug status)\b/;
	for (const f of FILES) {
		for (const span of spans(read(f)).filter((s) => /^(node|bash) /.test(s) && scoped.test(s)))
			assert.match(span, /--worktree /, `${f}: ${span}`);
	}
});

// The interactive build used to leave the task where it was ("the scheduled pass owns transitions"), so the board showed work in progress as ready.
test('the interactive build moves the task through the workflow like the scheduled pass does', () => {
	const build = read('build.md');
	assert.doesNotMatch(build, /do not transition the (jira )?(issue|task)/i);
	assert.match(build, /SET it `inProgress`/, 'claims the task');
	assert.match(build, /SET it `inReview`/, 'moves it to review once the PR is open');
	assert.match(build, /tick\.md.*section 6|section 6.*tick\.md/s, 'a blocked build follows the same blocked path as a scheduled pass');
});

test('no command or skill assumes a particular tracker, organisation or host', () => {
	const dirs = ['commands', 'skills', 'agents'];
	const files = dirs.flatMap((d) =>
		fs
			.readdirSync(new URL(`../${d}/`, import.meta.url), { recursive: true, withFileTypes: true })
			.filter((e) => e.isFile() && e.name.endsWith('.md'))
			.map((e) => path.join(e.parentPath ?? e.path, e.name)),
	);
	assert.ok(files.length > 20);
	for (const f of files) {
		const text = fs.readFileSync(f, 'utf8');
		assert.doesNotMatch(text, /olarm|atlassian\.net\/browse|PLAT-000|OAPP|jira\.statuses|jira\.label|jira\.projects/i, f);
		// Jira may be named only by the commands that say how each source differs, and by the Jira source file
		if (!/task-source|setup\.md|plan\.md|tick\.md|improve|ship|validate|status\.md/.test(f)) assert.doesNotMatch(text, /\bJira\b/, f);
	}
});

test('every command that touches tasks points at the task-source skill instead of a tracker', () => {
	for (const f of ['tick.md', 'build.md', 'plan.md', 'status.md', 'improve.md']) assert.match(read(f), /task-source/, f);
});

test('plan sizes the work from a quick change to an initiative and keeps blockers in the description', () => {
	const plan = read('plan.md');
	for (const word of ['Quick change', 'Single task', 'Feature', 'Initiative', 'Blocked by:']) assert.match(plan, new RegExp(word), word);
});

test('every run that starts an environment ends with the clean-up script, whatever the outcome', () => {
	for (const f of ['tick.md', 'build.md', 'quick.md']) assert.match(read(f), /scripts\/cleanup\.mjs" --worktree <worktree>/, f);
});

// Settings live in layers the factory writes through the settings page; a command that wrote the files itself would skip the checks
// (a required server cannot be off, a secret goes to .env.local only) and the sync that makes Claude match.
test('setup.md names settings set, mcp sync and plugins sync and never .mcp.json as something to write', () => {
	const setup = read('setup.md');
	for (const needle of [
		'scripts/settings.mjs" set',
		'set secret:',
		'scripts/mcp.mjs" sync',
		'scripts/plugins.mjs" sync',
		'scripts/project-dir.mjs" migrate',
		'defaultScope',
		'claude plugin install dev-factory@dev-factory --scope user',
		'all projects',
		'this project',
	])
		assert.ok(setup.includes(needle), needle);
	for (const line of setup.split('\n').filter((l) => l.includes('.mcp.json')))
		assert.match(line, /never|legacy|do not|not copied|not a/i, `${line}: .mcp.json is something to read, not to write`);
	assert.doesNotMatch(setup, /mcp\.mjs" (enable|connect)/, 'servers are chosen through the settings page, one scope each');
});

test('a secret reaches .env.local through standard input and never through the conversation or the command line', () => {
	const setup = read('setup.md');
	assert.match(setup, /standard input/);
	assert.match(setup, /never (echo|print|write)[^.]*\b(value|secret)/i);
	assert.match(setup, /`!`/, 'a value the person would otherwise type into the conversation is run by them with !');
});

test('setup.md tells a routine what it cannot have, and every settings command in it is a whole command', () => {
	const setup = read('setup.md');
	assert.match(setup, /carries only the project layer/);
	assert.match(setup, /`jira` server[^.]*launcher[^.]*routine/);
	assert.match(setup, /claude\.ai Atlassian connector/);
	assert.match(setup, /used by the routine/);
	for (const span of spans(setup).filter((s) => /settings\.mjs/.test(s)))
		assert.match(
			span,
			/^(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/settings\.mjs"|! pbpaste \| node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/settings\.mjs")/,
			span,
		);
});

test('the Jira server choice is asked only for a Jira task source, and the two servers are named', () => {
	const setup = read('setup.md');
	assert.match(setup, /tasks\.source[^.\n]*jira[^\n]*`jira`[^\n]*`atlassian`/i);
});

// A repository's settings moved to .devfactory/config.json; the old file is read for one release, so a line may name it only to say so.
test('no command, skill or agent points at the old settings files except to call them legacy', () => {
	const files = ['commands', 'skills', 'agents'].flatMap((d) =>
		fs
			.readdirSync(new URL(`../${d}/`, import.meta.url), { recursive: true, withFileTypes: true })
			.filter((e) => e.isFile() && e.name.endsWith('.md'))
			.map((e) => path.join(e.parentPath ?? e.path, e.name)),
	);
	for (const f of files)
		for (const line of fs
			.readFileSync(f, 'utf8')
			.split('\n')
			.filter((l) => /dev-factory\.(config\.json|qa\.yaml)/.test(l)))
			assert.match(line, /legacy|old location|migrate/i, `${f}: ${line.slice(0, 120)}`);
});

// The scheduler is the only thing that may merge, and only through automerge.mjs; if the tick stopped calling it, or the reference stopped
// describing it, a person who turned `autoMerge.enabled` on would get nothing, or would not know what it does.
test('the tick runs auto-merge only when it is on, and the reference documents the section and every autoMerge setting', () => {
	const tick = read('tick.md');
	assert.ok(tick.includes('scripts/automerge.mjs" run'), 'the tick runs the auto-merge script');
	assert.ok(tick.includes('get autoMerge.enabled'), 'the tick reads the master switch first');
	const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
	const reference = fs.readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
	assert.match(reference, /^### Auto-merge$/m);
	// the section only, up to the next heading of its level, so a mention elsewhere does not count
	const from = reference.indexOf('\n### Auto-merge\n');
	const section = reference.slice(from + 1, reference.indexOf('\n### ', from + 1) === -1 ? undefined : reference.indexOf('\n### ', from + 1));
	for (const key of Object.keys(config.autoMerge)) {
		assert.ok(section.includes(`autoMerge.${key}`), `the Auto-merge section names autoMerge.${key}`);
		assert.match(reference, new RegExp(`^\\|\\s*\`autoMerge\\.${key}\`\\s*\\|`, 'm'), `the Pull requests table has a row for autoMerge.${key}`);
	}
	assert.match(fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /scripts\/automerge\.mjs/, 'the README names the script');
});

// A task is `reviewed` as soon as its PR is approved, which can be a pass before the PR can merge; the tick must still offer it to the script.
test('the auto-merge step also considers reviewed tasks whose PR is still open', () => {
	const tick = read('tick.md');
	const start = tick.indexOf('-   Auto-merge:');
	const end = tick.indexOf('-   Reviewed:');
	assert.ok(start !== -1 && end > start, 'the Auto-merge bullet sits before the Reviewed bullet');
	const bullet = tick.slice(start, end);
	assert.match(bullet, /`reviewed`/, 'the bullet names reviewed tasks');
	assert.match(bullet, /still OPEN/, 'only while the PR is open');
	assert.match(bullet, /do not move it back/i, 'the task keeps its state');
});

// The command runs outside the sandbox, so no text a person or a tracker supplies is pasted into it: the labels go through a file the
// tick writes, and the readied head is the script's own record, never read from a comment.
test('the auto-merge step passes labels in a file and nothing taken from a comment', () => {
	const tick = read('tick.md');
	const bullet = tick.slice(tick.indexOf('-   Auto-merge:'), tick.indexOf('-   Reviewed:'));
	assert.match(bullet, /--labels-file <file>/);
	assert.match(bullet, /Write tool/);
	assert.doesNotMatch(bullet, /--readied-head|--labels </);
	assert.match(bullet, /blocker/i, 'the stacked wait is described');
	assert.match(bullet, /Never run `gh pr merge` or `gh pr ready` yourself/);
	const reference = fs.readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
	for (const text of [tick, reference]) assert.doesNotMatch(text, /--readied-head|automerge\.mjs" run [^\n]*--labels </);
	assert.match(reference, /--labels-file <file>/);
});

// The gate refuses a premature build.done, but the scheduler's wait loop sees files: a loop that took the file's existence as the
// hand-off sent a ticket to review while the builder was still told to work. Every wait treats build.done as done only once
// `qa.mjs build-ready` (the gate's own check) agrees, and a block wins over a hand-off.
test('every build wait counts build.done only when qa.mjs build-ready agrees, and a block wins', () => {
	const READY = 'bin/qa.mjs" build-ready --worktree <worktree>';
	const tick = read('tick.md');
	const step5 = tick.slice(tick.indexOf('5. Build:'), tick.indexOf('6. Review, two steps'));
	const loop = step5.slice(step5.indexOf('```bash'), step5.indexOf('```', step5.indexOf('```bash') + 7));
	assert.ok(loop.includes(READY), 'the build wait runs build-ready');
	assert.doesNotMatch(loop, /until \[ -f \$W\/build\.done \] \|\|/, 'the file alone does not end the wait');
	assert.ok(loop.indexOf('blocked.json') < loop.indexOf('build.done'), 'blocked.json is looked at first');
	assert.match(loop, /needs_debug\.json/);
	assert.match(step5, /`blocked\.json` wins/);
	const fix = tick.slice(tick.indexOf('4. Fix step:'), tick.indexOf('7. Ship:'));
	assert.match(fix, /build-ready/, 'the fix-round wait is the same loop');
	for (const f of ['build.md', 'quick.md']) {
		const text = read(f);
		assert.ok(text.includes(READY), `${f} waits with build-ready`);
		assert.doesNotMatch(text, /Wait for `\.dev-factory\/build\.done` or `blocked\.json`/, f);
	}
	for (const f of ['../agents/factory-builder.md', '../skills/qa/SKILL.md'])
		assert.match(
			fs.readFileSync(new URL(f, import.meta.url), 'utf8'),
			/build-ready/,
			`${f} tells the builder to check before writing build.done`,
		);
});

// Neither block is a question an agent could answer: a person decides, so neither goes to the researcher.
test('a block the stop gate wrote and a spent QA fix budget are factory blocks, never settled by an agent', () => {
	const tick = read('tick.md');
	const section6 = tick.slice(tick.indexOf('## 6. Blocked path'), tick.indexOf('## 7. Exit'));
	const exclusions = section6.slice(0, section6.indexOf('settle it instead of blocking'));
	for (const kind of ['the stop gate let the run go', 'QA fix budget spent']) {
		assert.ok(exclusions.includes(kind), `${kind} is excluded from blocked.agentDecides`);
		assert.match(section6, new RegExp(`${kind}[^\\n]*--kind factory|--kind factory[^\\n]*${kind}`), `${kind} is a factory block`);
	}
});

// The stop gate judges an agent by the role run.json names, and lets go an agent of any other role: a dispatch that leaves the
// previous role in place would leave the agent with no finish line at all. So each dispatch writes the role of the agent it sends.
test('the ship-phase dispatch of an interactive build or quick change writes role builder with until ship', () => {
	assert.match(read('build.md'), /5c\. Write `role` `builder`, `until` `ship`, dispatch the builder for the ship phase/);
	assert.match(read('quick.md'), /5\. Write `role` `builder`, `until` `ship` and dispatch the builder for the ship phase/);
});

test('the interactive build sets role debugger before it dispatches the debugger to unstick the builder', () => {
	assert.match(
		read('build.md'),
		/`needs_debug\.json`, set `role` `debugger` and `debugBefore` in run\.json, dispatch the debugger with trigger `unstick`/,
	);
});

test('the interactive unstick sets role back to builder and clears the stale needs_debug.json and build.done before it re-dispatches the builder', () => {
	assert.match(
		read('build.md'),
		/dispatch the debugger with trigger `unstick`, wait for a recorded round in `\.dev-factory\/debug\/` or `blocked\.json`, then delete `needs_debug\.json` and `build\.done`, set `role` back to `builder` and re-dispatch the builder/,
	);
});

test('the promoter fix round sets role promoter and clears the stale promote.done before it re-dispatches the promoter', () => {
	assert.match(
		read('improve.md'),
		/before each re-dispatch of the promoter, rewrite `role` `promoter` in run\.json[^\n]*? and delete `promote\.done`/,
	);
});

test('the improve fix round sets role improver and clears the stale improve.done before it re-dispatches the improver', () => {
	assert.match(
		read('improve.md'),
		/before each re-dispatch of the improver, rewrite `role` `improver` in run\.json[^\n]*? and delete `improve\.done`/,
	);
});

// A wiki token can arrive as literal text through an MCP server that renders HTML, so the tick points a session at the HTML form there and
// keeps the ADF and token forms for the token server. It names the condition (a comment tool that takes HTML), never claims what a product accepts.
test('the tick composes a question with real mentions for an MCP server that takes HTML, and keeps compose-adf for the token server', () => {
	const tick = read('tick.md');
	const line = tick.split('\n').find((l) => l.includes('compose --kind question|factory'));
	assert.ok(line, 'the compose line');
	assert.ok(line.includes('compose --format html'), 'the HTML form');
	assert.match(line, /--assignee-id <id> --assignee-name <name> --reporter-id <id> --reporter-name <name>/);
	assert.match(line, /contentFormat/);
	assert.ok(line.includes('compose-adf'), 'the token server keeps compose-adf');
	assert.match(line, /MCP server whose comment tool takes HTML/);
	assert.doesNotMatch(line, /accepts only|takes only|only accepts|only takes/i, 'no claim about what a named product accepts');
	assert.match(fs.readFileSync(new URL('../skills/task-source/jira.md', import.meta.url), 'utf8'), /compose --format html/);
	assert.match(fs.readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8'), /compose --format html/);
});

// Whether the tracker's server turns a mention element into a real mention is the server's doing, so no document says it always does.
test('no document claims a mention element always notifies', () => {
	for (const f of ['commands/tick.md', 'skills/task-source/jira.md', 'docs/reference.md', 'scripts/comment-lib.mjs'])
		assert.doesNotMatch(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /mention element always notifies/i, f);
	assert.ok(
		fs
			.readFileSync(new URL('../skills/task-source/jira.md', import.meta.url), 'utf8')
			.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/comment.mjs" compose --format html'),
		'jira.md writes the command with the plugin-root prefix',
	);
});

// Direct ports publish nothing and take no machine-wide lock, so they are what lets web tickets overlap; a failed direct start must not fall back to
// canonical, because that would take the lock the direct mode exists to avoid.
test('the tick asks for direct ports only for a web ticket when more than one task may run, and never falls back to canonical', () => {
	const step = read('tick.md')
		.split('\n')
		.find((l) => l.startsWith('3. Environment:'));
	assert.ok(step, 'the Environment step');
	assert.ok(step.includes('--ports direct'), 'names --ports direct');
	assert.ok(step.includes('caps.maxConcurrent'), 'ties the choice to caps.maxConcurrent');
	assert.match(step, /--ports canonical/, 'canonical stays for the maxConcurrent 1 case');
	assert.match(step, /--device/, 'mobile keeps --device');
	assert.match(step, /no fallback/, 'a failed direct start has no fallback');
	assert.match(step, /above 1 and `environment\.webBaseUrl` is set/, 'direct only when there is an address to swap the host of');
	assert.match(step, /`--ports none`, as there is no host address to open/, 'otherwise the default');
	assert.match(step, /exit 1, for example because the address did not answer/, 'the cause is worded neutrally');
	assert.match(step, /Environments section of `docs\/reference\.md`/, 'points at what is not settled');
});

// A factory agent is dispatched by a session whose hook events carry the scheduler's directory, so the hook learns which run an agent
// belongs to only from the agent's first command, which names its worktree. Until that command has run every other tool call is refused.
test("every factory agent's instructions start with the bind command", () => {
	const dir = new URL('../agents/', import.meta.url);
	const agents = fs.readdirSync(dir).filter((f) => /^factory-.*\.md$/.test(f));
	assert.equal(agents.length, 6, 'six factory agents');
	for (const f of agents) {
		const text = fs.readFileSync(new URL(f, dir), 'utf8');
		const tools = text.match(/^tools: (.*)$/m)?.[1] ?? '';
		const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
		const phases = body.search(/^(\d+\.|#{1,6}) /m);
		if (f === 'factory-researcher.md') {
			assert.doesNotMatch(tools, /\bBash\b/, 'the researcher has no shell');
			assert.ok(!body.includes('run-context.mjs" bind'), 'the researcher is not told to run a bind command');
			const first = body.indexOf('first file write');
			assert.ok(first >= 0, 'the researcher is told its first file write binds it');
			const near = body.slice(Math.max(0, first - 300), first + 500);
			assert.match(near, /absolute path/, 'and that the path is absolute');
			assert.match(near, /docs\/plans\/<KEY>\/research\.md/, 'inside its worktree');
			assert.match(near, /refused/, 'and what happens otherwise');
			assert.match(body, /first write is refused with a reason[^.]*stop at once and quote/, 'and what to do when the first write is refused');
			assert.doesNotMatch(body, /shell starts/, 'and does not talk about a shell it has not got');
			if (phases >= 0) assert.ok(first < phases, 'before anything else');
			continue;
		}
		// the bind command is a shell command, so an agent without the Bash tool could not run it
		assert.match(tools, /\bBash\b/, `${f} has the Bash tool the bind command needs`);
		const bind = body.indexOf('run-context.mjs" bind --worktree');
		assert.ok(bind >= 0, `${f} names the bind command`);
		assert.match(body.slice(bind - 200, bind + 400), /first command/, `${f} says it is the first command`);
		// before the phases: no numbered step, heading or other plugin script comes earlier
		if (phases >= 0) assert.ok(bind < phases, `${f}: the bind command comes before the phases`);
		const other = body.search(/\$\{CLAUDE_PLUGIN_ROOT\}\/(?!scripts\/run-context\.mjs)/);
		if (other >= 0) assert.ok(bind < other, `${f}: the bind command comes before any other command`);
		assert.match(body, /every other tool call the hooks guard \([^)]*\) is refused/, `${f} says what happens until it has run`);
		assert.match(body, /bind command itself is refused[^.]*stop at once and quote the refusal/, `${f} says what to do when the bind is refused`);
		assert.match(body, /refusal after you have bound means your stage is over/, `${f} says what a later refusal means`);
		assert.match(body, /<the absolute worktree path the prompt names>/, `${f} takes the path from the prompt`);
	}
});

// A dispatch site is a sentence that tells the session to dispatch (or re-dispatch) a factory agent: "dispatch the `factory-x` agent ...",
// "dispatch the builder ...", "dispatching `factory-reviewer` ...". The agent binds itself to the worktree its prompt names, so each such
// sentence (from the verb to the next full stop or line end) must say the prompt gives the absolute worktree path. A noun ("one dispatch of
// the researcher") is not a site.
const DISPATCH_FILES = ['tick.md', 'build.md', 'quick.md', 'improve.md', 'validate.md'];
const AGENT =
	'(?:`factory-(?:builder|reviewer|debugger|researcher|improver|promoter)`|the (?:builder|debugger|reviewer|researcher|improver|promoter)\\b)';
export function dispatchSites(text) {
	const re = new RegExp(`\\b(?:re-)?dispatch(?:ing|es)?\\b(?! of)[^.\\n]{0,80}?${AGENT}`, 'gi');
	return [...text.matchAll(re)].map((m) => text.slice(m.index).split(/\.\s|\n/)[0]);
}

test('every dispatch site names the worktree to the agent, and the tick says once how the binding works', () => {
	let seen = 0;
	for (const f of DISPATCH_FILES) {
		const sites = dispatchSites(read(f));
		assert.ok(sites.length > 0, `${f} has a dispatch site`);
		for (const site of sites) {
			seen++;
			assert.match(site, /absolute worktree path/, `${f}: ${site.slice(0, 140)}`);
		}
		assert.match(read(f), /run-context\.mjs/, `${f} writes role with run-context.mjs before a dispatch`);
	}
	assert.ok(seen >= 20, `the rule found the dispatch sites (${seen})`);
	const tick = read('tick.md');
	assert.match(tick, /binds itself first/, 'tick.md section 4 says the agent binds itself first');
	assert.match(tick, /clears the previous agent's binding/, 'tick.md says why every dispatch writes role, even unchanged');
	assert.match(tick, /even when `role` is the same as the dispatch before/, 'and that it does so when the role is unchanged');
});

test('the dispatch-site rule catches a dispatch that leaves the path out', () => {
	assert.equal(dispatchSites('Dispatch the `factory-builder` agent with the key and the branch. Next.').length, 1);
	assert.doesNotMatch(dispatchSites('Dispatch the `factory-builder` agent with the key and the branch. Next.')[0], /absolute worktree path/);
	assert.equal(dispatchSites('gets one dispatch of the `factory-researcher` agent first').length, 0);
});

// The hooks keep no pointer to the run any more, so a command that sets one has nothing to do and the prose around it would mislead.
test('no command sets the retired run pointer', () => {
	for (const f of ['tick.md', 'build.md', 'quick.md', 'improve.md', 'validate.md'])
		assert.doesNotMatch(read(f), /run-context\.mjs" set\b|active-run|run pointer|that pointer/, f);
});

// Two agents can be bound at once, so a tool an agent runs cannot fall back to "the only live binding": it names its worktree.
// The rule, by how invocations are written in agents/*.md, skills/*/SKILL.md and commands/*.md. An invocation is the text from
// `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs"` or `node "${CLAUDE_PLUGIN_ROOT}/scripts/coverage.mjs"` up to the end of that command (the end
// of the code span or line, or the next `&&`, `||`, `;`, `|` or `>`), wherever it stands (inline code, a fenced block, a loop body); or a
// whole inline code span that starts with the shorthand `qa.mjs <word>` / `coverage.mjs <word>` and carries a `--flag`. An invocation that
// reads a tree must contain `--worktree `: every `coverage.mjs` command, and each `qa.mjs` sub-command in READS_TREE of bin/qa.mjs (the
// one list the tool itself uses to decide whether to resolve a tree). `qa.mjs scrub` and `qa.mjs ticket ...` read a file they are given,
// need no worktree and are exempt. Not invocations: the bare tool name (`qa.mjs`, `bin/qa.mjs`) and a bare sub-command named in prose
// (`qa.mjs verify`, `qa.mjs review status`), which carry no arguments; prose that only mentions the tool has no code span at all.
test('no qa.mjs or coverage.mjs invocation that reads a tree lacks --worktree', () => {
	const root = new URL('../', import.meta.url);
	const list = fs.readFileSync(new URL('bin/qa.mjs', root), 'utf8').match(/const READS_TREE = new Set\(\[([^\]]+)\]\)/)?.[1] ?? '';
	const readsTree = new Set([...list.matchAll(/'([\w-]+)'/g)].map((m) => m[1]));
	assert.ok(readsTree.has('verify') && readsTree.has('debug') && !readsTree.has('scrub') && !readsTree.has('ticket'), 'READS_TREE found');
	const md = (dir, keep = () => true) =>
		fs
			.readdirSync(new URL(`${dir}/`, root), { recursive: true })
			.filter((f) => f.endsWith('.md') && keep(f))
			.map((f) => `${dir}/${f}`);
	const files = [...md('agents'), ...md('skills', (f) => f.endsWith('SKILL.md')), ...md('commands')];
	const full = /node "\$\{CLAUDE_PLUGIN_ROOT\}\/(bin\/qa|scripts\/coverage)\.mjs" ([a-z][\w-]*)([^\n]*)/g;
	const short = /^(qa|coverage)\.mjs ([a-z][\w-]*)(.*)$/;
	const check = (where, tool, sub, args) => {
		const needs = tool === 'coverage' || readsTree.has(sub);
		return needs ? (/--worktree /.test(args) ? 'ok' : `${where}: ${tool}.mjs ${sub}${args}`) : 'exempt';
	};
	let seen = 0;
	for (const f of files) {
		const text = fs.readFileSync(new URL(f, root), 'utf8');
		const pieces = [];
		for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g)) pieces.push(...(m[1] !== undefined ? m[1].split('\n') : [m[2]]));
		for (const p of pieces) {
			for (const m of p.matchAll(full)) {
				const args = m[3].split(/&&|\|\||;|\||\s>|\d>/)[0];
				const verdict = check(f, m[1].replace(/^.*\//, ''), m[2], args);
				if (verdict !== 'exempt') seen++;
				assert.ok(verdict === 'ok' || verdict === 'exempt', verdict);
			}
			const sh = short.exec(p.trim());
			if (sh && /--[a-z]/.test(sh[3])) {
				const verdict = check(f, sh[1], sh[2], sh[3]);
				if (verdict !== 'exempt') seen++;
				assert.ok(verdict === 'ok' || verdict === 'exempt', verdict);
			}
		}
	}
	assert.ok(seen > 30, `the rule found the invocations (${seen})`);
});
