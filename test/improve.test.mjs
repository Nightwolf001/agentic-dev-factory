import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { QaError, learningsCheck } from '../bin/qa.mjs';
import { entriesFromPrs, learningRequired, lintLearnings, preload, promotionCandidates } from '../scripts/learnings-lib.mjs';
import { checkPromotion } from '../scripts/promote-lib.mjs';
import * as debugLib from '../scripts/debug-lib.mjs';
import { append, buildTicketRecord, clusters, readRuns } from '../scripts/run-record.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'df-imp-'));
const wt = (run) => {
	const root = tmp();
	fs.mkdirSync(path.join(root, '.dev-factory/review'), { recursive: true });
	fs.writeFileSync(path.join(root, '.dev-factory/run.json'), JSON.stringify(run));
	return root;
};
const review = (root, head, axis, counts) =>
	fs.writeFileSync(
		path.join(root, `.dev-factory/review/${head}-${axis}.json`),
		JSON.stringify({ axis, head, counts: { critical: 0, high: 0, medium: 0, low: 0, ...counts } }),
	);

const GOOD = `## Learnings
- A retry loop that keeps the connection open exhausts the api pool under load.
  scope: services/api
- Fixtures use invented device serials, never ones from production telemetry.
  scope: .
`;

test('learnings lint wants short scoped entries', () => {
	assert.deepEqual(lintLearnings(GOOD), []);
	assert.match(lintLearnings('- a lesson that is long enough to count\n')[0], /missing the indented "scope:"/);
	assert.match(lintLearnings('just prose')[0], /no entries/);
	assert.match(lintLearnings('- too short\n  scope: .\n').join(), /at least 20/);
	assert.match(lintLearnings(`- ${'x'.repeat(301)}\n  scope: .\n`).join(), /cap is 300/);
	assert.match(lintLearnings('- a lesson that is long enough to count\n  scope: ../etc\n').join(), /relative path prefix/);
	const four = Array.from({ length: 4 }, (_, i) => `- lesson number ${i} is long enough here\n  scope: .`).join('\n');
	assert.match(lintLearnings(four).join(), /at most 3/);
	assert.equal(learningRequired({ debugRounds: 1 }) !== null, true);
	assert.equal(learningRequired({ reviewCounts: [{ high: 1 }] }) !== null, true);
	assert.equal(learningRequired({ reviewCounts: [{ medium: 3 }] }), null);
});

test('learnings are required after a debug round or a High finding, validated, and must reach the PR body', () => {
	const root = wt({ key: 'APP-7' });
	assert.equal(learningsCheck({ root, key: 'APP-7' }).required, false);
	review(root, 'a1', 'spec', { high: 1 });
	assert.throws(
		() => learningsCheck({ root, key: 'APP-7' }),
		(e) => e instanceof QaError && /is required because a review round/.test(e.message),
	);
	const f = path.join(root, '.dev-factory/learnings.md');
	fs.writeFileSync(f, '- only a lesson without scope here\n');
	assert.throws(() => learningsCheck({ root, key: 'APP-7' }), /missing the indented "scope:"/);
	fs.writeFileSync(f, GOOD);
	assert.equal(learningsCheck({ root, key: 'APP-7' }).ok, true);
	const body = path.join(root, 'body.md');
	fs.writeFileSync(body, '## Description\nx\n');
	assert.throws(() => learningsCheck({ root, key: 'APP-7', bodyFile: body }), /PR body does not carry/);
	fs.writeFileSync(body, '## Description\nx\n\n' + GOOD);
	assert.equal(learningsCheck({ root, key: 'APP-7', bodyFile: body }).ok, true);
	fs.writeFileSync(f, '- user a@b.co hit the pool exhaustion bug\n  scope: .\n');
	assert.throws(() => learningsCheck({ root, key: 'APP-7' }), /raw data/);
});

test("merged PR bodies yield entries, candidates need two tickets or a person's promote comment", () => {
	const body = (t, scope = 'services/api') => `## Description\nx\n\n## Learnings\n- ${t}\n  scope: ${scope}\n\n## Deployment\nnone\n`;
	const prs = [
		{
			title: 'Fix: pool [APP-1]',
			body: body('Release the connection before the retry loop sleeps in the api pool'),
			mergedAt: '2026-10-01',
			comments: [],
		},
		{
			title: 'Fix: pool again [APP-2]',
			body: body('The api pool is exhausted when the retry loop keeps its connection open', 'services/api/lib'),
			mergedAt: '2026-10-05',
			comments: [],
		},
		{
			title: 'Feat: other [APP-3]',
			body: body('Mobile locale files need the Italian plural keys added together', 'clients/mobile'),
			mergedAt: '2026-10-06',
			comments: [],
		},
		{
			title: 'Feat: confirmed [APP-4]',
			body: body('Run the key parity scan after touching any locale file in mobile', 'clients/mobile/src/locales'),
			mergedAt: '2026-10-07',
			comments: [{ body: '/dev-factory promote' }],
		},
		{ title: 'no key in the title', body: body('This one is ignored because the title has no key at all'), mergedAt: '2026-10-08', comments: [] },
	];
	const entries = entriesFromPrs(prs);
	assert.equal(entries.length, 4);
	const c = promotionCandidates(entries, 2);
	assert.equal(c.length, 2);
	assert.deepEqual(c.find((x) => x.scope.startsWith('services/api')).tickets.sort(), ['APP-1', 'APP-2']);
	assert.equal(c.find((x) => x.scope.startsWith('clients/mobile')).confirmed, true);
});

