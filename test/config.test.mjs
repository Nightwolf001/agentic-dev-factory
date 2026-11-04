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

test('git.agentAttribution defaults to false and must be a boolean', () => {
	const c = load();
	assert.equal(c.git.agentAttribution, false);
	c.git.agentAttribution = 'no';
	assert.ok(validate(c).includes('git.agentAttribution must be true or false'));
});

test('environment.readyTimeout and environment.preCommit are validated, and default to 900 seconds and nothing', () => {
	const c = load();
	assert.equal(c.environment.readyTimeout, 900);
	assert.equal(c.environment.preCommit, null);
	c.environment.readyTimeout = '15m';
	c.environment.preCommit = '';
	const p = validate(c);
	assert.ok(p.includes('environment.readyTimeout must be a non-negative integer'));
	assert.ok(p.includes('environment.preCommit must be a command or null'));
});

test('blocked.agentDecides is off by default, is a boolean, and DF_AGENT_DECIDES switches it for one run', () => {
	assert.equal(get('blocked.agentDecides', { config: load(), env: {} }), false);
	assert.equal(get('blocked.agentDecides', { config: load(), env: { DF_AGENT_DECIDES: '1' } }), true);
	assert.equal(get('caps.maxDecisions', { config: load(), env: {} }), 1);
	assert.deepEqual(validate(merge(load(), { blocked: { agentDecides: true } })), []);
	assert.ok(validate(merge(load(), { blocked: { agentDecides: 'yes' } })).some((p) => p.includes('blocked.agentDecides')));
	assert.ok(validate(merge(load(), { caps: { maxDecisions: -1 } })).some((p) => p.includes('caps.maxDecisions')));
});

test('config.mjs agent prints the model and effort a role runs with, so the settings reach every dispatch', async () => {
	const { agentSettings, ROLES } = await import('../scripts/config.mjs');
	const cfg = load();
	assert.deepEqual(agentSettings('builder', { config: cfg, env: {} }), { model: 'sonnet', effort: 'high' });
	assert.deepEqual(agentSettings('researcher', { config: cfg, env: {} }), { model: 'haiku', effort: 'low' });
	assert.deepEqual(agentSettings('debugger', { config: cfg, env: {} }), { model: 'sonnet', effort: 'high' });
	const custom = merge(cfg, { models: { reviewer: 'opus', effort: 'medium', efforts: { builder: 'max' } } });
	assert.deepEqual(
		agentSettings('reviewer', { config: custom, env: {} }),
		{ model: 'opus', effort: 'medium' },
		'a role without its own effort follows models.effort',
	);
	assert.equal(agentSettings('builder', { config: custom, env: {} }).effort, 'max', 'models.efforts.<role> wins');
	assert.equal(
		agentSettings('builder', { config: cfg, env: { DF_BUILDER_MODEL: 'haiku' } }).model,
		'haiku',
		'an environment override reaches the dispatch',
	);
	for (const role of ROLES) assert.ok(agentSettings(role, { config: cfg, env: {} }).model, role);
	assert.throws(() => agentSettings('wizard', { config: cfg }), /no such agent role/);
	const { spawnSync } = await import('node:child_process');
	const r = spawnSync('node', [new URL('../scripts/config.mjs', import.meta.url).pathname, 'agent', 'reviewer'], { encoding: 'utf8' });
	assert.equal(r.status, 0);
	assert.equal(typeof JSON.parse(r.stdout).model, 'string');
	assert.equal(spawnSync('node', [new URL('../scripts/config.mjs', import.meta.url).pathname, 'agent', 'nope'], { encoding: 'utf8' }).status, 3);
	for (const f of ['tick', 'build', 'quick', 'improve', 'validate'])
		assert.match(
			fs.readFileSync(new URL(`../commands/${f}.md`, import.meta.url), 'utf8'),
			/config\.mjs" agent <role>/,
			`${f}.md passes the settings to its dispatches`,
		);
});

test('scheduler.intervalMinutes and alerts.notify are validated', () => {
	assert.equal(load().scheduler.intervalMinutes, 5);
	assert.equal(load().alerts.notify, false);
	assert.deepEqual(validate(merge(load(), { scheduler: { intervalMinutes: 5 }, alerts: { notify: true } })), []);
	for (const bad of [0, 1441, 2.5, '5'])
		assert.match(validate(merge(load(), { scheduler: { intervalMinutes: bad } })).join('\n'), /scheduler\.intervalMinutes/);
	assert.match(validate(merge(load(), { alerts: { notify: 'yes' } })).join('\n'), /alerts\.notify/);
});

