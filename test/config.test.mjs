import assert from 'node:assert/strict';
import { test } from 'node:test';
import { get, load, validate } from '../scripts/config.mjs';

test('shipped config is valid', () => assert.deepEqual(validate(load()), []));

test('validate names missing keys and bad project keys', () => {
	const c = load();
	delete c.caps.maxFixRounds;
	c.jira.projects = ['oapp'];
	const p = validate(c);
	assert.ok(p.includes('missing caps.maxFixRounds'));
	assert.ok(p.some((x) => /upper-case/.test(x)));
});

test('environment overrides keep the base type', () => {
	const config = load();
	assert.equal(get('caps.maxConcurrent', { config, env: { DF_MAX_CONCURRENT: '2' } }), 2);
	assert.deepEqual(get('jira.projects', { config, env: { DF_JIRA_PROJECTS: 'A1, B2' } }), ['A1', 'B2']);
	assert.equal(get('models.builder', { config, env: {} }), 'sonnet');
});

test('new blocks are validated', () => {
	const c = load();
	c.review.specialistAxes.bogus = ['x'];
	c.debug.maxDebugRounds = -1;
	c.telemetry.scrubPatterns = ['('];
	delete c.environments.prod;
	const p = validate(c);
	assert.ok(p.some((x) => /specialistAxes\.bogus/.test(x)));
	assert.ok(p.includes('debug.maxDebugRounds must be a non-negative integer'));
	assert.ok(p.some((x) => /invalid pattern/.test(x)));
	assert.ok(p.includes('missing environments.prod'));
});

test('resume cap overrides as a number', () => {
	assert.equal(get('caps.maxResumes', { config: load(), env: { DF_MAX_RESUMES: '3' } }), 3);
});

test('status names, done set and bug types are configured for the real workflows', () => {
	const c = load();
	assert.equal(c.jira.statuses.peerReview, 'Peer review');
	assert.ok(c.jira.doneStatuses.includes('UAT') && c.jira.doneStatuses.includes('Ready for Release'));
	assert.ok(c.jira.bugTypes.includes('Bug - Subtask') && c.jira.bugTypes.includes('Production - Bug'));
	assert.equal(c.git.branchTypes['Bug - Subtask'], 'fix');
	c.jira.doneStatuses = [];
	assert.ok(validate(c).some((x) => /doneStatuses must be a non-empty list/.test(x)));
});

test('every remote MCP host the plugin registers is allowed through the scheduled sandbox', async () => {
	const { readFileSync } = await import('node:fs');
	const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
	const allowed = read('settings.factory.json').sandbox.network.allowedDomains;
	const hosts = Object.values(read('.mcp.json').mcpServers)
		.filter((s) => s.url)
		.map((s) => new URL(s.url).hostname);
	const ok = (h) => allowed.some((d) => d === h || (d.startsWith('*.') && h.endsWith(d.slice(1))));
	for (const h of hosts) assert.equal(ok(h), true, `${h} is not in sandbox.network.allowedDomains`);
	// stdio servers fetch their own packages and docs from these hosts
	for (const h of ['context7.com', 'registry.npmjs.org']) assert.equal(ok(h), true, h);
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
