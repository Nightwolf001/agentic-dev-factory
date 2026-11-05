import './isolate-state.mjs';
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
	const none = { env: {}, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'df-rec-')) };
	const rec = (source) => recommend(merge(load(), { tasks: { source } }), catalog(), none);
	assert.ok(rec('jira').includes('atlassian') && !rec('jira').includes('notion'));
	assert.ok(rec('notion').includes('notion') && !rec('notion').includes('atlassian'));
	for (const s of ['local', 'github']) assert.ok(!rec(s).includes('atlassian') && !rec(s).includes('notion'), s);
	assert.ok(!rec('local').includes('sentry'), 'telemetry is never recommended unasked');
});

test('for tasks.source = jira exactly one Jira server is recommended: the enabled one, else jira on credentials, else atlassian', () => {
	const cfg = merge(load(), { tasks: { source: 'jira' } });
	const empty = () => fs.mkdtempSync(path.join(os.tmpdir(), 'df-rec-'));
	const jiraOf = (ids) => ids.filter((id) => ['jira', 'atlassian'].includes(id));
	const creds = { JIRA_EMAIL: 'a@example.com', JIRA_API_TOKEN: 'tok' };
	// no credentials anywhere: the OAuth server
	assert.deepEqual(jiraOf(recommend(cfg, catalog(), { env: {}, dir: empty() })), ['atlassian']);
	assert.deepEqual(
		jiraOf(recommend(cfg, catalog(), { env: { JIRA_EMAIL: 'a@example.com' }, dir: empty() })),
		['atlassian'],
		'a token is needed too',
	);
	// credentials in the environment
	assert.deepEqual(jiraOf(recommend(cfg, catalog(), { env: { ...creds }, dir: empty() })), ['jira']);
	// credentials in the state folder's .env.local, which the call does not copy into the environment
	const dir = empty();
	fs.writeFileSync(path.join(dir, '.env.local'), 'JIRA_EMAIL=a@example.com\nJIRA_API_TOKEN=tok\n');
	const env = {};
	assert.deepEqual(jiraOf(recommend(cfg, catalog(), { env, dir })), ['jira']);
	assert.deepEqual(env, {}, 'the caller’s environment is left alone');
	// a repository that already has one keeps it, whatever the credentials say
	const file = tmp();
	enable(['atlassian'], file);
	assert.deepEqual(jiraOf(recommend(cfg, catalog(), { file, env: { ...creds }, dir })), ['atlassian']);
	const file2 = tmp();
	enable(['jira'], file2);
	assert.deepEqual(jiraOf(recommend(cfg, catalog(), { file: file2, env: {}, dir: empty() })), ['jira']);
	// the rest of the recommendation is unchanged, and other sources never recommend either
	assert.ok(recommend(cfg, catalog(), { env: {}, dir: empty() }).includes('playwright'));
	for (const source of ['local', 'github', 'notion']) assert.deepEqual(jiraOf(recommend(merge(load(), { tasks: { source } }))), [], source);
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

import { doctorLines, externalServers, findServer, parseListing, planEnable, secretLines, stateOf } from '../scripts/mcp.mjs';

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
	assert.equal(stateOf('npx -y failed-tests-mcp --connected - ✔ Connected'), 'connected', 'a word in the command is not the status');
	assert.equal(stateOf('node needs-auth-proxy.js - ✗ Failed to connect'), 'failed');
	assert.equal(stateOf('not started'), 'not started');
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

test('the CLI leaves what Claude already has alone and says so, and the doctor still reports it', () => {
	const { run, env, fake, repo } = sandbox();
	fs.writeFileSync(env.DF_MCP_LISTING, LISTING);
	const out = run('enable', 'context7', 'maestro');
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /skip\s+context7\s+already available as "context7"/);
	const added = fake
		.calls()
		.filter((c) => c.args[1] === 'add-json')
		.map((c) => c.args[4]);
	assert.deepEqual(added, ['maestro'], 'context7 and playwright are used as they are');
	assert.match(run('connect').stdout, /skip\s+playwright\s+already available as "playwright"/);
	assert.match(run('doctor').stdout, /playwright .* without --isolated/);
	assert.equal(fs.existsSync(path.join(repo, '.mcp.json')), false, 'nothing is written to .mcp.json');
});

test('takeover lets the sandbox run the commands that stop host processes, and only then', async () => {
	const { load, merge } = await import('../scripts/config.mjs');
	const { TAKEOVER_EXCLUDED } = await import('../scripts/factory-settings.mjs');
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'df-takeover-')), '.mcp.json');
	const off = build({ cfg: load(), mcpFile: file, env: {} }).sandbox.excludedCommands;
	const fromFile = build({ cfg: merge(load(), { cleanup: { takeover: true } }), mcpFile: file, env: {} }).sandbox.excludedCommands;
	const on = build({ cfg: load(), mcpFile: file, env: { DF_TAKEOVER: '1' } }).sandbox.excludedCommands;
	for (const c of TAKEOVER_EXCLUDED) assert.ok(!fromFile.includes(c), `${c}: a config value does not grant takeover`);
	for (const c of TAKEOVER_EXCLUDED) {
		assert.ok(!off.includes(c), `${c} is not excluded by default`);
		assert.ok(on.includes(c), `${c} is excluded with takeover`);
	}
	assert.ok(on.includes('docker *'), 'the base list is kept');
});

test('the scheduled pass may write the state folder and runs e2e-env.sh outside the sandbox', async () => {
	const { load } = await import('../scripts/config.mjs');
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'df-state-')), '.mcp.json');
	const out = build({ cfg: load(), mcpFile: file, env: {}, state: '/Users/dev/.dev-factory' });
	assert.deepEqual(out.sandbox.filesystem.allowWrite, ['/Users/dev/.dev-factory']);
	assert.ok(out.sandbox.filesystem.denyRead.includes('~/.ssh'), 'the base denials stay');
	for (const c of ['bash *e2e-env.sh*', 'dev-factory env*', 'node *open-prs.mjs*']) assert.ok(out.sandbox.excludedCommands.includes(c), c);
	// open-prs.mjs runs gh and reads the task source: inside the sandbox gh cannot read its token and the count would always be unknown
	assert.match(fs.readFileSync(new URL('../commands/tick.md', import.meta.url), 'utf8'), /scripts\/open-prs\.mjs/);
	const env = build({ cfg: load(), mcpFile: file, env: { DF_STATE_DIR: '/custom/state' } });
	assert.deepEqual(env.sandbox.filesystem.allowWrite, ['/custom/state'], 'DF_STATE_DIR is where it is');
});

// ---- required servers ----

const REQ_CAT = {
	alpha: { title: 'Alpha', purpose: 'p', category: 'qa', recommended: false, required: true, config: { command: 'a' }, without: 'w', domains: [] },
	beta: { title: 'Beta', purpose: 'p', category: 'docs', recommended: false, config: { command: 'b' }, without: 'w', domains: [] },
};
const mcpFile = (servers) => {
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'df-req-')), '.mcp.json');
	fs.writeFileSync(f, JSON.stringify({ mcpServers: servers }));
	return f;
};