test('repository skills per phase, the reviewer’s reading list and skipping commit hooks are settings with validation', () => {
	assert.deepEqual(load().repoSkills, { implement: [], qa: [], review: [], ship: [], diagnose: [] });
	assert.deepEqual(load().review.readFirst, []);
	assert.equal(load().git.skipCommitHooks, false);
	assert.deepEqual(
		validate(
			merge(load(), {
				repoSkills: { implement: ['repo-rules', 'acme:testing'] },
				review: { readFirst: ['docs/architecture.md', 'CONVENTIONS.md'] },
				git: { skipCommitHooks: true },
			}),
		),
		[],
	);
	for (const [over, re] of [
		[{ repoSkills: { deploy: ['x'] } }, /repoSkills\.deploy is not a phase/],
		[{ repoSkills: { qa: 'x' } }, /repoSkills\.qa must be a list/],
		[{ repoSkills: { qa: ['a b'] } }, /repoSkills\.qa must be a list/],
		[{ repoSkills: { qa: ['x; rm'] } }, /repoSkills\.qa/],
		[{ review: { readFirst: ['/etc/passwd'] } }, /review\.readFirst/],
		[{ review: { readFirst: ['../outside.md'] } }, /review\.readFirst/],
		[{ review: { readFirst: 'docs/a.md' } }, /review\.readFirst/],
		[{ git: { skipCommitHooks: 'yes' } }, /git\.skipCommitHooks/],
	])
		assert.match(validate(merge(load(), over)).join('\n'), re, JSON.stringify(over));
});

test('every phase skill and the reviewer tell the agent to read what the repository added', () => {
	for (const phase of ['implement', 'qa', 'review', 'ship', 'diagnose'])
		assert.match(
			fs.readFileSync(new URL(`../skills/${phase}/SKILL.md`, import.meta.url), 'utf8'),
			new RegExp(`config\\.mjs" get repoSkills\\.${phase}`),
			phase,
		);
	assert.match(fs.readFileSync(new URL('../skills/review/SKILL.md', import.meta.url), 'utf8'), /get review\.readFirst/);
	assert.match(fs.readFileSync(new URL('../agents/factory-reviewer.md', import.meta.url), 'utf8'), /get review\.readFirst/);
	assert.match(fs.readFileSync(new URL('../skills/implement/SKILL.md', import.meta.url), 'utf8'), /git\.skipCommitHooks[\s\S]*commit with `-n`/);
	assert.match(
		fs.readFileSync(new URL('../skills/ship/SKILL.md', import.meta.url), 'utf8'),
		/--no-verify.*git\.skipCommitHooks|git\.skipCommitHooks.*--no-verify/,
	);
});

// A shipped config with one dotted setting replaced.
function withSetting(dotted, value, also = {}) {
	const c = structuredClone(load());
	Object.assign((c.environment ??= {}), also);
	const keys = dotted.split('.');
	let at = c;
	for (const k of keys.slice(0, -1)) at = at[k] ??= {};
	at[keys.at(-1)] = value;
	return validate(c);
}

const COMPOSE = { type: 'compose', composeFile: 'c.yml', service: 'app' };

test('environment.setup is a list of commands, each a string or {run, user}', () => {
	assert.deepEqual(withSetting('environment.setup', ['npm ci', { run: 'make', user: 'node' }, { run: 'echo\necho' }], COMPOSE), []);
	for (const bad of ['npm ci', [{ user: 'root' }], [{ run: 3 }], [{ run: 'x', user: 7 }], [null], [['a']]])
		assert.ok(
			withSetting('environment.setup', bad, COMPOSE).some((p) => /environment\.setup must be a list of commands/.test(p)),
			JSON.stringify(bad),
		);
});

test('environment.buildFiles is a list of globs', () => {
	assert.deepEqual(withSetting('environment.buildFiles', ['package-lock.json', '**/Pods/*']), []);
	for (const bad of ['x', [''], [1], {}])
		assert.ok(
			withSetting('environment.buildFiles', bad).some((p) => /environment\.buildFiles must be a list of globs/.test(p)),
			JSON.stringify(bad),
		);
});

test('tasks.questionLabel is a label name that differs from the blocked label', () => {
	assert.deepEqual(withSetting('tasks.questionLabel', 'needs-answer'), []);
	for (const bad of ['has space', 'semi;colon', '', 7])
		assert.ok(
			withSetting('tasks.questionLabel', bad).some((p) => /tasks\.questionLabel must be a label name/.test(p)),
			JSON.stringify(bad),
		);
	const same = load().tasks.blockedLabel;
	assert.ok(withSetting('tasks.questionLabel', same).some((p) => /must differ from tasks\.blockedLabel/.test(p)));
});

test('guard.trackerHosts is a list of host names, empty by default', () => {
	assert.deepEqual(load().guard.trackerHosts, []);
	assert.deepEqual(withSetting('guard.trackerHosts', ['jira.internal.example', 'tracker.example.org']), []);
	for (const bad of ['jira.example', ['https://jira.example'], ['host with space'], ['a/b'], [3]])
		assert.ok(
			withSetting('guard.trackerHosts', bad).some((p) => /guard\.trackerHosts must be a list of host names/.test(p)),
			JSON.stringify(bad),
		);
});

test('tasks.ignoreCommentAuthors is a list of author ids or names, empty by default', () => {
	assert.deepEqual(load().tasks.ignoreCommentAuthors, []);
	assert.deepEqual(withSetting('tasks.ignoreCommentAuthors', ['acc-1', 'Automation Bot']), []);
	for (const bad of ['acc-1', [''], [3], {}])
		assert.ok(
			withSetting('tasks.ignoreCommentAuthors', bad).some((p) => /tasks\.ignoreCommentAuthors must be a list/.test(p)),
			JSON.stringify(bad),
		);
});
