import './isolate-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	findRepoConfig,
	get,
	isLegacyConfig,
	layers,
	load,
	merge,
	notices,
	requiredServers,
	setIn,
	sourceOf,
	userConfigFile,
	validate,
} from '../scripts/config.mjs';

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

// ---- layers: defaults, the user's file, the project's file, DF_CONFIG and the DF_* variables ----

const SCRIPT = new URL('../scripts/config.mjs', import.meta.url).pathname;
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const put = (root, rel, data) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), typeof data === 'string' ? data : JSON.stringify(data));
};
// A repository and an empty machine state folder; `opts` is what the functions take.
function world() {
	const repo = tmp('df-layers-');
	execFileSync('git', ['init', '-q', repo]);
	const state = tmp('df-state-');
	return { repo, state, opts: { from: repo, env: { DF_STATE_DIR: state } } };
}
const childEnv = (state, extra = {}) => {
	const env = { ...process.env, DF_STATE_DIR: state, ...extra };
	for (const k of ['DF_CONFIG', 'DF_PROJECT_CONFIG', 'DF_PROJECT_QA']) if (!(k in extra)) delete env[k];
	return env;
};
const quote = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('the user layer is read from DF_STATE_DIR, or ~/.dev-factory', () => {
	assert.equal(userConfigFile({ DF_STATE_DIR: '/x/state' }), path.join('/x/state', 'config.json'));
	assert.equal(userConfigFile({}), path.join(os.homedir(), '.dev-factory', 'config.json'));
});

test('the user layer sits between defaults and project', () => {
	const { repo, state, opts } = world();
	put(state, 'config.json', { models: { effort: 'low' }, caps: { maxConcurrent: 3 } });
	put(repo, '.devfactory/config.json', { caps: { maxConcurrent: 1 } });
	const config = load(undefined, opts);
	assert.equal(get('models.effort', { config, env: opts.env }), 'low');
	assert.equal(get('caps.maxConcurrent', { config, env: opts.env }), 1);
	assert.equal(config.tasks.label, 'dev-factory', 'untouched keys keep their default');
	assert.equal(sourceOf('models.effort', opts), 'user');
	assert.equal(sourceOf('caps.maxConcurrent', opts), 'project');
	assert.equal(sourceOf('tasks.label', opts), 'default');
	assert.deepEqual(
		layers(opts).map((l) => l.name),
		['defaults', 'user', 'project'],
	);
});

test('load() with no argument reads the layers of the process: its DF_STATE_DIR and working folder', () => {
	assert.equal(process.env.DF_STATE_DIR !== undefined, true);
	const before = load().caps.maxConcurrent;
	const saved = process.env.DF_STATE_DIR;
	const { state } = world();
	put(state, 'config.json', { caps: { maxConcurrent: before + 10 } });
	try {
		process.env.DF_STATE_DIR = state;
		assert.equal(load().caps.maxConcurrent, before + 10);
	} finally {
		process.env.DF_STATE_DIR = saved;
	}
});

test('layers always has three entries; a missing file is an empty layer with no file', () => {
	const { opts } = world();
	const ls = layers(opts);
	assert.equal(ls.length, 3);
	assert.deepEqual([ls[1].file, ls[1].data, ls[2].file, ls[2].data], [null, {}, null, {}]);
	assert.ok(ls[0].file && ls[0].data.tasks, 'the defaults are the plugin config.json');
});

test('DF_CONFIG replaces the project layer, and sourceOf says file; a DF_* variable wins over every layer', () => {
	const { repo, state } = world();
	put(repo, '.devfactory/config.json', { caps: { maxConcurrent: 1 } });
	put(state, 'config.json', { caps: { maxOpenPrs: 7 } });
	const other = path.join(tmp('df-file-'), 'c.json');
	fs.writeFileSync(other, JSON.stringify({ caps: { maxConcurrent: 9 } }));
	const env = { DF_STATE_DIR: state, DF_CONFIG: other };
	const config = load(undefined, { from: repo, env });
	assert.equal(config.caps.maxConcurrent, 9);
	assert.equal(config.caps.maxOpenPrs, 7, 'the user layer still applies under DF_CONFIG');
	assert.equal(sourceOf('caps.maxConcurrent', { from: repo, env }), 'file');
	assert.equal(sourceOf('caps.maxOpenPrs', { from: repo, env }), 'user');
	assert.equal(sourceOf('caps.maxConcurrent', { from: repo, env: { ...env, DF_MAX_CONCURRENT: '4' } }), 'DF_MAX_CONCURRENT');
	assert.equal(sourceOf('models.effort', { from: repo, env: { DF_STATE_DIR: state, DF_EFFORT: 'low' } }), 'DF_EFFORT');
	assert.equal(sourceOf('models.effort', { from: repo, env: { DF_STATE_DIR: state, DF_EFFORT: '' } }), 'default', 'an empty variable is not set');
});