test('a server the catalog flags required is always recommended, and the doctor fails while it is missing or down', async () => {
	const { load, merge } = await import('../scripts/config.mjs');
	assert.deepEqual(recommend(merge(load(), {}), REQ_CAT), ['alpha'], 'required without being recommended');
	assert.ok(!recommend(merge(load(), {}), REQ_CAT).includes('beta'));
	const none = doctorLines(mcpFile({}), '', REQ_CAT);
	assert.deepEqual(
		none.find((l) => /alpha/.test(l.text)),
		{ level: 'fail', text: 'required MCP alpha is not enabled: dev-factory mcp enable alpha' },
	);
	const down = doctorLines(mcpFile({ alpha: {} }), 'alpha: a - ✗ Failed to connect', REQ_CAT);
	assert.equal(down.find((l) => /alpha/.test(l.text)).level, 'fail');
	assert.match(down.find((l) => /alpha/.test(l.text)).text, /required MCP alpha is .*must be connected/);
	const login = doctorLines(mcpFile({ alpha: {} }), 'alpha: a - ⚠ Needs authentication', REQ_CAT);
	assert.equal(login.find((l) => /alpha/.test(l.text)).level, 'fail');
	const up = doctorLines(mcpFile({ alpha: {} }), 'alpha: a - ✓ Connected', REQ_CAT);
	assert.deepEqual(
		up.filter((l) => /alpha/.test(l.text)),
		[{ level: 'ok', text: 'required MCP alpha connected' }],
		'reported once, not again as an ordinary server',
	);
	// from somewhere else (a user-scope server) it counts too
	const external = doctorLines(mcpFile({}), 'alpha: a - ✓ Connected', REQ_CAT);
	assert.equal(external.find((l) => /alpha/.test(l.text)).level, 'ok');
	assert.equal(external.filter((l) => /alpha/.test(l.text)).length, 1);
});

test('--lenient and --ci turn the failure into a warning, and an ordinary server never fails the doctor', () => {
	const lenient = doctorLines(mcpFile({}), '', REQ_CAT, { lenient: true });
	assert.equal(lenient.find((l) => /alpha/.test(l.text)).level, 'warn');
	const ordinary = doctorLines(mcpFile({ beta: {} }), '', REQ_CAT);
	assert.equal(ordinary.find((l) => /MCP beta/.test(l.text)).level, 'warn');
	assert.ok(ordinary.every((l) => l.level !== 'fail' || /required MCP alpha/.test(l.text)));
	const doctor = fs.readFileSync(new URL('../scripts/doctor.sh', import.meta.url), 'utf8');
	assert.match(doctor, /--lenient/);
	assert.match(doctor, /FAIL\*\) bad/);
	assert.match(doctor, /\[ "\$CI" = 1 \] && LENIENT=1/);
});

// Every UI change needs a browser walk, so playwright is the one server the catalog flags required. maestro is required only once
// mobile.appDir is set, which the catalog cannot say: requiredServers(config) in scripts/config.mjs adds it.
test('the shipped catalog flags exactly playwright required, and a required flag has to be a boolean', async () => {
	const { catalog } = await import('../scripts/mcp.mjs');
	for (const [id, s] of Object.entries(catalog())) assert.ok(s.required === undefined || typeof s.required === 'boolean', `${id}.required`);
	assert.deepEqual(
		Object.entries(catalog())
			.filter(([, s]) => s.required === true)
			.map(([id]) => id),
		['playwright'],
	);
});

test('every catalog server names a defaultScope of user or project', () => {
	const scopes = Object.fromEntries(Object.entries(catalog()).map(([id, s]) => [id, s.defaultScope]));
	for (const [id, scope] of Object.entries(scopes)) assert.ok(['user', 'project'].includes(scope), `${id}: ${scope}`);
	for (const id of ['playwright', 'maestro', 'jira', 'atlassian', 'notion', 'context7', 'github', 'sequential-thinking'])
		assert.equal(scopes[id], 'user', id);
	for (const id of ['21st', 'sentry', 'axiom']) assert.equal(scopes[id], 'project', id);
});

test('jira and github are in the catalog and their configs hold variable references, no values', () => {
	const cat = catalog();
	assert.ok(cat.jira && cat.github);
	assert.equal(cat.jira.recommended, false);
	assert.equal(cat.jira.tracker, 'jira', 'recommended only when tasks.source = jira, like atlassian');
	assert.deepEqual(cat.jira.config.args, ['jira-mcp']);
	assert.deepEqual(Object.keys(cat.jira.config.env), ['JIRA_EMAIL', 'JIRA_API_TOKEN']);
	assert.deepEqual(cat.jira.secrets, ['JIRA_EMAIL', 'JIRA_API_TOKEN']);
	assert.ok(cat.jira.requires.some((r) => /dev-factory install --apply/.test(r)));
	assert.equal(cat.github.config.url, 'https://api.githubcopilot.com/mcp/');
	assert.deepEqual(cat.github.secrets, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
	assert.deepEqual(cat.github.domains, ['api.githubcopilot.com']);
	assert.deepEqual(cat.context7.secrets, ['CONTEXT7_API_KEY']);
	assert.equal(cat.context7.secretsOptional, true);
	for (const id of ['jira', 'github', 'context7']) {
		const text = JSON.stringify(cat[id].config);
		assert.doesNotMatch(text, id === 'context7' ? /ghp_|github_pat_/ : /ghp_|github_pat_|@/, id);
		for (const v of [...Object.values(cat[id].config.env ?? {}), ...Object.values(cat[id].config.headers ?? {})])
			if (typeof v === 'string') assert.match(v, /\$\{[A-Z0-9_]+:-/, `${id}: a reference, not a value`);
	}
	const creds = { env: { JIRA_EMAIL: 'a@example.com', JIRA_API_TOKEN: 'tok' }, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'df-rec-')) };
	const rec = (source) => recommend(merge(load(), { tasks: { source } }), catalog(), creds);
	assert.ok(rec('jira').includes('jira'));
	for (const s of ['local', 'github', 'notion']) assert.ok(!rec(s).includes('jira') && !rec(s).includes('github'), s);
});

// ---- servers at user or project scope, with ownership ----

import { execFileSync, spawnSync } from 'node:child_process';
import {
	applySync,
	claudeBin,
	desired,
	launcherPath,
	mainCheckout,
	managedFile,
	planLegacyMigration,
	planSync,
	readManaged,
	secretsReport,
	serverConfig,
	userEnabled,
	writeManaged,
	writePassConfig,
} from '../scripts/mcp.mjs';

const DEFAULTS = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const L = (user = {}, project = {}) => [
	{ name: 'defaults', file: 'config.json', data: DEFAULTS },
	{ name: 'user', file: 'u.json', data: user },
	{ name: 'project', file: 'p.json', data: project },
];
const servers = (map) => ({ mcp: { servers: map } });
const brief = (list) => list.map((w) => `${w.id}@${w.scope}`).sort();
const state = () => fs.mkdtempSync(path.join(os.tmpdir(), 'df-mcp-state-'));
const noManaged = () => ({ mcp: { user: [], local: {} }, plugins: { user: [], local: {} } });

