import assert from 'node:assert/strict';
import fs from 'node:fs';
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

// The interactive build used to leave the ticket where it was ("the scheduled pass owns transitions"), so the board showed work in progress as To Do.
test('the interactive build moves the Jira ticket through the workflow like the scheduled pass does', () => {
	const build = read('build.md');
	assert.doesNotMatch(build, /do not transition the jira issue/i);
	assert.match(build, /jira\.statuses\.inProgress/, 'claims the ticket into In Progress');
	assert.match(build, /jira\.statuses\.peerReview/, 'moves it to Peer review once the PR is open');
	assert.match(build, /tick\.md.*section 6|section 6.*tick\.md/s, 'a blocked build follows the same blocked path as a scheduled pass');
});
