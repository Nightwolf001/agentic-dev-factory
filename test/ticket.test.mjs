import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintTicket } from '../scripts/ticket-lib.mjs';

const full = `## Summary
Do the thing.

## Acceptance criteria
- Given a user with no devices, the list shows the empty state
- The empty state has a testID

## Out of scope
- Redesign of the list

## Testing decisions
- First red test: render the screen with an empty list
`;

test('a complete ticket passes lenient and strict lint', () => {
	assert.deepEqual(lintTicket(full), []);
	assert.deepEqual(lintTicket(full, { strict: true }), []);
});

test('missing acceptance criteria is the claim blocker', () => {
	assert.match(lintTicket('## Summary\nDo the thing.')[0], /needs acceptance criteria/);
	assert.match(lintTicket('## Acceptance criteria\n\n## Out of scope\n- x')[0], /needs acceptance criteria/);
});

test('jira style headings and bold labels are understood', () => {
	assert.deepEqual(lintTicket('h2. Acceptance Criteria\n* The toast shows in Italian\n'), []);
	assert.deepEqual(lintTicket('**Acceptance criteria**\n1. The toast shows in Italian\n'), []);
	assert.deepEqual(lintTicket('Acceptance criteria:\n- The toast shows in Italian\n'), []);
});

test('strict lint also wants scope limits and a testing decision', () => {
	const p = lintTicket('## Acceptance criteria\n- The toast shows in Italian\n', { strict: true });
	assert.equal(p.length, 2);
});

test('items after another heading do not count as criteria', () => {
	assert.equal(lintTicket('## Acceptance criteria\n## Notes\n- not a criterion here at all\n').length, 1);
});