// A stand-in for `claude`: logs its arguments (and where it ran), and exits 1 for a server named in DF_FAKE_FAIL.
function fakeClaude() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-fake-claude-'));
	const bin = path.join(dir, 'claude');
	fs.writeFileSync(
		bin,
		`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.DF_FAKE_LOG) fs.appendFileSync(process.env.DF_FAKE_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if ((process.env.DF_FAKE_FAIL || '').split(',').includes(args[4])) { console.error('boom ' + args[4]); process.exit(1); }
`,
		{ mode: 0o755 },
	);
	const log = path.join(dir, 'log.jsonl');
	const calls = () =>
		fs.existsSync(log)
			? fs
					.readFileSync(log, 'utf8')
					.trim()
					.split('\n')
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
	return { bin, log, calls, env: { DF_CLAUDE_BIN: bin, DF_FAKE_LOG: log } };
}

test('claudeBin is DF_CLAUDE_BIN, else claude', () => {
	assert.equal(claudeBin({ DF_CLAUDE_BIN: '/x/claude' }), '/x/claude');
	assert.equal(claudeBin({}), 'claude');
});

test('desired: user wins over project, project false drops a user-level server, required servers always present at defaultScope', () => {
	const w = desired(L(servers({ context7: true, sentry: true }), servers({ sentry: true, '21st': true, context7: false })));
	assert.deepEqual(brief(w), ['21st@project', 'playwright@user', 'sentry@user']);
	assert.equal(w.suppressed, undefined, 'no hidden property: a copy of the array behaves like the array');
	assert.equal(w.find((x) => x.id === 'playwright').required, true);
	assert.equal(w.find((x) => x.id === 'sentry').required, false);
	// a required server is at the layer that names it
	assert.equal(desired(L({}, servers({ playwright: true }))).find((x) => x.id === 'playwright').scope, 'project');
	assert.equal(desired(L()).find((x) => x.id === 'playwright').scope, 'user');
});

test('desired: maestro is present when mobile.appDir is set (requiredServers), otherwise only when a layer turns it on', () => {
	assert.ok(!desired(L()).some((x) => x.id === 'maestro'));
	const mobile = desired(L({}, { mobile: { appDir: 'app' } })).find((x) => x.id === 'maestro');
	assert.deepEqual([mobile.scope, mobile.required], ['user', true]);
	const asked = desired(L({}, servers({ maestro: true }))).find((x) => x.id === 'maestro');
	assert.deepEqual([asked.scope, asked.required], ['project', false]);
});

test('planSync adds a wanted server at its scope and moves a scope as remove plus add', () => {
	const want = [
		{ id: 'sentry', scope: 'project', required: false },
		{ id: 'context7', scope: 'user', required: false },
	];
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'df-repo-'));
	assert.deepEqual(planSync({ want, managed: noManaged(), listing: '', repo }), {
		add: [
			{ id: 'sentry', scope: 'project' },
			{ id: 'context7', scope: 'user' },
		],
		remove: [],
		skip: [],
	});
	const managed = noManaged();
	managed.mcp.user = ['sentry', 'context7'];
	const moved = planSync({ want, managed, listing: '', repo, userIds: ['context7'] });
	assert.deepEqual(moved.add, [{ id: 'sentry', scope: 'project' }]);
	assert.deepEqual(moved.remove, [{ id: 'sentry', scope: 'user' }]);
	assert.deepEqual(moved.skip, []);
});

test('planSync never removes a server the factory does not manage, and skips one Claude already has', () => {
	const listing = 'playwright: npx -y @playwright/mcp@latest - ✔ Connected';
	const plan = planSync({ want: [], managed: noManaged(), listing, repo: os.tmpdir(), userIds: [] });
	assert.deepEqual(plan.remove, []);
	const wanted = planSync({ want: [{ id: 'playwright', scope: 'user', required: true }], managed: noManaged(), listing, repo: os.tmpdir() });
	assert.deepEqual(wanted.add, []);
	assert.deepEqual(wanted.skip, [{ id: 'playwright', name: 'playwright', reason: 'already available as "playwright"' }]);
	// one it manages is not a skip, and once nothing wants it, it is removed
	const managed = noManaged();
	managed.mcp.user = ['playwright'];
	assert.deepEqual(planSync({ want: [{ id: 'playwright', scope: 'user', required: true }], managed, listing, repo: os.tmpdir() }).skip, []);
	assert.deepEqual(planSync({ want: [], managed, listing, repo: os.tmpdir(), userIds: [] }).remove, [{ id: 'playwright', scope: 'user' }]);
});

test('planSync never removes a user-scope server for one project: a project false, a copied or filtered want, or no userIds', () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'df-repo-'));
	const managed = noManaged();
	managed.mcp.user = ['context7'];
	managed.mcp.local[fs.realpathSync(repo)] = ['sentry'];
	managed.mcp.local['/somewhere/else'] = ['axiom'];
	const ls = L(servers({ context7: true }), servers({ context7: false }));
	const want = desired(ls);
	assert.ok(!want.some((w) => w.id === 'context7'), 'the pass config drops it');
	const userIds = userEnabled(ls);
	assert.deepEqual(userIds, ['context7']);
	const removes = (w, extra = {}) => planSync({ want: w, managed, listing: '', repo, ...extra }).remove;
	assert.deepEqual(removes(want, { userIds }), [{ id: 'sentry', scope: 'project' }], 'context7 stays; axiom belongs to another repository');
	for (const copy of [[...want], want.filter(Boolean), structuredClone(want), want.slice(), Array.from(want)])
		assert.deepEqual(removes(copy, { userIds }), [{ id: 'sentry', scope: 'project' }], 'a copy of the array changes nothing');
	assert.deepEqual(
		removes(want).map((r) => r.scope),
		['project'],
		'without userIds no user-scope server is removed at all',
	);
	// turning it off in the user layer is what removes it
	const off = L({}, servers({ context7: false }));
	assert.deepEqual(removes(desired(off), { userIds: userEnabled(off) }), [
		{ id: 'context7', scope: 'user' },
		{ id: 'sentry', scope: 'project' },
	]);
});