test('the new project file wins over the legacy one in the same folder, with a notice', () => {
	const { repo, opts } = world();
	put(repo, 'dev-factory.config.json', { caps: { maxConcurrent: 5 } });
	put(repo, '.devfactory/config.json', { caps: { maxOpenPrs: 2 } });
	assert.equal(findRepoConfig(repo, {}), path.join(repo, '.devfactory/config.json'));
	const config = load(undefined, opts);
	assert.equal(config.caps.maxOpenPrs, 2);
	assert.equal(config.caps.maxConcurrent, load(undefined, world().opts).caps.maxConcurrent, 'the legacy file is not merged');
	const n = notices(opts);
	assert.equal(n.length, 1);
	assert.match(n[0], /is ignored/);
	assert.equal(n[0], `${repo}/dev-factory.config.json is ignored: ${repo}/.devfactory/config.json is used`);
});

test('the legacy file alone is still read, with a notice', () => {
	const { repo, opts } = world();
	put(repo, 'dev-factory.config.json', { caps: { maxConcurrent: 5 } });
	assert.equal(findRepoConfig(repo, {}), path.join(repo, 'dev-factory.config.json'));
	assert.equal(isLegacyConfig(path.join(repo, 'dev-factory.config.json')), true);
	assert.equal(isLegacyConfig(path.join(repo, '.devfactory/config.json')), false);
	assert.equal(load(undefined, opts).caps.maxConcurrent, 5);
	assert.equal(sourceOf('caps.maxConcurrent', opts), 'project');
	const n = notices(opts);
	assert.equal(n.length, 1);
	assert.match(n[0], /run dev-factory migrate/);
	assert.equal(n[0], `${repo}/dev-factory.config.json is the old location: run dev-factory migrate`);
});

test('no notice without a project file or under DF_CONFIG; a file found above the working folder counts', () => {
	const { repo, state, opts } = world();
	assert.deepEqual(notices(opts), []);
	put(repo, 'dev-factory.config.json', {});
	const deep = path.join(repo, 'a', 'b');
	fs.mkdirSync(deep, { recursive: true });
	assert.equal(notices({ from: deep, env: opts.env }).length, 1);
	const other = path.join(repo, 'other.json');
	fs.writeFileSync(other, '{}');
	assert.deepEqual(notices({ from: deep, env: { DF_STATE_DIR: state, DF_CONFIG: other } }), []);
});

test('an unreadable layer names its file', () => {
	const { state, opts } = world();
	put(state, 'config.json', '{ nope');
	assert.throws(
		() => load(undefined, opts),
		(e) => e.message.includes(path.join(state, 'config.json')),
	);
});

test('load(file) still reads that file as it is, without layers', () => {
	const file = path.join(tmp('df-asis-'), 'x.json');
	fs.writeFileSync(file, '{"a":1}');
	assert.deepEqual(load(file), { a: 1 });
});

test('setIn project writes .devfactory/config.json and never the legacy file', () => {
	const { repo, opts } = world();
	put(repo, 'dev-factory.config.json', { caps: { maxConcurrent: 5 } });
	const legacyBefore = fs.readFileSync(path.join(repo, 'dev-factory.config.json'), 'utf8');
	const file = setIn('project', 'mcp.servers.context7', true, opts);
	assert.equal(file, path.join(repo, '.devfactory/config.json'));
	assert.equal(fs.readFileSync(path.join(repo, 'dev-factory.config.json'), 'utf8'), legacyBefore);
	const text = fs.readFileSync(file, 'utf8');
	assert.ok(text.endsWith('\n') && text.includes('\n\t'), 'tab indent and a trailing newline');
	assert.equal(JSON.parse(text).mcp.servers.context7, true);
	assert.equal(JSON.parse(text).caps.maxConcurrent, 5, 'the first write carries the legacy settings over, so they are not lost');
	assert.ok(fs.existsSync(path.join(repo, '.devfactory/.gitignore')));
	setIn('project', 'mcp.servers.sentry', true, opts);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcp.servers, { context7: true, sentry: true });
});

test('setIn user writes the user file in the state folder and creates the folder', () => {
	const { state } = world();
	const env = { DF_STATE_DIR: path.join(state, 'sub') };
	const file = setIn('user', 'models.effort', 'low', { env });
	assert.equal(file, path.join(state, 'sub', 'config.json'));
	assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { models: { effort: 'low' } });
});

test('setIn with undefined prunes empty objects', () => {
	const { opts } = world();
	const file = setIn('project', 'mcp.servers.context7', true, opts);
	assert.equal(setIn('project', 'mcp.servers.context7', undefined, opts), file);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
	assert.equal(setIn('project', 'never.set', undefined, opts), file, 'deleting what is not there is not an error');
});

