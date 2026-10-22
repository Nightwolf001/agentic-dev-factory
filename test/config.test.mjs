import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findRepoConfig, get, load, merge, validate } from '../scripts/config.mjs';

test('shipped config is valid', () => assert.deepEqual(validate(load()), []));

test('the shipped defaults name no organisation, site or project', () => {
	const text = fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8');
	assert.doesNotMatch(text, /olarm|atlassian\.net|@/i);
	const c = load();
	assert.equal(c.sources.jira.site, null);
	assert.deepEqual(c.sources.jira.projects, []);
	assert.equal(c.git.baseBranch, null, 'the base branch is the repository default unless configured');
	assert.deepEqual(c.pr.areaLabels, []);
});

test('the default task source needs no account: local files', () => {
	assert.equal(load().tasks.source, 'local');
	assert.deepEqual(validate(load()), []);
});

test('validate names missing keys and rejects an unknown source', () => {
	const c = load();
	delete c.caps.maxFixRounds;
	c.tasks.source = 'trello';
	const p = validate(c);
	assert.ok(p.includes('missing caps.maxFixRounds'));
	assert.ok(p.some((x) => /tasks\.source must be one of local, github, notion, jira/.test(x)));
});

test('each source asks only for what it needs', () => {
	const c = load();
	c.tasks.source = 'jira';
	let p = validate(c);
	assert.ok(p.includes('missing sources.jira.site') && p.includes('missing sources.jira.cloudId') && p.includes('missing sources.jira.projects'));
	c.sources.jira = { ...c.sources.jira, site: 'example.atlassian.net', cloudId: 'abc', projects: ['app'] };
	assert.ok(validate(c).some((x) => /upper-case/.test(x)));
	c.sources.jira.projects = ['APP'];
	assert.deepEqual(validate(c), []);
	c.tasks.source = 'notion';
	p = validate(c);
	assert.ok(p.includes('missing sources.notion.databaseId'));
	c.tasks.source = 'github';
	assert.deepEqual(validate(c), [], 'github needs nothing beyond gh');
	c.sources.github.repo = 'not a repo';
	assert.ok(validate(c).some((x) => /owner\/name/.test(x)));
});

test('the repository config merges over the defaults, objects key by key and arrays whole', () => {
	const merged = merge(load(), { tasks: { source: 'github' }, pr: { areaLabels: [{ path: 'api/', label: 'api' }] }, git: { baseBranch: 'main' } });
	assert.equal(merged.tasks.source, 'github');
	assert.equal(merged.tasks.label, 'dev-factory', 'untouched keys keep their default');
	assert.deepEqual(merged.pr.areaLabels, [{ path: 'api/', label: 'api' }]);
	assert.equal(merged.git.baseBranch, 'main');
});

test('the nearest dev-factory.config.json above the working directory is found, or DF_CONFIG names one', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-cfg-'));
	const deep = path.join(root, 'a', 'b');
	fs.mkdirSync(deep, { recursive: true });
	assert.equal(findRepoConfig(deep, {}), null);
	fs.writeFileSync(path.join(root, 'dev-factory.config.json'), '{}');
	assert.equal(findRepoConfig(deep, {}), path.join(root, 'dev-factory.config.json'));
	const other = path.join(root, 'other.json');
	fs.writeFileSync(other, '{}');
	assert.equal(findRepoConfig(deep, { DF_CONFIG: other }), other);
});

test('source.* reads the active source, and DF_TASK_SOURCE switches it', () => {
	const config = load();
	assert.equal(get('source.states.inProgress', { config, env: {} }), 'in-progress');
	assert.equal(get('source.states.inProgress', { config, env: { DF_TASK_SOURCE: 'github' } }), 'df:in-progress');
	assert.equal(get('tasks.source', { config, env: { DF_TASK_SOURCE: 'notion' } }), 'notion');
});