test('applySync records only commands that succeeded, runs local-scope commands in the repository, and writes managed.json atomically', () => {
	const fake = fakeClaude();
	const stateDirectory = state();
	const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-repo-')));
	const env = { ...fake.env, DF_STATE_DIR: stateDirectory, DF_FAKE_FAIL: 'sentry' };
	const plan = {
		add: [
			{ id: 'sentry', scope: 'user' },
			{ id: 'context7', scope: 'user' },
			{ id: '21st', scope: 'project' },
		],
		remove: [],
		skip: [],
	};
	const result = applySync(plan, { repo, env });
	assert.deepEqual(
		result.done.map((d) => `${d.action} ${d.id}@${d.scope}`),
		['add context7@user', 'add 21st@project'],
	);
	assert.equal(result.failed[0].id, 'sentry');
	assert.match(result.failed[0].error, /boom sentry/);
	const managed = readManaged({ DF_STATE_DIR: stateDirectory });
	assert.deepEqual(managed.mcp.user, ['context7']);
	assert.deepEqual(managed.mcp.local[repo], ['21st']);
	assert.deepEqual(
		fs.readdirSync(stateDirectory).filter((f) => f.endsWith('.tmp')),
		[],
		'no temporary file is left behind',
	);
	const calls = fake.calls();
	assert.deepEqual(calls.at(-1).args.slice(0, 5), ['mcp', 'add-json', '-s', 'local', '21st']);
	assert.equal(fs.realpathSync(calls.at(-1).cwd), repo);
	assert.deepEqual(JSON.parse(calls.at(-1).args[5]), catalog()['21st'].config);
	// a failed removal stays recorded; a successful one does not
	const removal = applySync(
		{ add: [], remove: [{ id: 'context7', scope: 'user' }], skip: [] },
		{ repo, env: { ...env, DF_FAKE_FAIL: 'context7' } },
	);
	assert.equal(removal.failed.length, 1);
	assert.deepEqual(readManaged({ DF_STATE_DIR: stateDirectory }).mcp.user, ['context7']);
	applySync({ add: [], remove: [{ id: 'context7', scope: 'user' }], skip: [] }, { repo, env });
	assert.deepEqual(readManaged({ DF_STATE_DIR: stateDirectory }).mcp.user, []);
	assert.equal(managedFile({ DF_STATE_DIR: stateDirectory }), path.join(stateDirectory, 'managed.json'));
});

test('applySync refuses the jira server until the launcher exists, and gives Claude the absolute launcher path', () => {
	const fake = fakeClaude();
	const env = { ...fake.env, DF_STATE_DIR: state() };
	const plan = { add: [{ id: 'jira', scope: 'user' }], remove: [], skip: [] };
	const refused = applySync(plan, { repo: os.tmpdir(), env });
	assert.deepEqual(refused.done, []);
	assert.equal(refused.failed[0].error, 'dev-factory install --apply first: the jira server runs through the launcher');
	assert.deepEqual(fake.calls(), [], 'claude was not run');
	fs.mkdirSync(path.dirname(launcherPath(env)), { recursive: true });
	fs.writeFileSync(launcherPath(env), '#!/bin/sh\n');
	const ok = applySync(plan, { repo: os.tmpdir(), env });
	assert.equal(ok.done.length, 1);
	const json = JSON.parse(fake.calls().at(-1).args[5]);
	assert.equal(json.command, path.join(env.DF_STATE_DIR, 'bin', 'dev-factory'));
	assert.deepEqual(json.args, ['jira-mcp']);
	assert.deepEqual(json.env, { JIRA_EMAIL: '${JIRA_EMAIL:-}', JIRA_API_TOKEN: '${JIRA_API_TOKEN:-}' });
});

test('serverConfig keeps variable references and only turns the launcher reference into an absolute path', () => {
	const env = { DF_STATE_DIR: '/state/dir' };
	assert.equal(serverConfig('jira', catalog(), env).command, '/state/dir/bin/dev-factory');
	assert.doesNotMatch(JSON.stringify(serverConfig('jira', catalog(), env)), /~|DF_LAUNCHER/);
	assert.deepEqual(serverConfig('context7', catalog(), env), catalog().context7.config);
	assert.equal(serverConfig('github', catalog(), env).headers.Authorization, 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN:-}');
	assert.throws(() => serverConfig('nope', catalog(), env), /unknown MCP server/);
	serverConfig('context7', catalog(), env).args.push('x');
	assert.equal(catalog().context7.config.args.includes('x'), false, 'the catalog is not changed');
});

test('the legacy .mcp.json writer starts a jira entry through the absolute launcher too', () => {
	const file = tmp();
	enable(['jira'], file, catalog(), { DF_STATE_DIR: '/state/dir' });
	assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.jira.command, '/state/dir/bin/dev-factory');
});

test('writePassConfig writes every wanted server with variable references intact, tab-indented, and copies nothing from a legacy file', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-pass-'));
	const file = path.join(dir, 'sub', 'mcp.json');
	const legacyFile = path.join(dir, '.mcp.json');
	fs.writeFileSync(legacyFile, JSON.stringify({ mcpServers: { context7: { command: 'old' } } }));
	const env = { DF_STATE_DIR: '/state/dir' };
	const want = [
		{ id: 'context7', scope: 'user', required: false },
		{ id: 'github', scope: 'user', required: false },
		{ id: 'jira', scope: 'user', required: false },
	];
	const out = writePassConfig({ want, cat: catalog(), env, file, legacyFile, listing: '', managed: noManaged() });
	assert.equal(out.file, file);
	assert.equal(out.strict, true, 'a legacy file holding only what the wanted set writes leaves the pass strict');
	assert.equal(out.reason, '');
	const text = fs.readFileSync(file, 'utf8');
	assert.match(text, /^\{\n\t"mcpServers": \{\n\t\t"context7"/);
	const doc = JSON.parse(text);
	assert.deepEqual(Object.keys(doc.mcpServers).sort(), ['context7', 'github', 'jira']);
	assert.deepEqual(doc.mcpServers.context7, catalog().context7.config, 'the wanted config wins a name clash');
	assert.equal(doc.mcpServers.github.headers.Authorization, 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN:-}');
	assert.equal(doc.mcpServers.jira.command, '/state/dir/bin/dev-factory');
});

test('writePassConfig is not strict when a wanted server is available only from outside the file, and says which', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-pass-'));
	const file = path.join(dir, 'mcp.json');
	const listing = ['claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected', 'context7: npx -y @upstash/context7-mcp - ✔ Connected'].join(
		'\n',
	);
	const want = [
		{ id: 'notion', scope: 'user', required: false },
		{ id: 'context7', scope: 'user', required: false },
		{ id: 'sentry', scope: 'project', required: false },
	];
	const managed = noManaged();
	managed.mcp.user = ['context7'];
	const out = writePassConfig({ want, cat: catalog(), env: {}, file, listing, managed });
	assert.equal(out.strict, false);
	assert.match(out.reason, /^notion is available only from outside the generated file/);
	assert.doesNotMatch(out.reason, /context7|sentry/);
	assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers), ['context7', 'sentry']);
	// a hand-made entry of that name in the legacy file is written to the file, so it is not outside it
	const legacyFile = path.join(dir, '.mcp.json');
	fs.writeFileSync(legacyFile, JSON.stringify({ mcpServers: { notion: { command: 'mine' } } }));
	const again = writePassConfig({ want, cat: catalog(), env: {}, file, listing, legacyFile, managed });
	assert.equal(again.strict, true);
});

