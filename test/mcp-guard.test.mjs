import './isolate-state.mjs';
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

test('GitHub is read-only inside a run, whichever server carries it, and free outside one', () => {
	const gh = (toolName, inRun = true) => evaluateMcp({ toolName, toolInput: {}, config, inRun });
	for (const t of [
		'mcp__github__merge_pull_request',
		'mcp__github__create_or_update_file',
		'mcp__claude_ai_GitHub__push_files',
		'mcp__plugin_dev-factory_github__create_issue',
		'mcp__github__add_issue_comment',
		'mcp__github__get_or_create_branch',
		'mcp__github__search_and_replace_file',
		'mcp__github__list_and_delete_branches',
		'mcp__github__getOrCreateBranch',
	]) {
		const v = gh(t);
		assert.equal(v.deny, true, t);
		assert.match(v.reason, /a run reaches GitHub through the guarded gh CLI; the GitHub MCP server is read-only here/, t);
	}
	for (const t of [
		'mcp__github__get_file_contents',
		'mcp__github__list_pull_requests',
		'mcp__github__search_code',
		'mcp__github__pull_request_read',
		'mcp__claude_ai_GitHub__get_me',
		'mcp__github__list_workflow_runs',
		'mcp__github__get_job_logs',
		'mcp__github__get_pull_request_diff',
	])
		assert.equal(gh(t).deny, false, t);
	assert.equal(gh('mcp__github__merge_pull_request', false).deny, false, 'outside a run the server is the person’s');
	assert.equal(gh('mcp__github__merge_pull_request', null).deny, false, 'no run known');
	assert.equal(gh('mcp__githubx__merge_pull_request').deny, false, 'another server');
});

test('the hook matcher also sees GitHub tools', async () => {
	const { default: hooks } = await import('../hooks/hooks.json', { with: { type: 'json' } });
	const matcher = new RegExp(`^(?:${hooks.hooks.PreToolUse.find((h) => /mcp-guard/.test(h.hooks[0].command)).matcher})$`);
	for (const n of ['mcp__github__merge_pull_request', 'mcp__claude_ai_GitHub__push_files', 'mcp__plugin_dev-factory_github__x'])
		assert.ok(matcher.test(n), n);
	assert.ok(!matcher.test('mcp__githubx__merge_pull_request'));
});

// ---- redaction ----
import { mergeSpans, redactText } from '../scripts/scrub-lib.mjs';

test('redactText replaces each finding and keeps the rest of the line', () => {
	const r = redactText('user jane.doe@example.com sent Bearer abcdefghijklmnop1234 at 12:00\nplain line\ndevice 3569870000123456 ok');
	assert.equal(r.text, 'user [redacted:email address] sent [redacted:bearer token] at 12:00\nplain line\ndevice [redacted:long hex identifier] ok');
	assert.equal(r.redactions, 3);
	assert.deepEqual(scrubFindings(r.text), [], 'what is left passes the scrub');
	assert.equal(redactText('nothing here, 42 events').text, 'nothing here, 42 events');
	assert.equal(redactText('').text, '');
});

