import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QaError, scrubFile } from '../bin/qa.mjs';
import { evaluateMcp } from '../scripts/mcp-guard-lib.mjs';
import { scrubFindings } from '../scripts/scrub-lib.mjs';

const config = {
	telemetry: { maxRows: 200, maxWindowDays: 14 },
	environments: { staging: { axiomDatasets: ['lh2-staging'] }, prod: { axiomDatasets: ['lh2-prod'] } },
};
const S = 'mcp__plugin_dev-factory_sentry__';
const A = 'mcp__plugin_dev-factory_axiom__';
const run = (toolName, toolInput = {}) => evaluateMcp({ toolName, toolInput, config });

test('write verbs are denied in every naming style', () => {
	for (const t of ['update_issue', 'updateIssue', 'resolve-issue', 'create_dsn', 'mute_alert', 'ingestEvents'])
		assert.equal(run(S + t).deny, true, t);
	for (const t of ['get_issue_details', 'search_events', 'queryDataset', 'listDatasets']) assert.equal(run(S + t).deny, false, t);
});

test('tools of other servers are not touched', () => {
	assert.equal(run('mcp__plugin_dev-factory_context7__update', {}).deny, false);
	assert.equal(run('Bash', { command: 'ls' }).deny, false);
});

test('axiom queries must name an allowed dataset', () => {
	assert.equal(run(A + 'queryApl', { apl: "['lh2-prod'] | where level == 'error' | take 50" }).deny, false);
	assert.match(run(A + 'queryApl', { apl: "['secrets'] | take 5" }).reason, /not listed/);
	assert.match(run(A + 'query', { dataset: 'other' }).reason, /not listed/);
});

test('size and window caps', () => {
	assert.match(run(S + 'search_events', { limit: 1000 }).reason, /maxRows/);
	assert.match(run(A + 'queryApl', { apl: "['lh2-prod'] | take 5000" }).reason, /maxRows/);
	assert.match(run(S + 'search_events', { statsPeriod: '30d' }).reason, /maxWindowDays/);
	assert.equal(run(S + 'search_events', { statsPeriod: '24h' }).deny, false);
	assert.match(run(A + 'queryApl', { dataset: 'lh2-prod', startTime: '2026-01-01', endTime: '2026-02-01' }).reason, /maxWindowDays/);
});

test('scrub finds personal data and masks the sample', () => {
	const f = scrubFindings('contact jane.doe@example.com\nBearer abcdefghijklmnop1234\nimei 3569870000123456\nok line');
	assert.deepEqual(
		f.map((x) => x.rule),
		['email address', 'bearer token', 'long hex identifier'],
	);
	assert.ok(f.every((x) => !x.sample.includes('jane.doe')));
	assert.deepEqual(scrubFindings('42 events, 7 users, first seen 2026-10-01, release app-1.2.3'), []);
});

test('scrub honours configured patterns and the file command refuses', () => {
	assert.equal(scrubFindings('tenant ACME-123', ['ACME-\\d+']).length, 1);
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'df-scrub-')), 'body.md');
	fs.writeFileSync(f, 'clean text, 12 events');
	assert.equal(scrubFile({ file: f }).ok, true);
	fs.writeFileSync(f, 'user a@b.co hit it');
	assert.throws(
		() => scrubFile({ file: f }),
		(e) => e instanceof QaError && /scrub failed/.test(e.message),
	);
});

test('scrub allows git object ids and labelled identifiers but not bare long hex', () => {
	const sha = 'a'.repeat(7) + '1b2c3d4e5f60718293a4b5c6d7e8f9012';
	assert.equal(sha.length, 40);
	assert.deepEqual(scrubFindings(`[dev-factory] phase: build done run=1760000000 head=${sha}`), []);
	assert.deepEqual(scrubFindings(`commit ${sha} fixed it`), []);
	assert.deepEqual(scrubFindings(`debug fingerprint ${'9f'.repeat(20)}`), []);
	assert.deepEqual(scrubFindings(`sha256: ${'ab'.repeat(32)}`), []);
	assert.equal(scrubFindings(`device ${'ab12'.repeat(8)} offline`).length, 1);
	assert.equal(scrubFindings(`imei-ish ${'0123456789abcdef'}`).length, 1);
});