test('writePassConfig never copies a legacy .mcp.json entry; they make the pass non-strict and are named', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-pass-'));
	const file = path.join(dir, 'mcp.json');
	const legacyFile = path.join(dir, '.mcp.json');
	fs.writeFileSync(
		legacyFile,
		JSON.stringify({
			mcpServers: {
				'with-token': { command: 'x', env: { API_TOKEN: 'sk-literal-secret' } },
				'with-default': { command: 'y', env: { API_TOKEN: '${API_TOKEN:-sk-live-default}' } },
				'in-url': { type: 'http', url: 'https://x.example/mcp?key=url-secret-key' },
				'in-args': { command: 'z', args: ['--api-key', 'args-secret-key'] },
				'by-reference': { command: 'w', env: { API_TOKEN: '${API_TOKEN}' } },
				context7: { command: 'old', env: { CONTEXT7_API_KEY: 'literal-but-replaced' } },
			},
		}),
	);
	const want = [{ id: 'context7', scope: 'user', required: false }];
	const out = writePassConfig({ want, cat: catalog(), env: {}, file, legacyFile, listing: '', managed: noManaged() });
	const text = fs.readFileSync(file, 'utf8');
	assert.doesNotMatch(
		text,
		/sk-literal-secret|sk-live-default|url-secret-key|args-secret-key|literal-but-replaced/,
		'no legacy value reaches the file',
	);
	assert.deepEqual(Object.keys(JSON.parse(text).mcpServers), ['context7']);
	assert.equal(out.strict, false);
	assert.equal(
		out.reason,
		'with-token, with-default, in-url, in-args, by-reference come from .mcp.json; Claude loads them itself (run dev-factory mcp migrate)',
	);
	// one entry reads in the singular
	fs.writeFileSync(legacyFile, JSON.stringify({ mcpServers: { 'my-tool': { command: 'mine' } } }));
	assert.match(
		writePassConfig({ want, cat: catalog(), env: {}, file, legacyFile, listing: '', managed: noManaged() }).reason,
		/^my-tool comes from \.mcp\.json;/,
	);
});