test('overlapping findings become one redaction, and extra patterns apply', () => {
	assert.deepEqual(
		mergeSpans([
			{ start: 0, end: 10, rule: 'a' },
			{ start: 5, end: 15, rule: 'b' },
			{ start: 20, end: 22, rule: 'c' },
		]),
		[
			{ start: 0, end: 15, rules: ['a', 'b'] },
			{ start: 20, end: 22, rules: ['c'] },
		],
	);
	// a JWT also looks like a bearer token's tail and a long identifier: one marker, not three
	const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJ';
	assert.equal(redactText(`token=${jwt} end`).text.match(/\[redacted:/g).length, 1);
	assert.equal(redactText('tenant ACME-123 here', { extraPatterns: ['ACME-\\d+'] }).text, 'tenant [redacted:configured pattern] here');
});

test('literal secrets are removed wherever they appear, every time', () => {
	const r = redactText('login with hunter2hunter2 then hunter2hunter2 again\n{"password":"s3cr3t!"}', {
		secrets: ['hunter2hunter2', 's3cr3t!', 'x'],
	});
	assert.equal(r.text, 'login with [redacted:secret] then [redacted:secret] again\n{"password":"[redacted:secret]"}');
	assert.equal(r.redactions, 3);
	assert.match(
		redactText('a b x y', { secrets: ['x'] }).text,
		/a b x y/,
		'a secret shorter than 3 characters is ignored (it would shred the text)',
	);
	assert.match(
		redactText('key=sk_live_abcdefghijklmnop1234 and pw hunter2hunter2', { secrets: ['hunter2hunter2'] }).text,
		/\[redacted:API key\].*\[redacted:secret\]/,
	);
});

test('what line-wise redaction cannot catch is stated, and the email rule no longer takes seconds on minified input', () => {
	// a split key and a JSON password value are not found: that is why the README says to pass such values in `secrets`
	assert.equal(redactText('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----').redactions, 0);
	assert.equal(redactText('{"password": "hunter2"}').redactions, 0);
	const minified = 'a'.repeat(64 * 1024);
	for (const input of [minified, 'a.b'.repeat(22000), ('x%+-'.repeat(16000) + ' ').repeat(1)]) {
		const t = Date.now();
		redactText(input);
		scrubFindings(input);
		assert.ok(Date.now() - t < 1500, `a 64 KB line takes ${Date.now() - t} ms`);
	}
	assert.equal(redactText('mail me: a@b.co.').text, 'mail me: [redacted:email address].');
	assert.equal(redactText('x'.repeat(200) + '@example.com').redactions, 0, 'a local part longer than any address is not an address');
	assert.equal(scrubFindings('first.last+tag@sub.example.co.uk').length, 1);
});

// ---- the hook entry: what it derives from the event and the environment ----
import { spawnSync } from 'node:child_process';

const ENTRY = new URL('../scripts/mcp-guard.mjs', import.meta.url).pathname;
function hook(event, env = {}) {
	const state = fs.mkdtempSync(path.join(os.tmpdir(), 'df-mcpguard-'));
	const e = { ...process.env, DF_STATE_DIR: state, ...env };
	delete e.DF_ACTIVE;
	Object.assign(e, env);
	return spawnSync(process.execPath, [ENTRY], { input: JSON.stringify(event), encoding: 'utf8', env: e });
}
const CONNECTOR_WRITE = 'mcp__claude_ai_Sentry__update_issue';

test('a claude.ai connector write is refused inside a factory run and allowed in the person’s own session', () => {
	const own = fs.mkdtempSync(path.join(os.tmpdir(), 'df-own-'));
	assert.equal(hook({ tool_name: CONNECTOR_WRITE, tool_input: {}, cwd: own }).status, 0, 'no run, no flag: not guarded');
	assert.equal(hook({ tool_name: CONNECTOR_WRITE, tool_input: {}, cwd: own }, { DF_ACTIVE: '1' }).status, 2, 'DF_ACTIVE marks a scheduled pass');
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'df-wt-'));
	fs.mkdirSync(path.join(wt, '.dev-factory'));
	fs.writeFileSync(path.join(wt, '.dev-factory/run.json'), JSON.stringify({ key: 'APP-1', role: 'builder' }));
	const denied = hook({ tool_name: CONNECTOR_WRITE, tool_input: {}, cwd: wt });
	assert.equal(denied.status, 2, 'a run.json in the working directory is a run');
	assert.match(denied.stderr, /\S/);
});

test('the run’s role is passed through, so telemetry.allowedRoles decides who may read', () => {
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'df-wt-'));
	fs.mkdirSync(path.join(wt, '.dev-factory'));
	fs.writeFileSync(path.join(wt, '.dev-factory/run.json'), JSON.stringify({ key: 'APP-1', role: 'builder' }));
	fs.writeFileSync(path.join(wt, 'dev-factory.config.json'), JSON.stringify({ telemetry: { allowedRoles: ['debugger'] } }));
	const read = { tool_name: 'mcp__plugin_dev-factory_sentry__get_issue_details', tool_input: {}, cwd: wt };
	const builder = spawnSync(process.execPath, [ENTRY], {
		input: JSON.stringify(read),
		encoding: 'utf8',
		cwd: wt,
		env: { ...process.env, DF_STATE_DIR: wt },
	});
	assert.equal(builder.status, 2, builder.stderr);
	fs.writeFileSync(path.join(wt, '.dev-factory/run.json'), JSON.stringify({ key: 'APP-1', role: 'debugger' }));
	const debuggerRun = spawnSync(process.execPath, [ENTRY], {
		input: JSON.stringify(read),
		encoding: 'utf8',
		cwd: wt,
		env: { ...process.env, DF_STATE_DIR: wt },
	});
	assert.equal(debuggerRun.status, 0, debuggerRun.stderr);
});

test('input that is not JSON is let through rather than blocking every tool', () => {
	const r = spawnSync(process.execPath, [ENTRY], { input: 'not json', encoding: 'utf8' });
	assert.equal(r.status, 0);
});
