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