test('secretsReport names what each wanted server needs without values', () => {
	const stateDirectory = state();
	fs.writeFileSync(path.join(stateDirectory, '.env.local'), 'JIRA_EMAIL=a@example.com\n');
	const env = { DF_STATE_DIR: stateDirectory, GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_secretvalue' };
	const want = ['jira', 'github', 'context7', 'playwright'].map((id) => ({ id, scope: 'user', required: false }));
	const report = secretsReport({ want, cat: catalog(), env });
	const by = Object.fromEntries(report.map((r) => [r.name, r]));
	assert.deepEqual(by.JIRA_EMAIL, { name: 'JIRA_EMAIL', state: 'set', neededBy: ['jira'], optional: false });
	assert.deepEqual(by.JIRA_API_TOKEN, { name: 'JIRA_API_TOKEN', state: 'empty', neededBy: ['jira'], optional: false });
	assert.deepEqual(by.GITHUB_PERSONAL_ACCESS_TOKEN, { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', state: 'set', neededBy: ['github'], optional: false });
	assert.deepEqual(by.CONTEXT7_API_KEY, { name: 'CONTEXT7_API_KEY', state: 'empty', neededBy: ['context7'], optional: true });
	assert.deepEqual(by.CLAUDE_CODE_OAUTH_TOKEN, { name: 'CLAUDE_CODE_OAUTH_TOKEN', state: 'empty', neededBy: ['unattended runs'], optional: true });
	assert.equal(report.length, 5);
	assert.doesNotMatch(JSON.stringify(report), /ghp_secretvalue|a@example/);
});

test('recommend counts a Jira server Claude already has, from a connector or a user entry, and one the settings turned on', () => {
	const cfg = merge(load(), { tasks: { source: 'jira' } });
	const empty = () => fs.mkdtempSync(path.join(os.tmpdir(), 'df-rec-'));
	const jiraOf = (ids) => ids.filter((id) => ['jira', 'atlassian'].includes(id));
	const creds = { JIRA_EMAIL: 'a@example.com', JIRA_API_TOKEN: 'tok' };
	const connector = 'claude.ai Atlassian: https://mcp.atlassian.com/v1/mcp - ✔ Connected';
	assert.deepEqual(jiraOf(recommend(cfg, catalog(), { env: { ...creds }, dir: empty(), listing: connector })), ['atlassian']);
	assert.deepEqual(jiraOf(recommend(cfg, catalog(), { env: {}, dir: empty(), listing: 'jira: x - ✔ Connected' })), ['jira']);
	const turnedOn = merge(cfg, servers({ atlassian: true }));
	assert.deepEqual(jiraOf(recommend(turnedOn, catalog(), { env: { ...creds }, dir: empty() })), ['atlassian']);
});

test('planLegacyMigration adopts an entry equal to the catalog’s (ignoring a variable’s default) and keeps the person’s own', () => {
	const file = tmp();
	fs.writeFileSync(
		file,
		JSON.stringify({
			mcpServers: {
				sentry: catalog().sentry.config,
				context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' } },
				'my-tool': { command: 'mine' },
				playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
			},
		}),
	);
	assert.deepEqual(planLegacyMigration(file, catalog()), [
		{ id: 'sentry', action: 'adopt' },
		{ id: 'context7', action: 'adopt' },
		{ id: 'my-tool', action: 'keep' },
		{ id: 'playwright', action: 'keep' },
	]);
});

test('managed.json is read tolerantly and written whole; a corrupt one is warned about and kept as managed.json.bad', () => {
	const env = { DF_STATE_DIR: state() };
	assert.deepEqual(readManaged(env), noManaged());
	assert.equal(fs.existsSync(`${managedFile(env)}.bad`), false, 'a missing file is not a corrupt one');
	fs.writeFileSync(managedFile(env), '{ not json');
	const write = process.stderr.write;
	let warned = '';
	process.stderr.write = (chunk) => ((warned += chunk), true);
	try {
		assert.deepEqual(readManaged(env), noManaged());
	} finally {
		process.stderr.write = write;
	}
	assert.match(warned, /managed\.json is not valid JSON.*managed\.json\.bad/);
	assert.equal(fs.readFileSync(`${managedFile(env)}.bad`, 'utf8'), '{ not json');
	writeManaged(env, noManaged());
	assert.equal(fs.readFileSync(`${managedFile(env)}.bad`, 'utf8'), '{ not json', 'the next write leaves the copy alone');
	writeManaged(env, { ...noManaged(), plugins: { user: ['a'], local: { '/r': ['b'] } } });
	assert.deepEqual(readManaged(env).plugins, { user: ['a'], local: { '/r': ['b'] } });
});

test('the doctor counts servers the settings turn on like those in .mcp.json', () => {
	const file = tmp();
	const want = [
		{ id: 'context7', scope: 'user', required: false },
		{ id: 'sentry', scope: 'project', required: false },
	];
	const listing = ['context7: npx x - ✔ Connected', 'sentry: https://mcp.sentry.dev/mcp - ! Needs authentication'].join('\n');
	const text = doctorLines(file, listing, catalog(), { want })
		.map((l) => `${l.level}: ${l.text}`)
		.join('\n');
	assert.match(text, /ok: MCP context7 connected \(all projects\)/);
	assert.match(text, /warn: MCP sentry needs a login/);
	assert.doesNotMatch(text, /comes from/, 'what the factory added is not reported as coming from elsewhere');
	assert.doesNotMatch(text, /no MCP servers in use/);
	const missing = doctorLines(file, '', catalog(), { want: [{ id: 'sentry', scope: 'project', required: false }] });
	assert.match(missing.find((l) => /sentry/.test(l.text)).text, /on \(this project\) but not started \(run dev-factory mcp sync/);
});

test('planLegacyMigration adopts the factory’s own jira entry: the one the legacy enable wrote and the one jira-mcp-config wrote', async () => {
	const { entry } = await import('../scripts/jira-mcp-config.mjs');
	const env = { DF_STATE_DIR: '/state/dir' };
	const written = tmp();
	enable(['jira'], written, catalog(), env);
	assert.deepEqual(planLegacyMigration(written, catalog(), env), [{ id: 'jira', action: 'adopt' }]);
	assert.deepEqual(
		planLegacyMigration(written, catalog(), { DF_STATE_DIR: '/another' }),
		[{ id: 'jira', action: 'keep' }],
		'another launcher path is not this one',
	);
	for (const site of [undefined, 'example.atlassian.net']) {
		const old = tmp();
		fs.writeFileSync(old, JSON.stringify({ mcpServers: { jira: entry({ site }) } }));
		assert.deepEqual(planLegacyMigration(old, catalog(), env), [{ id: 'jira', action: 'adopt' }], String(site));
	}
	const own = tmp();
	fs.writeFileSync(own, JSON.stringify({ mcpServers: { jira: { ...entry(), env: { JIRA_API_TOKEN: 'abc' } } } }));
	assert.deepEqual(planLegacyMigration(own, catalog(), env), [{ id: 'jira', action: 'keep' }], 'a token in it makes it the person’s own');
});

// ---- the command line ----

const MCP = new URL('../scripts/mcp.mjs', import.meta.url).pathname;
function sandbox() {
	const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-mcp-repo-')));
	execFileSync('git', ['init', '-q', repo]);
	const fake = fakeClaude();
	const stateDirectory = state();
	const env = {
		...process.env,
		...fake.env,
		DF_STATE_DIR: stateDirectory,
		DF_MCP_LISTING: path.join(stateDirectory, 'listing.txt'),
		DF_MCP_FILE: path.join(repo, '.mcp.json'),
	};
	delete env.DF_CONFIG;
	fs.writeFileSync(env.DF_MCP_LISTING, '');
	const run = (...args) => spawnSync('node', [MCP, ...args], { cwd: repo, env, encoding: 'utf8' });
	const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
	return { repo, fake, env, stateDirectory, run, read };
}

test('CLI: disable playwright exits 1 and says it is required', () => {
	const { run } = sandbox();
	const r = run('disable', 'playwright');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /mcp: playwright is required; change its scope with enable --user or --project/);
});

test('CLI: enable records the server in the layer of its scope, removes it from the other, and applies it through claude', () => {
	const { run, read, repo, fake, stateDirectory } = sandbox();
	const r = run('enable', 'sentry', 'context7');
	assert.equal(r.status, 0, r.stderr);
	// defaults: sentry is project scope, context7 user scope
	assert.deepEqual(read(path.join(repo, '.devfactory', 'config.json')).mcp.servers, { sentry: true });
	assert.deepEqual(read(path.join(stateDirectory, 'config.json')).mcp.servers, { context7: true });
	const added = fake
		.calls()
		.filter((c) => c.args[1] === 'add-json')
		.map((c) => c.args.slice(2, 5).join(' '));
	assert.ok(added.includes('-s local sentry') && added.includes('-s user context7'), added.join('|'));
	assert.ok(added.includes('-s user playwright'), 'the required server is applied too');
	assert.deepEqual(read(path.join(stateDirectory, 'managed.json')).mcp.user.sort(), ['context7', 'playwright']);
	// moving a server changes layers: the other layer loses the key
	assert.equal(run('enable', 'sentry', '--user').status, 0);
	assert.deepEqual(read(path.join(stateDirectory, 'config.json')).mcp.servers, { context7: true, sentry: true });
	assert.equal(read(path.join(repo, '.devfactory', 'config.json')).mcp?.servers?.sentry, undefined);
	const managed = read(path.join(stateDirectory, 'managed.json')).mcp;
	assert.ok(managed.user.includes('sentry') && !(managed.local[repo] ?? []).includes('sentry'));
	// disabling turns it off in Claude too, but only what the factory added
	assert.equal(run('disable', 'sentry').status, 0);
	assert.ok(!read(path.join(stateDirectory, 'managed.json')).mcp.user.includes('sentry'));
	assert.ok(
		fake.calls().some((c) => c.args.join(' ') === 'mcp remove -s user sentry'),
		'removed from Claude',
	);
});

test('CLI: sync --dry-run changes nothing, and write-config prints the Claude arguments for the pass', () => {
	const { run, read, repo, fake, env, stateDirectory } = sandbox();
	const dry = run('sync', '--dry-run');
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /add\s+playwright\s+\(all projects\)/);
	assert.deepEqual(fake.calls(), []);
	assert.equal(fs.existsSync(path.join(stateDirectory, 'managed.json')), false);
	// nothing wanted is outside the file: strict
	const strict = run('write-config');
	assert.equal(strict.status, 0, strict.stderr);
	assert.deepEqual(strict.stdout.trim().split('\n'), ['--strict-mcp-config', '--mcp-config', path.join(repo, '.devfactory', 'mcp.json')]);
	assert.deepEqual(Object.keys(read(path.join(repo, '.devfactory', 'mcp.json')).mcpServers), ['playwright']);
	// playwright is a user entry the person made: used as it is, so the pass is not strict and the reason is printed
	fs.writeFileSync(env.DF_MCP_LISTING, 'playwright: npx -y @playwright/mcp@latest - ✔ Connected\n');
	const loose = run('write-config');
	assert.deepEqual(loose.stdout.trim().split('\n'), ['--mcp-config', path.join(repo, '.devfactory', 'mcp.json')]);
	assert.match(loose.stderr, /^note: playwright is available only from outside the generated file/);
});

test('CLI: list shows where each server is on: user, proj, repo, ext or off', () => {
	const { run, repo, env } = sandbox();
	run('enable', 'sentry', 'context7');
	fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { axiom: catalog().axiom.config } }));
	fs.writeFileSync(env.DF_MCP_LISTING, 'sequential-thinking: npx x - ✔ Connected\n');
	const rows = Object.fromEntries(
		run('list')
			.stdout.split('\n')
			.map((l) => /^(\S+)\s+(\S+)\s/.exec(l))
			.filter(Boolean)
			.map((m) => [m[2], m[1]]),
	);
	assert.equal(rows.context7, 'user');
	assert.equal(rows.sentry, 'proj');
	assert.equal(rows.playwright, 'user', 'required: on at its default scope');
	assert.equal(rows.axiom, 'repo');
	assert.equal(rows['sequential-thinking'], 'ext');
	assert.equal(rows.notion, 'off');
});