test('setIn keeps its siblings, replaces a non-object on the way and refuses a prototype key', () => {
	const { opts } = world();
	const file = setIn('project', 'a.b', 1, opts);
	setIn('project', 'a.c', 2, opts);
	setIn('project', 'a.b.x', 3, opts);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: { b: { x: 3 }, c: 2 } });
	setIn('project', 'a.b.x', undefined, opts);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: { c: 2 } });
	assert.throws(() => setIn('project', '__proto__.x', 1, opts), /not a valid setting path/);
	assert.throws(() => setIn('team', 'a', 1, opts), /layer must be user or project/);
	assert.equal({}.x, undefined);
});

test('setIn project outside a git repository says so', () => {
	const dir = tmp('df-nogit-');
	assert.throws(() => setIn('project', 'a', 1, { from: dir, env: { DF_STATE_DIR: dir } }), /not inside a git repository/);
});

test('requiredServers: playwright always, maestro once a mobile app is configured', () => {
	assert.deepEqual(requiredServers(load()), ['playwright']);
	assert.deepEqual(requiredServers(merge(load(), { mobile: { appDir: 'apps/mobile' } })), ['playwright', 'maestro']);
});

test('validate rejects an unknown server, a non-boolean and a required server set to false', () => {
	const bad = merge(load(), { mcp: { servers: { nope: true, sentry: 'yes', playwright: false } } });
	const p = validate(bad);
	assert.ok(p.includes('mcp.servers.nope is not a catalog server'), p.join('\n'));
	assert.ok(p.includes('mcp.servers.sentry must be true or false'), p.join('\n'));
	assert.ok(p.includes('mcp.servers.playwright is required and cannot be false'), p.join('\n'));
	assert.deepEqual(validate(merge(load(), { mcp: { servers: { playwright: true, sentry: true, maestro: false } } })), []);
	assert.deepEqual(validate(merge(load(), { mcp: { servers: 'all' } })), ['mcp.servers must be an object of server ids to true or false']);
});

test('maestro cannot be false once a mobile app is configured', () => {
	const c = merge(load(), { mobile: { appDir: 'apps/mobile' }, mcp: { servers: { maestro: false } } });
	assert.ok(validate(c).includes('mcp.servers.maestro is required and cannot be false'));
});

test('validate checks plugins.enabled against plugins.json, and refuses the required plugin set to false', () => {
	const plugins = JSON.parse(fs.readFileSync(new URL('../plugins.json', import.meta.url), 'utf8')).plugins;
	const required = plugins.find((p) => p.required).id;
	const optional = plugins.find((p) => !p.required).id;
	const p = validate(merge(load(), { plugins: { enabled: { [required]: false, [optional]: 'on', 'ghost@nowhere': true } } }));
	assert.ok(p.includes(`plugins.enabled.${required} is required and cannot be false`), p.join('\n'));
	assert.ok(p.includes(`plugins.enabled.${optional} must be true or false`), p.join('\n'));
	assert.ok(p.includes('plugins.enabled.ghost@nowhere is not a known plugin'), p.join('\n'));
	assert.deepEqual(validate(merge(load(), { plugins: { enabled: { [required]: true, [optional]: false } } })), []);
	assert.deepEqual(validate(merge(load(), { plugins: { enabled: [] } })), ['plugins.enabled must be an object of plugin ids to true or false']);
});

test('a required server set to false in any one layer fails validation, even when a later layer says true', () => {
	const { repo, state, opts } = world();
	put(state, 'config.json', { mcp: { servers: { playwright: false } } });
	put(repo, '.devfactory/config.json', { mcp: { servers: { playwright: true } } });
	assert.equal(load(undefined, opts).mcp.servers.playwright, true);
	const r = spawnSync('node', [SCRIPT, 'validate'], { cwd: repo, encoding: 'utf8', env: childEnv(state) });
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stderr, /mcp\.servers\.playwright is required and cannot be false/);
});

test('the defaults carry an empty mcp.servers and plugins.enabled', () => {
	const c = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
	assert.deepEqual(c.mcp, { servers: {} });
	assert.deepEqual(c.plugins, { enabled: {} });
});