test('preload picks the few learnings whose scope matches the ticket text', () => {
	const entries = [
		{ at: '2026-10-01', key: 'A-1', scope: 'services/api', text: 'Bound the retry loop in api handlers' },
		{ at: '2026-10-02', key: 'A-2', scope: 'clients/mobile', text: 'Add testIDs to every tappable' },
		{ at: '2026-10-03', key: 'A-3', scope: '.', text: 'Use invented identifiers in fixtures' },
	];
	const lines = preload({ entries, ticketText: 'Change services/api/lib/pool.ts so it releases connections' });
	assert.equal(lines.length, 2);
	assert.match(lines[0], /invented identifiers/);
	assert.ok(!lines.join().includes('testIDs'));
	assert.equal(preload({ entries, ticketText: 'x', max: 1 }).length, 1);
	assert.equal(preload({ entries, ticketText: 'services/api/x', maxChars: 30 }).length, 0);
});

test('a promotion may change only the Learned rules section of AGENTS.md files', () => {
	const before = '# Mobile\n\nSome guidance.\n\n## Testing\nrun tests\n';
	const rule = '- Add a testID to every tappable before writing the e2e flow (APP-1, APP-2)';
	const add = (t) => ({ path: 'clients/mobile/AGENTS.md', before, after: t });
	assert.deepEqual(checkPromotion([add(`${before}\n## Learned rules\n${rule}\n`)]), []);
	assert.match(checkPromotion([add(before.replace('Some guidance', 'Other guidance') + `\n## Learned rules\n${rule}\n`)]).join(), /outside/);
	assert.match(checkPromotion([add(`${before}\n## Learned rules\n- no evidence on this rule line\n`)]).join(), /evidence/);
	assert.match(checkPromotion([{ path: 'CLAUDE.md', before: 'x', after: 'y' }]).join(), /only AGENTS\.md/);
	assert.match(checkPromotion([{ path: 'dev-factory/AGENTS.md', before: 'x', after: 'y' }]).join(), /only AGENTS\.md/);
	assert.match(checkPromotion([add(before)]).join(), /section is missing/);
	const many = Array.from({ length: 3 }, (_, i) => `- Rule number ${i} that is long enough to count (APP-${i + 1})`).join('\n');
	assert.match(checkPromotion([add(`${before}\n## Learned rules\n${many}\n`)], { cap: 2 }).join(), /cap is 2/);
	const withSection = `${before}\n## Learned rules\n${rule}\n\n## Later\ntext\n`;
	const grown = `${before}\n## Learned rules\n${rule}\n- Another rule that is long enough to count (APP-9)\n\n## Later\ntext\n`;
	assert.deepEqual(checkPromotion([{ path: 'clients/mobile/AGENTS.md', before: withSection, after: grown }]), []);
	const tampered = grown.replace('text\n', 'changed\n');
	assert.match(checkPromotion([{ path: 'clients/mobile/AGENTS.md', before: withSection, after: tampered }]).join(), /outside/);
});

test('a ticket record summarises the run state', () => {
	const root = wt({ key: 'APP-8', kind: 'bug' });
	review(root, 'h1', 'spec', { high: 1 });
	review(root, 'h2', 'spec', {});
	review(root, 'h2', 'standards', {});
	fs.writeFileSync(path.join(root, '.dev-factory/build.done'), 'x');
	fs.writeFileSync(path.join(root, '.dev-factory/ship.done'), 'x');
	debugLib.open({ root, trigger: 'triage', command: 'curl x', output: 'Error: boom' });
	const r = buildTicketRecord({ worktree: root, env: 'staging', costUsd: 3.2 });
	assert.equal(r.key, 'APP-8');
	assert.equal(r.reviewRounds, 2);
	assert.equal(r.reviewHigh, 1);
	assert.equal(r.debugRounds, 1);
	assert.equal(r.outcome, 'shipped');
	assert.equal(r.fingerprints.length, 1);
	assert.ok(r.learningRequired);
});

test('records append as lines and cluster across different tickets only', () => {
	const file = path.join(tmp(), 'runs.jsonl');
	const base = { type: 'ticket', reviewAxes: ['spec'], qaAttempts: 1 };
	append({ ...base, at: '2026-10-01', key: 'A', fingerprints: ['f1'], blockedReason: 'environment busy 12' }, file);
	append({ ...base, at: '2026-10-02', key: 'B', fingerprints: ['f1'], blockedReason: 'environment busy 7' }, file);
	append({ ...base, at: '2026-10-03', key: 'B', fingerprints: ['f2'], reviewHigh: 1 }, file);
	assert.equal(readRuns(file).length, 3);
	assert.equal(readRuns(file, '2026-10-01').length, 2);
	const c = clusters(readRuns(file), 2);
	assert.deepEqual(c.map((x) => `${x.kind}:${x.count}`).sort(), ['blocked:2', 'fingerprint:2']);
	assert.equal(clusters(readRuns(file), 3).length, 0);
});

test('the CLI writes a pass record from a claude result file', () => {
	const dir = tmp();
	const rf = path.join(dir, 'r.json');
	fs.writeFileSync(rf, JSON.stringify({ total_cost_usd: 1.5, duration_ms: 1000, num_turns: 4, result: 'ok\ntick: claimed=1 shipped=1' }));
	const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'run-record.mjs');
	const out = JSON.parse(
		execFileSync('node', [script, 'pass', '--result-file', rf, '--started', '2026-10-15T00:00:00Z'], {
			env: { ...process.env, DF_STATE_DIR: dir },
			encoding: 'utf8',
		}),
	);
	assert.equal(out.costUsd, 1.5);
	assert.equal(out.result, 'tick: claimed=1 shipped=1');
	assert.equal(readRuns(path.join(dir, 'runs', 'runs.jsonl')).length, 1);
});