test('CLI: connect enables the recommended servers at their default scope and reports them; secrets prints names and states only', () => {
	const { run, read, stateDirectory } = sandbox();
	const r = run('connect');
	assert.equal(r.status, 0, r.stderr);
	assert.ok(read(path.join(stateDirectory, 'config.json')).mcp.servers.context7 === true);
	assert.match(r.stdout, /playwright\s+not started/);
	const secrets = run('secrets');
	assert.equal(secrets.status, 0, secrets.stderr);
	assert.match(secrets.stdout, /CONTEXT7_API_KEY\s+empty\s+context7\s+\(optional\)/);
	assert.match(secrets.stdout, /CLAUDE_CODE_OAUTH_TOKEN\s+empty\s+unattended runs\s+\(optional\)/);
});

test('CLI: migrate adopts a legacy .mcp.json entry that matches the catalog and keeps one that does not', () => {
	const { run, read, repo } = sandbox();
	const legacy = path.join(repo, '.mcp.json');
	fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { sentry: catalog().sentry.config, 'my-tool': { command: 'mine' } } }));
	const plan = run('migrate');
	assert.equal(plan.status, 0, plan.stderr);
	assert.match(plan.stdout, /adopt\s+sentry/);
	assert.match(plan.stdout, /keep\s+my-tool/);
	assert.deepEqual(Object.keys(read(legacy).mcpServers), ['sentry', 'my-tool'], 'without --apply nothing changes');
	const done = run('migrate', '--apply');
	assert.equal(done.status, 0, done.stderr);
	assert.equal(read(path.join(repo, '.devfactory', 'config.json')).mcp.servers.sentry, true);
	assert.deepEqual(read(legacy).mcpServers, { 'my-tool': { command: 'mine' } });
	// the last entry gone: the file goes too
	fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { axiom: catalog().axiom.config } }));
	run('migrate', '--apply');
	assert.equal(fs.existsSync(legacy), false);
	assert.equal(read(path.join(repo, '.devfactory', 'config.json')).mcp.servers.axiom, true);
});

test('CLI: from a linked worktree the local scope is the main checkout’s', () => {
	const { repo, run, fake, env, stateDirectory, read } = sandbox();
	execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
	const worktree = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-wt-'))), 'wt');
	execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', worktree]);
	assert.equal(fs.realpathSync(mainCheckout(worktree)), repo);
	assert.equal(fs.realpathSync(mainCheckout(repo)), repo);
	assert.equal(mainCheckout(os.tmpdir()), null);
	fs.mkdirSync(path.join(repo, '.devfactory'));
	fs.writeFileSync(path.join(repo, '.devfactory', 'config.json'), JSON.stringify({ mcp: { servers: { sentry: true } } }));
	const r = spawnSync('node', [MCP, 'sync'], {
		cwd: worktree,
		env: { ...env, DF_CONFIG: path.join(repo, '.devfactory', 'config.json') },
		encoding: 'utf8',
	});
	assert.equal(r.status, 0, r.stderr);
	const local = fake.calls().find((c) => c.args.join(' ').startsWith('mcp add-json -s local sentry'));
	assert.ok(local, 'sentry was added at local scope');
	assert.equal(fs.realpathSync(local.cwd), repo, 'claude ran in the main checkout');
	assert.deepEqual(read(path.join(stateDirectory, 'managed.json')).mcp.local[repo], ['sentry']);
	assert.equal(run('sync', '--dry-run').status, 0);
});

test('CLI: enable checks every id before it writes anything', () => {
	const { run, repo, stateDirectory, fake } = sandbox();
	const r = run('enable', 'context7', 'nope');
	assert.equal(r.status, 1);
	assert.match(r.stderr, /unknown MCP server 'nope'/);
	assert.equal(fs.existsSync(path.join(stateDirectory, 'config.json')), false, 'context7 was not written');
	assert.equal(fs.existsSync(path.join(repo, '.devfactory', 'config.json')), false);
	assert.deepEqual(fake.calls(), []);
});

test('CLI: from a linked worktree the settings are read from the main checkout, so sync removes nothing it should keep (no DF_CONFIG)', () => {
	const { repo, fake, env, stateDirectory, read } = sandbox();
	execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
	const worktree = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-wt-'))), 'wt');
	execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', worktree]);
	assert.equal(fs.existsSync(path.join(worktree, '.devfactory')), false, 'the worktree has no settings of its own');
	fs.mkdirSync(path.join(repo, '.devfactory'));
	fs.writeFileSync(path.join(repo, '.devfactory', 'config.json'), JSON.stringify({ mcp: { servers: { sentry: true } } }));
	fs.writeFileSync(path.join(stateDirectory, 'managed.json'), JSON.stringify({ mcp: { user: ['playwright'], local: { [repo]: ['sentry'] } } }));
	const fromWorktree = (...args) => spawnSync('node', [MCP, ...args], { cwd: worktree, env, encoding: 'utf8' });
	const dry = fromWorktree('sync', '--dry-run');
	assert.equal(dry.status, 0, dry.stderr);
	assert.doesNotMatch(dry.stdout, /remove/);
	const r = fromWorktree('sync');
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(
		fake.calls().filter((c) => c.args[1] === 'remove'),
		[],
		'nothing was removed',
	);
	assert.deepEqual(read(path.join(stateDirectory, 'managed.json')).mcp.local[repo], ['sentry']);
	// the pass config is wanted from the same settings
	const out = fromWorktree('write-config');
	assert.equal(out.status, 0, out.stderr);
	assert.deepEqual(Object.keys(read(path.join(repo, '.devfactory', 'mcp.json')).mcpServers).sort(), ['playwright', 'sentry']);
});

test('CLI: enable, disable and connect from a linked worktree write the main checkout’s settings, and write-config reads its .mcp.json', () => {
	const { repo, env, read, run } = sandbox();
	execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
	const worktree = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-wt-'))), 'wt');
	execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', worktree]);
	const own = { ...env };
	delete own.DF_MCP_FILE;
	const fromWorktree = (...args) => spawnSync('node', [MCP, ...args], { cwd: worktree, env: own, encoding: 'utf8' });
	const mine = path.join(repo, '.devfactory', 'config.json');
	const enabled = fromWorktree('enable', 'sentry', '--project');
	assert.equal(enabled.status, 0, enabled.stderr);
	assert.equal(read(mine).mcp.servers.sentry, true, 'the main checkout holds the setting');
	assert.equal(fs.existsSync(path.join(worktree, '.devfactory', 'config.json')), false, 'the worktree gets none of its own');
	assert.match(run('list').stdout, /^proj\s+sentry/m, 'and a run from the main checkout sees it');
	// moving it to the user layer takes the key out of the main checkout's project layer
	assert.equal(fromWorktree('enable', 'sentry', '--user').status, 0);
	assert.equal(read(mine).mcp?.servers?.sentry, undefined);
	assert.equal(fromWorktree('enable', 'axiom', '--project').status, 0);
	assert.equal(read(mine).mcp.servers.axiom, true);
	assert.equal(fromWorktree('disable', 'axiom', '--project').status, 0);
	assert.equal(read(mine).mcp?.servers?.axiom, undefined, 'disable acts on the same file');
	assert.equal(fromWorktree('connect').status, 0);
	assert.equal(fs.existsSync(path.join(worktree, '.devfactory', 'config.json')), false, 'connect writes there too');
	// a legacy .mcp.json in the main checkout keeps the pass from being strict, whichever folder it starts from
	fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } } }));
	const loose = fromWorktree('write-config');
	assert.equal(loose.status, 0, loose.stderr);
	assert.doesNotMatch(loose.stdout, /--strict-mcp-config/);
	assert.match(loose.stderr, /mine comes from \.mcp\.json/);
});

