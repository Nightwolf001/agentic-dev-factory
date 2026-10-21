import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const dir = new URL('../agents/', import.meta.url);
const agents = fs.readdirSync(dir).filter((f) => /^factory-.*\.md$/.test(f));

test('every factory agent is told that its shell starts outside the worktree and where its hand-off files go', () => {
	assert.ok(agents.length >= 6);
	for (const f of agents) {
		const text = fs.readFileSync(new URL(f, dir), 'utf8');
		assert.match(text, /shell starts in the scheduler's directory, not the worktree/, `${f}: says where the shell starts`);
		assert.match(text, /a `cd` does not carry from one call to the next/, `${f}: says cd does not persist`);
		// the reviewer records through qa.mjs and writes no hand-off file of its own
		if (f !== 'factory-reviewer.md') assert.match(text, /`<worktree>\/(\.dev-factory|docs)\//, `${f}: names the absolute hand-off path`);
	}
});
