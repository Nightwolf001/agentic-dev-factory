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

// ---- claude.ai connectors, execute_sentry_tool, manage, allowedRoles ----
const CS = 'mcp__claude_ai_Sentry__';
const CA = 'mcp__claude_ai_Axiom__';
const guard = (toolName, toolInput = {}, extra = {}) => evaluateMcp({ toolName, toolInput, config, ...extra });

test('a claude.ai connector is read-only inside a factory run and untouched in the person’s own session', () => {
	assert.equal(guard(CS + 'update_issue', {}, { inRun: true }).deny, true);
	assert.equal(guard(CA + 'ingest_events', {}, { inRun: true }).deny, true);
	assert.equal(guard(CS + 'search_issues', { limit: 10 }, { inRun: true }).deny, false);
	assert.match(guard(CS + 'search_events', { limit: 1000 }, { inRun: true }).reason, /maxRows/);
	assert.equal(guard(CA + 'queryApl', { apl: "['secrets'] | take 5" }, { inRun: true }).deny, true, 'datasets are checked for the connector too');
	for (const extra of [{}, { inRun: false }]) {
		assert.equal(guard(CS + 'update_issue', {}, extra).deny, false, JSON.stringify(extra));
		assert.equal(guard(CS + 'search_events', { limit: 1000 }, extra).deny, false);
	}
	// the plugin's and the repository's own servers stay guarded wherever they are used
	assert.equal(guard(S + 'update_issue', {}, { inRun: false }).deny, true);
	assert.equal(guard('mcp__sentry__update_issue', {}).deny, true);
});

test('manage counts as a write, in every naming style', () => {
	for (const t of ['manage_project', 'manage-alerts', 'manageIssue', 'issue_manage']) assert.equal(guard(S + t).deny, true, t);
	assert.equal(guard(S + 'get_manager_info').deny, false, 'a word that merely contains it');
});

test('execute_sentry_tool is judged by the tool it runs', () => {
	const run = (input) => guard(CS + 'execute_sentry_tool', input, { inRun: true });
	assert.equal(run({ tool_name: 'search_issues', arguments: { limit: 20 } }).deny, false);
	assert.equal(run({ tool: 'get_issue_details', args: { id: 'X-1' } }).deny, false);
	for (const name of ['update_issue', 'resolveIssue', 'manage_project', 'create_dsn'])
		assert.match(run({ tool_name: name, arguments: {} }).reason, /write operations/, name);
	assert.match(run({ tool_name: 'search_events', arguments: { limit: 5000 } }).reason, /maxRows/, 'caps apply to the inner arguments');
	assert.match(run({ tool_name: 'search_events', params: { statsPeriod: '30d' } }).reason, /maxWindowDays/);
	assert.match(run({}).reason, /does not say which tool/, 'a call that names no tool cannot be judged');
	assert.match(run({ tool_name: 'execute_sentry_tool', arguments: { tool_name: 'update_issue' } }).reason, /nested/);
	assert.equal(guard(CS + 'execute_sentry_tool', { tool_name: 'update_issue' }).deny, false, 'outside a run the connector is the person’s');
});

test('telemetry.allowedRoles narrows who may read, inside a run only', () => {
	const cfg = { ...config, telemetry: { ...config.telemetry, allowedRoles: ['debugger', 'researcher'] } };
	const as = (role, tool = CS + 'search_issues', extra = {}) =>
		evaluateMcp({ toolName: tool, toolInput: {}, config: cfg, inRun: true, role, ...extra });
	assert.equal(as('debugger').deny, false);
	assert.equal(as('researcher').deny, false);
	assert.match(as('builder').reason, /builder role may not read telemetry/);
	assert.match(as(undefined).reason, /not known/);
	assert.equal(as('reviewer', S + 'search_issues').deny, true, 'the plugin’s own server too');
	assert.equal(evaluateMcp({ toolName: S + 'search_issues', toolInput: {}, config: cfg }).deny, false, 'outside a run the list does not apply');
	assert.equal(evaluateMcp({ toolName: CS + 'search_issues', toolInput: {}, config: cfg, inRun: false }).deny, false);
	assert.equal(as('builder', CS + 'search_issues', {}).deny, true);
	assert.equal(
		evaluateMcp({
			toolName: CS + 'search_issues',
			toolInput: {},
			config: { ...config, telemetry: { ...config.telemetry, allowedRoles: [] } },
			inRun: true,
			role: 'builder',
		}).deny,
		false,
		'empty list: every role',
	);
});

test('the hook entry sees connector tools, and the setting is validated', async () => {
	const { default: hooks } = await import('../hooks/hooks.json', { with: { type: 'json' } });
	const matcher = new RegExp(`^(?:${hooks.hooks.PreToolUse.find((h) => /mcp-guard/.test(h.hooks[0].command)).matcher})$`);
	for (const n of ['mcp__claude_ai_Sentry__x', 'mcp__claude_ai_Axiom__x', 'mcp__sentry__x', 'mcp__plugin_dev-factory_axiom__x'])
		assert.ok(matcher.test(n), n);
	assert.ok(!matcher.test('mcp__claude_ai_Slack__x'));
	const { load, merge, validate } = await import('../scripts/config.mjs');
	assert.deepEqual(load().telemetry.allowedRoles, []);
	assert.deepEqual(validate(merge(load(), { telemetry: { allowedRoles: ['debugger'] } })), []);
	assert.match(validate(merge(load(), { telemetry: { allowedRoles: ['wizard'] } })).join('\n'), /telemetry\.allowedRoles/);
});