test('factory-settings opens the hosts and allows the tools of the servers the settings turn on', () => {
	const file = tmp();
	const want = [
		{ id: 'sentry', scope: 'project', required: false },
		{ id: 'context7', scope: 'user', required: false },
	];
	const s = build({ cfg: load(), mcpFile: file, want });
	assert.ok(s.sandbox.network.allowedDomains.includes('mcp.sentry.dev'));
	assert.ok(s.sandbox.network.allowedDomains.includes('context7.com'));
	assert.ok(s.permissions.allow.includes('mcp__sentry') && s.permissions.allow.includes('mcp__plugin_dev-factory_context7'));
	const none = build({ cfg: load(), mcpFile: file, want: [] });
	assert.equal(none.sandbox.network.allowedDomains.includes('mcp.sentry.dev'), false);
	assert.equal(none.permissions.allow.includes('mcp__sentry'), false);
	// the legacy file and servers from elsewhere still count
	enable(['axiom'], file);
	const both = build({ cfg: load(), mcpFile: file, want, external: ['notion'] });
	for (const rule of ['mcp__axiom', 'mcp__sentry', 'mcp__notion']) assert.ok(both.permissions.allow.includes(rule), rule);
});

test('the factory-settings command line includes the servers the settings turn on', () => {
	const { run, repo, read, env } = sandbox();
	assert.equal(run('enable', 'sentry', '--project').status, 0);
	const out = path.join(repo, 'settings.json');
	const r = spawnSync('node', [new URL('../scripts/factory-settings.mjs', import.meta.url).pathname, out], { cwd: repo, env, encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	const settings = read(out);
	assert.ok(settings.sandbox.network.allowedDomains.includes('mcp.sentry.dev'));
	assert.ok(settings.permissions.allow.includes('mcp__sentry'));
});

test('secretLines: ok when set, FAIL only for a required server’s non-optional secret, a warning for any other that is empty', () => {
	const cat = {
		core: { secrets: ['CORE_TOKEN'], config: { type: 'http', headers: { Authorization: 'Bearer ${CORE_TOKEN:-}' } } },
		extra: { secrets: ['EXTRA_KEY'], secretsOptional: true, config: { command: 'x' } },
		other: { secrets: ['OTHER_TOKEN'], config: { command: 'x' } },
	};
	const want = [
		{ id: 'core', scope: 'user', required: true },
		{ id: 'extra', scope: 'user', required: true },
		{ id: 'other', scope: 'user', required: false },
	];
	const rows = [
		{ name: 'CORE_TOKEN', state: 'empty', neededBy: ['core'], optional: false },
		{ name: 'EXTRA_KEY', state: 'empty', neededBy: ['extra'], optional: true },
		{ name: 'OTHER_TOKEN', state: 'empty', neededBy: ['other'], optional: false },
	];
	const lines = secretLines({ rows, want, cat });
	assert.deepEqual(
		lines.map((l) => l.level),
		['fail', 'warn', 'warn'],
	);
	assert.equal(lines[0].text, 'CORE_TOKEN empty: needed by core');
	assert.equal(lines[1].text, 'EXTRA_KEY empty: needed by extra (optional)');
	assert.equal(secretLines({ rows, want, cat, lenient: true })[0].level, 'warn', '--lenient turns the failure into a warning');
	const set = rows.map((r) => ({ ...r, state: 'set' }));
	assert.deepEqual(secretLines({ rows: set, want, cat })[2], { level: 'ok', text: 'OTHER_TOKEN set (other)' });
});

test('secretLines warns when a token read by Claude itself is kept only in .env.local, and not for one a launcher reads', () => {
	const cat = {
		direct: { secrets: ['DIRECT_TOKEN'], config: { type: 'http', headers: { Authorization: 'Bearer ${DIRECT_TOKEN:-}' } } },
		launched: { secrets: ['LAUNCHED_TOKEN'], config: { type: 'stdio', command: '${DF_LAUNCHER:-~/.dev-factory/bin/dev-factory}', args: ['x'] } },
	};
	const want = [
		{ id: 'direct', scope: 'user', required: false },
		{ id: 'launched', scope: 'user', required: false },
	];
	const rows = [
		{ name: 'DIRECT_TOKEN', state: 'set', neededBy: ['direct'], optional: false },
		{ name: 'LAUNCHED_TOKEN', state: 'set', neededBy: ['launched'], optional: false },
	];
	const only = secretLines({ rows, want, cat, shell: new Set() });
	assert.equal(only[0].level, 'warn');
	assert.match(only[0].text, /DIRECT_TOKEN is set only in .*\.env\.local.*export it in the shell that starts claude/);
	assert.equal(only[1].level, 'ok');
	assert.equal(secretLines({ rows, want, cat, shell: new Set(['DIRECT_TOKEN']) })[0].level, 'ok');
	assert.equal(secretLines({ rows, want, cat })[0].level, 'ok', 'no record of the shell: nothing to compare');
});

test('CLI: secrets --lines prints doctor lines for the wanted servers and never a value', () => {
	const { run, repo, env } = sandbox();
	delete env.GITHUB_PERSONAL_ACCESS_TOKEN;
	assert.equal(run('enable', 'github', '--user').status, 0);
	const empty = run('secrets', '--lines');
	assert.equal(empty.status, 0, empty.stderr);
	assert.match(empty.stdout, /^warn +GITHUB_PERSONAL_ACCESS_TOKEN empty: needed by github$/m);
	fs.writeFileSync(path.join(env.DF_STATE_DIR, '.env.local'), 'GITHUB_PERSONAL_ACCESS_TOKEN=abc123\n');
	const set = spawnSync('node', [MCP, 'secrets', '--lines'], { cwd: repo, env: { ...env, DF_SHELL_ENV_NAMES: 'PATH HOME' }, encoding: 'utf8' });
	assert.match(set.stdout, /GITHUB_PERSONAL_ACCESS_TOKEN is set only in/);
	assert.doesNotMatch(set.stdout, /abc123/);
});
