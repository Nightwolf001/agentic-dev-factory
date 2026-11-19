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