test('environment overrides keep the base type', () => {
	const config = load();
	assert.equal(get('caps.maxConcurrent', { config, env: { DF_MAX_CONCURRENT: '2' } }), 2);
	assert.deepEqual(get('sources.jira.projects', { config, env: { DF_JIRA_PROJECTS: 'A1, B2' } }), ['A1', 'B2']);
	assert.equal(get('models.builder', { config, env: {} }), 'sonnet');
});

test('new blocks are validated', () => {
	const c = load();
	c.review.specialistAxes.bogus = ['x'];
	c.debug.maxDebugRounds = -1;
	c.telemetry.scrubPatterns = ['('];
	c.environment.type = 'vm';
	delete c.environments.dev;
	const p = validate(c);
	assert.ok(p.some((x) => /specialistAxes\.bogus/.test(x)));
	assert.ok(p.includes('debug.maxDebugRounds must be a non-negative integer'));
	assert.ok(p.some((x) => /invalid pattern/.test(x)));
	assert.ok(p.includes('environment.type must be none or compose'));
	assert.ok(p.includes('missing environments.dev'));
});

test('a compose environment names its service', () => {
	const c = load();
	c.environment = { type: 'compose', composeFile: 'c.yml', service: null };
	assert.ok(validate(c).includes('environment.service is required when environment.type is compose'));
});

test('resume cap overrides as a number', () => {
	assert.equal(get('caps.maxResumes', { config: load(), env: { DF_MAX_RESUMES: '3' } }), 3);
});

test('states, done set and bug types are configurable for any workflow', () => {
	const c = load();
	c.tasks.source = 'jira';
	c.sources.jira = { ...c.sources.jira, site: 's', cloudId: 'c', projects: ['APP'] };
	c.sources.jira.states.done = [];
	assert.ok(validate(c).some((x) => /states\.done must be a non-empty list/.test(x)));
	c.sources.jira.states.done = ['UAT', 'Done'];
	c.tasks.bugTypes = [];
	assert.ok(validate(c).some((x) => /bugTypes must be a non-empty list/.test(x)));
});

test('the placeholder key must look like a task key', () => {
	const c = load();
	c.tasks.placeholderKey = 'nokey';
	assert.ok(validate(c).some((x) => /placeholderKey/.test(x)));
});

test('every remote host an MCP server in the catalog registers is allowed through the scheduled sandbox once enabled', async () => {
	const { build } = await import('../scripts/factory-settings.mjs');
	const { catalog } = await import('../scripts/mcp.mjs');
	const cat = catalog();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-mcp-'));
	const mcpFile = path.join(dir, '.mcp.json');
	fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(cat).map(([id, s]) => [id, s.config])) }));
	const allowed = build({ cfg: load(), mcpFile, cat }).sandbox.network.allowedDomains;
	const ok = (h) => allowed.some((d) => d === h || (d.startsWith('*.') && h.endsWith(d.slice(1))));
	for (const [id, s] of Object.entries(cat)) if (s.config.url) assert.equal(ok(new URL(s.config.url).hostname), true, `${id}: ${s.config.url}`);
	// and nothing is opened for a server that is not enabled
	fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }));
	const none = build({ cfg: load(), mcpFile, cat }).sandbox.network.allowedDomains;
	assert.equal(none.includes('mcp.sentry.dev'), false);
});

test('the keys the scheduler scripts read are required, and the stall window must be a number', () => {
	const without = (path) => {
		const c = structuredClone(load());
		const keys = path.split('.');
		const last = keys.pop();
		delete keys.reduce((o, k) => o[k], c)[last];
		return c;
	};
	for (const key of ['caps.stallMinutes', 'models.effort', 'models.efforts.improver'])
		assert.ok(validate(without(key)).includes(`missing ${key}`), key);
	const bad = structuredClone(load());
	bad.caps.stallMinutes = '90m';
	assert.deepEqual(validate(bad), ['caps.stallMinutes must be a non-negative integer']);
});
