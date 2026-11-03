import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countOpen, factoryPrs, mentionsKey } from '../scripts/open-prs.mjs';

const prs = [
	{ number: 1, title: 'Fix the arm button [APP-390]', headRefName: 'bug/APP-390-fix-arm' },
	{ number: 2, title: 'Rework billing [APP-3901]', headRefName: 'task/APP-3901-billing' },
	{ number: 3, title: 'My own side project', headRefName: 'feature/side-project' },
	{ number: 4, title: 'No key in the title', headRefName: 'task/APP-12-from-the-branch' },
	{ number: 5, title: 'Dependabot bump', headRefName: 'dependabot/npm/x' },
];

test('a key matches as a whole word: APP-390 is not in APP-3901, and 12 is not in APP-12', () => {
	assert.equal(mentionsKey('Fix [APP-390]', 'APP-390'), true);
	assert.equal(mentionsKey('Fix [APP-3901]', 'APP-390'), false);
	assert.equal(mentionsKey('XAPP-390', 'APP-390'), false);
	assert.equal(mentionsKey('task/APP-390-slug', 'APP-390'), true);
	assert.equal(mentionsKey('task/APP-12-slug', '12'), false);
	assert.equal(mentionsKey('Fix #12 now', '12'), true);
	assert.equal(mentionsKey('anything', ''), false);
	assert.equal(mentionsKey(null, 'APP-1'), false);
	assert.equal(mentionsKey('A.B-1', 'A.B-1'), true, 'a key is matched literally');
	assert.equal(mentionsKey('AxB-1', 'A.B-1'), false);
});

test('only the factory’s PRs count: those that carry the key of an in-flight ticket in the title or the branch', () => {
	assert.deepEqual(
		factoryPrs(prs, ['APP-390', 'APP-12']).map((p) => p.number),
		[1, 4],
	);
	assert.deepEqual(factoryPrs(prs, []), []);
});

test('the count comes from tickets in progress or in review, and the person’s own PRs are left out', async () => {
	const asked = [];
	const r = await countOpen({
		list: async ({ states }) => (
			asked.push(states[0]), states[0] === 'inProgress' ? [{ key: 'APP-390' }] : [{ key: 'APP-12' }, { key: 'APP-390' }]
		),
		prs: async () => prs,
	});
	assert.deepEqual(asked, ['inProgress', 'inReview']);
	assert.deepEqual(r, { open: 2, keys: [1, 4], inFlight: 2 });
});

test('a failure is an error, not a zero: unknown never claims', async () => {
	await assert.rejects(
		countOpen({
			list: async () => [],
			prs: async () => {
				throw new Error('gh: not logged in');
			},
		}),
		/not logged in/,
	);
	const { spawnSync } = await import('node:child_process');
	const r = spawnSync(process.execPath, [new URL('../scripts/open-prs.mjs', import.meta.url).pathname], {
		encoding: 'utf8',
		env: { ...process.env, PATH: '/nonexistent', DF_TASK_SOURCE: 'github', DF_GITHUB_REPO: 'o/r' },
		cwd: '/tmp',
	});
	assert.equal(r.status, 21);
	assert.equal(JSON.parse(r.stdout).open, 'unknown');
});
