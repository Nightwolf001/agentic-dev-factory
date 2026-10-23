import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { load, merge } from '../scripts/config.mjs';
import { build } from '../scripts/factory-settings.mjs';
import { allowRules, catalog, connectReport, disable, enable, recommend, status } from '../scripts/mcp.mjs';
import { evaluateMcp } from '../scripts/mcp-guard-lib.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'df-mcp-')), '.mcp.json');

test('the plugin itself registers no MCP server: every one is opt-in', () => {
	const shipped = JSON.parse(fs.readFileSync(new URL('../.mcp.json', import.meta.url), 'utf8'));
	assert.deepEqual(shipped.mcpServers, {});
});

test('every catalog entry says what it is for and what is lost without it', () => {
	for (const [id, s] of Object.entries(catalog())) {
		assert.ok(s.purpose && s.without && s.config && s.category, id);
		assert.ok(Array.isArray(s.domains), `${id}: domains`);
	}
});

test('enable merges into an existing .mcp.json without touching other servers, and is idempotent', () => {
	const file = tmp();
	fs.writeFileSync(file, JSON.stringify({ mcpServers: { mine: { command: 'x' } } }));
	assert.deepEqual(enable(['playwright', 'context7'], file), ['playwright', 'context7']);
	assert.deepEqual(enable(['playwright'], file), []);
	const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert.deepEqual(Object.keys(doc.mcpServers), ['mine', 'playwright', 'context7']);
	assert.deepEqual(disable(['playwright', 'ghost'], file), ['playwright']);
	assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers), ['mine', 'context7']);
	assert.throws(() => enable(['nope'], file), /unknown MCP server/);
});

test('status lists the whole catalog with what is enabled; allow rules cover both spellings of a server name', () => {
	const file = tmp();
	enable(['sentry'], file);
	const sentry = status(file).find((s) => s.id === 'sentry');
	assert.equal(sentry.enabled, true);
	assert.equal(status(file).filter((s) => s.enabled).length, 1);
	assert.deepEqual(allowRules(file), ['mcp__sentry', 'mcp__plugin_dev-factory_sentry']);
});

test('the tracker server follows the chosen task source, and nothing else is recommended beyond the basics', () => {
	const rec = (source) => recommend(merge(load(), { tasks: { source } }));
	assert.ok(rec('jira').includes('atlassian') && !rec('jira').includes('notion'));
	assert.ok(rec('notion').includes('notion') && !rec('notion').includes('atlassian'));
	for (const s of ['local', 'github']) assert.ok(!rec(s).includes('atlassian') && !rec(s).includes('notion'), s);
	assert.ok(!rec('local').includes('sentry'), 'telemetry is never recommended unasked');
});

test('the scheduled settings open only the hosts of enabled servers and of the chosen tracker', () => {
	const file = tmp();
	const base = build({ cfg: load(), mcpFile: file }).sandbox.network.allowedDomains;
	assert.equal(
		base.some((d) => /sentry|axiom|notion|atlassian|context7/.test(d)),
		false,
	);
	enable(['sentry', 'context7'], file);
	const on = build({ cfg: load(), mcpFile: file });
	assert.ok(on.sandbox.network.allowedDomains.includes('mcp.sentry.dev'));
	assert.ok(on.sandbox.network.allowedDomains.includes('context7.com'));
	assert.ok(on.permissions.allow.includes('mcp__sentry'));
	const jira = build({ cfg: merge(load(), { tasks: { source: 'jira' }, sources: { jira: { site: 'example.atlassian.net' } } }), mcpFile: file });
	assert.ok(jira.sandbox.network.allowedDomains.includes('example.atlassian.net'));
	const extra = build({ cfg: merge(load(), { sandbox: { extraDomains: ['registry.example.com'] } }), mcpFile: file });
	assert.ok(extra.sandbox.network.allowedDomains.includes('registry.example.com'));
});

test('the read-only telemetry guard covers a server started by the plugin and one from the repository .mcp.json', () => {
	for (const prefix of ['mcp__plugin_dev-factory_sentry__', 'mcp__sentry__']) {
		assert.equal(evaluateMcp({ toolName: `${prefix}update_issue`, toolInput: {}, config: load() }).deny, true, prefix);
		assert.equal(evaluateMcp({ toolName: `${prefix}search_issues`, toolInput: { limit: 10 }, config: load() }).deny, false, prefix);
	}
});

test('connect reports which enabled servers are connected, need a login, or have not started', () => {
	const file = tmp();
	enable(['playwright', 'sentry', 'notion', 'context7'], file);
	const listing = [
		'playwright: npx -y @playwright/mcp - ✓ Connected',
		'sentry: https://mcp.sentry.dev/mcp (HTTP) - ! Needs authentication',
		'plugin:dev-factory:notion: https://x (HTTP) - ✗ Failed to connect',
	].join('\n');
	const byId = Object.fromEntries(connectReport(file, listing).map((r) => [r.id, r]));
	assert.equal(byId.playwright.state, 'connected');
	assert.deepEqual([byId.sentry.state, byId.sentry.login], ['needs login', true]);
	assert.equal(byId.notion.state, 'failed');
	assert.deepEqual([byId.context7.state, byId.context7.login], ['not started', false]);
	assert.ok(
		connectReport(file, '').every((r) => r.state === 'not started'),
		'no answer from claude is not a claim of success',
	);
});
