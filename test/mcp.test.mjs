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

// ---- servers Claude already has ----

import { doctorLines, externalServers, findServer, parseListing, planEnable, stateOf } from '../scripts/mcp.mjs';

const LISTING = [
	'Checking MCP server health…',
	'context7: npx -y @upstash/context7-mcp --api-key abc - ✔ Connected',
	'playwright: npx -y @playwright/mcp@latest - ✔ Connected',
	'claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected',
	'plugin:productivity:notion: https://mcp.notion.com/mcp - ! Needs authentication',
	'plugin:dev-factory:sentry: https://mcp.sentry.dev/mcp - ! Needs authentication',
	'atlassian: https://mcp.atlassian.com/v1/mcp (HTTP) - ⏸ Pending approval (run `claude` to approve)',
].join('\n');

test('the listing is read by name, and a name may contain colons', () => {
	const e = parseListing(LISTING);
	assert.ok(e.some((x) => x.name === 'plugin:dev-factory:sentry'));
	assert.equal(e.find((x) => x.name === 'context7').rest.includes('--api-key'), true);
	assert.equal(stateOf('x - ✔ Connected'), 'connected');
	assert.equal(stateOf('x - ! Needs authentication'), 'needs login');
	assert.equal(stateOf('x - ⏸ Pending approval (run `claude`)'), 'pending approval');
});

test("a server is found as itself, as the plugin's own, or as a claude.ai connector, never as another plugin's server of that name", () => {
	const e = parseListing(LISTING);
	assert.equal(findServer('context7', e).name, 'context7');
	assert.equal(findServer('sentry', e).name, 'plugin:dev-factory:sentry');
	assert.equal(findServer('notion', e).name, 'claude.ai Notion', "plugin:productivity:notion is somebody else's server");
	assert.equal(findServer('maestro', e), undefined);
});

test('enable and connect leave out what Claude already has, unless forced', () => {
	const file = tmp();
	const plan = planEnable(['context7', 'playwright', 'maestro', 'notion'], file, LISTING);
	assert.deepEqual(plan.write, ['maestro']);
	assert.deepEqual(plan.skipped.map((s) => s.id).sort(), ['context7', 'notion', 'playwright']);
	assert.deepEqual(planEnable(['context7'], file, LISTING, { force: true }), { write: ['context7'], skipped: [] });
	enable(['maestro'], file);
	assert.deepEqual(
		externalServers(file, LISTING)
			.map((s) => s.id)
			.sort(),
		['atlassian', 'context7', 'notion', 'playwright', 'sentry'],
	);
});

test('the doctor reports each server where it comes from, waiting approvals, logins, and a Playwright without --isolated', () => {
	const file = tmp();
	enable(['atlassian', 'sentry'], file);
	const lines = doctorLines(file, LISTING);
	const text = lines.map((l) => `${l.level}: ${l.text}`).join('\n');
	assert.match(text, /warn: MCP atlassian is waiting for your approval: run claude in this repository/);
	assert.match(text, /warn: MCP sentry needs a login/);
	assert.match(text, /ok: MCP context7 comes from "context7"/);
	assert.match(text, /ok: MCP notion comes from "claude\.ai Notion"/);
	assert.match(text, /warn: playwright \("playwright"\) runs without --isolated/);
	assert.match(text, /claude mcp add playwright -s user -- npx -y @playwright\/mcp@0\.0\.82 --isolated/);
	const isolated = doctorLines(file, LISTING.replace('@playwright/mcp@latest', '@playwright/mcp@0.0.82 --isolated'));
	assert.equal(
		isolated.some((l) => /--isolated/.test(l.text) && l.level === 'warn'),
		false,
	);
	assert.match(
		doctorLines(tmp(), '')
			.map((l) => l.text)
			.join(),
		/no MCP servers in use/,
	);
});

test('the scheduled pass may use servers Claude has from elsewhere, and their hosts are opened', () => {
	const file = tmp();
	assert.deepEqual(allowRules(file, ['context7']), ['mcp__context7', 'mcp__plugin_dev-factory_context7']);
	const s = build({ cfg: load(), mcpFile: file, external: ['sentry', 'context7'] });
	assert.ok(s.permissions.allow.includes('mcp__sentry') && s.permissions.allow.includes('mcp__context7'));
	assert.ok(s.sandbox.network.allowedDomains.includes('mcp.sentry.dev'));
	assert.equal(build({ cfg: load(), mcpFile: file }).permissions.allow.includes('mcp__sentry'), false);
});

test('the CLI skips duplicates and says so; --force writes them', async () => {
	const { spawnSync } = await import('node:child_process');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-mcpcli-'));
	const listing = path.join(dir, 'listing.txt');
	fs.writeFileSync(listing, LISTING);
	const file = path.join(dir, '.mcp.json');
	const run = (...args) =>
		spawnSync('node', [new URL('../scripts/mcp.mjs', import.meta.url).pathname, ...args], {
			encoding: 'utf8',
			env: { ...process.env, DF_MCP_LISTING: listing, DF_MCP_FILE: file },
		});
	const out = JSON.parse(run('enable', 'context7', 'maestro').stdout);
	assert.deepEqual(out.added, ['maestro']);
	assert.deepEqual(
		out.skipped.map((s) => s.id),
		['context7'],
	);
	assert.deepEqual(JSON.parse(run('enable', 'context7', '--force').stdout).added, ['context7']);
	assert.match(run('connect').stdout, /skip\s+playwright\s+already available as "playwright"/);
	assert.match(run('doctor').stdout, /playwright .* without --isolated/);
});

test('takeover lets the sandbox run the commands that stop host processes, and only then', async () => {
	const { load, merge } = await import('../scripts/config.mjs');
	const { TAKEOVER_EXCLUDED } = await import('../scripts/factory-settings.mjs');
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'df-takeover-')), '.mcp.json');
	const off = build({ cfg: load(), mcpFile: file }).sandbox.excludedCommands;
	const on = build({ cfg: merge(load(), { cleanup: { takeover: true } }), mcpFile: file }).sandbox.excludedCommands;
	for (const c of TAKEOVER_EXCLUDED) {
		assert.ok(!off.includes(c), `${c} is not excluded by default`);
		assert.ok(on.includes(c), `${c} is excluded with takeover`);
	}
	assert.ok(on.includes('docker *'), 'the base list is kept');
});