test('config validate prints each notice as a note on stderr and keeps the exit code', () => {
	const { repo, state } = world();
	put(repo, 'dev-factory.config.json', {});
	const ok = spawnSync('node', [SCRIPT, 'validate'], { cwd: repo, encoding: 'utf8', env: childEnv(state) });
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.stdout, /config: ok/);
	assert.match(ok.stderr, new RegExp(`^note: ${quote(repo)}/dev-factory\\.config\\.json is the old location: run dev-factory migrate$`, 'm'));
	put(repo, '.devfactory/config.json', { caps: { maxResumes: -1 } });
	const bad = spawnSync('node', [SCRIPT, 'validate'], { cwd: repo, encoding: 'utf8', env: childEnv(state) });
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /caps\.maxResumes/);
	assert.match(bad.stderr, /^note: .* is ignored: /m);
});

const b64 = (s) => Buffer.from(s).toString('base64');
const run = (repo, state, args, extra = {}) =>
	spawnSync('node', [SCRIPT, 'write-from-env', ...args], { cwd: repo, encoding: 'utf8', env: childEnv(state, extra) });

test('write-from-env writes the project config from base64 and the QA profiles from raw YAML', () => {
	const { repo, state } = world();
	const config = JSON.stringify({ tasks: { source: 'github' } });
	const yaml = 'profiles:\n  web:\n    paths: ["src/**"]\n';
	const r = run(repo, state, [], { DF_PROJECT_CONFIG: b64(config), DF_PROJECT_QA: yaml });
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.devfactory/config.json'), 'utf8')), { tasks: { source: 'github' } });
	assert.equal(fs.readFileSync(path.join(repo, '.devfactory/qa.yaml'), 'utf8'), yaml);
	assert.ok(fs.existsSync(path.join(repo, '.devfactory/.gitignore')));
});

test('write-from-env takes raw JSON and base64 YAML as well', () => {
	const { repo, state } = world();
	const yaml = '# comment\nprofiles: {}\n';
	const r = run(repo, state, [], { DF_PROJECT_CONFIG: '{"caps":{"maxConcurrent":2}}', DF_PROJECT_QA: b64(yaml) });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.devfactory/config.json'), 'utf8')).caps.maxConcurrent, 2);
	assert.equal(fs.readFileSync(path.join(repo, '.devfactory/qa.yaml'), 'utf8'), yaml);
});

test('write-from-env --if-set with neither variable set exits 0 and writes nothing; without it an unset variable exits 1', () => {
	const { repo, state } = world();
	const quiet = run(repo, state, ['--if-set']);
	assert.equal(quiet.status, 0);
	assert.equal(quiet.stderr, '');
	assert.equal(fs.existsSync(path.join(repo, '.devfactory')), false);
	const loud = run(repo, state, []);
	assert.equal(loud.status, 1);
	assert.match(loud.stderr, /DF_PROJECT_CONFIG/);
	assert.equal(fs.existsSync(path.join(repo, '.devfactory/config.json')), false);
});

test('write-from-env --if-set writes only the file whose variable is set', () => {
	const { repo, state } = world();
	const r = run(repo, state, ['--if-set'], { DF_PROJECT_QA: 'profiles: {}\n' });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(fs.existsSync(path.join(repo, '.devfactory/config.json')), false);
	assert.equal(fs.readFileSync(path.join(repo, '.devfactory/qa.yaml'), 'utf8'), 'profiles: {}\n');
});

test('write-from-env refuses invalid JSON and writes nothing', () => {
	const { repo, state } = world();
	for (const bad of ['{ nope', b64('not json'), b64('[1,2]')]) {
		const r = run(repo, state, ['--if-set'], { DF_PROJECT_CONFIG: bad, DF_PROJECT_QA: 'profiles: {}\n' });
		assert.equal(r.status, 1, bad);
		assert.match(r.stderr, /DF_PROJECT_CONFIG/);
	}
	assert.equal(fs.existsSync(path.join(repo, '.devfactory/qa.yaml')), false, 'nothing is written when one value is invalid');
});

test('write-from-env keeps an existing file and exits 1, unless --force', () => {
	const { repo, state } = world();
	put(repo, '.devfactory/config.json', '{"keep":true}');
	const kept = run(repo, state, [], { DF_PROJECT_CONFIG: '{"new":true}', DF_PROJECT_QA: 'profiles: {}\n' });
	assert.equal(kept.status, 1);
	assert.match(kept.stderr, /exists/);
	assert.equal(fs.readFileSync(path.join(repo, '.devfactory/config.json'), 'utf8'), '{"keep":true}');
	const forced = run(repo, state, ['--force'], { DF_PROJECT_CONFIG: '{"new":true}', DF_PROJECT_QA: 'profiles: {}\n' });
	assert.equal(forced.status, 0, forced.stderr);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.devfactory/config.json'), 'utf8')), { new: true });
});

test('write-from-env outside a git repository says so', () => {
	const dir = tmp('df-nogit-');
	const r = run(dir, dir, [], { DF_PROJECT_CONFIG: '{}', DF_PROJECT_QA: 'a: 1\n' });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /not inside a git repository/);
});
