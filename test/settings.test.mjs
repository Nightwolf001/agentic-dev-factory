import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ENV_OVERRIDES, sourceFrom } from '../scripts/config.mjs';
import { catalog, desired, secretsReport } from '../scripts/mcp-scope.mjs';
import { desiredPlugins, pluginCatalog } from '../scripts/plugins.mjs';
import { buildRows, changes, initialState, optionCatalog, publicRow, reduce, render, resetRow, setRow, stops } from '../scripts/settings-lib.mjs';
import { parseEnvText, setEnvValue } from '../scripts/state-env.mjs';

const SCRIPT = new URL('../scripts/settings.mjs', import.meta.url).pathname;
const SP = 'superpowers@claude-plugins-official';
const FD = 'frontend-design@claude-plugins-official';
const defaults = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

const L = (user = {}, project = {}) => [
	{ name: 'defaults', file: 'config.json', data: defaults },
	{ name: 'user', file: 'u.json', data: user },
	{ name: 'project', file: 'p.json', data: project },
];
const rowsFor = (user, project, extra = {}) => {
	// the state folder is the test's own empty one: secretsReport reads its .env.local
	const env = { DF_STATE_DIR: process.env.DF_STATE_DIR, ...extra };
	const ls = L(user, project);
	const cat = catalog();
	return buildRows({
		layers: ls,
		mcpCat: cat,
		pluginCat: pluginCatalog(),
		options: optionCatalog(),
		secrets: secretsReport({ want: desired(ls, cat), cat, env }),
		env,
	});
};
const page = (user, project, env) => initialState(rowsFor(user, project, env), { repo: '/repo' });
const focus = (state, id) => ({ ...state, cursor: stops(state).findIndex((s) => s.index !== undefined && state.rows[s.index].id === id) });
const press = (state, id, ...keys) => keys.reduce((s, k) => reduce(s, k), focus(state, id));
const row = (state, id) => state.rows.find((r) => r.id === id);
const servers = (map) => ({ mcp: { servers: map } });
const enabled = (map) => ({ plugins: { enabled: map } });

test('buildRows lists servers, plugins, secrets and every option, required rows locked, DF_ rows not editable', () => {
	const rows = rowsFor({}, {}, { DF_EFFORT: 'low' });
	const kinds = (k) => rows.filter((r) => r.kind === k);
	assert.deepEqual(
		kinds('mcp')
			.map((r) => r.id)
			.sort(),
		Object.keys(catalog()).sort(),
	);
	assert.deepEqual(
		kinds('plugin')
			.map((r) => r.id)
			.sort(),
		pluginCatalog()
			.plugins.map((p) => p.id)
			.sort(),
	);
	assert.deepEqual(
		kinds('option')
			.map((r) => r.id)
			.sort(),
		Object.keys(optionCatalog().options).sort(),
	);
	assert.ok(kinds('secret').length > 0);
	// catalogue order, and by id inside a group
	const order = optionCatalog().groups;
	const seen = rows.map((r) => order.indexOf(r.group));
	assert.deepEqual(
		seen,
		[...seen].sort((a, b) => a - b),
	);
	for (const g of order) {
		const ids = rows.filter((r) => r.group === g).map((r) => r.id);
		assert.deepEqual(ids, [...ids].sort(), g);
	}
	assert.deepEqual(
		rows
			.filter((r) => r.locked)
			.map((r) => r.id)
			.sort(),
		['playwright', SP],
	);
	const pw = row({ rows }, 'playwright');
	assert.deepEqual([pw.value, pw.source], ['user', 'default']);
	const effort = row({ rows }, 'models.effort');
	assert.deepEqual([effort.value, effort.source, effort.editable], ['low', 'DF_EFFORT', false]);
	assert.equal(row({ rows }, 'caps.maxConcurrent').editable, true);
	// maestro is required once a mobile app is set
	assert.equal(row({ rows: rowsFor({}, { mobile: { appDir: 'app' } }) }, 'maestro').locked, true);
	// the secret rows say who needs them and never hold a value
	const secret = rows.find((r) => r.kind === 'secret');
	assert.match(secret.title, /^needed by /);
	assert.ok(['set', 'empty'].includes(secret.value));
	assert.deepEqual(Object.keys(publicRow(secret)), ['group', 'kind', 'id', 'title', 'type', 'value', 'source', 'locked', 'editable']);
});

test('a server or plugin row shows what desired() and desiredPlugins() make of the same layers', () => {
	const states = [undefined, true, false];
	for (const u of states)
		for (const p of states)
			for (const optional of ['1', '0']) {
				const env = { DF_INSTALL_OPTIONAL: optional };
				const user = {
					...(u === undefined ? {} : servers({ sentry: u, playwright: u })),
					...(u === undefined ? {} : enabled({ [FD]: u, [SP]: u })),
				};
				const project = {
					...(p === undefined ? {} : servers({ sentry: p, playwright: p })),
					...(p === undefined ? {} : enabled({ [FD]: p, [SP]: p })),
				};
				const ls = L(user, project);
				const rows = rowsFor(user, project, env);
				const here = `user ${u} project ${p} optional ${optional}`;
				for (const id of ['sentry', 'playwright']) {
					const w = desired(ls, catalog()).find((x) => x.id === id);
					const expected = w ? w.scope : u === true && p === false ? 'off here' : 'off';
					assert.equal(row({ rows }, id).value, expected, `${id}: ${here}`);
				}
				for (const id of [FD, SP]) {
					const w = desiredPlugins(ls, pluginCatalog(), env).find((x) => x.id === id);
					const expected = w ? (w.off ? 'off here' : w.scope) : 'off';
					assert.equal(row({ rows }, id).value, expected, `${id}: ${here}`);
				}
			}
});

test('space on an off server turns it on for this project; changes writes project true and clears user', () => {
	const s = press(page(), 'sentry', 'space');
	assert.equal(row(s, 'sentry').value, 'project');
	assert.deepEqual(changes(s), [
		{ layer: 'project', key: 'mcp.servers.sentry', value: true },
		{ layer: 'user', key: 'mcp.servers.sentry', value: undefined },
	]);
	// pressing it again puts the row back where it started: nothing left to save
	const back = reduce(s, 'space');
	assert.equal(row(back, 'sentry').value, 'off');
	assert.deepEqual(changes(back), []);
});

test('u on a project server moves it to all projects', () => {
	const s = press(page({}, servers({ sentry: true })), 'sentry', 'u');
	assert.equal(row(s, 'sentry').value, 'user');
	assert.deepEqual(changes(s), [
		{ layer: 'user', key: 'mcp.servers.sentry', value: true },
		{ layer: 'project', key: 'mcp.servers.sentry', value: undefined },
	]);
	// u on a row that is on for all projects turns it off there
	assert.equal(row(reduce(s, 'u'), 'sentry').value, 'off');
});

test('space on a row that is on for all projects explains; p adds a project-level off and d clears it', () => {
	const on = page(servers({ sentry: true }));
	const s = press(on, 'sentry', 'space');
	assert.equal(s.message, 'on for all projects: u turns it off there, p adds a project-level off');
	assert.equal(changes(s).length, 0);
	const here = reduce(s, 'p');
	assert.equal(row(here, 'sentry').value, 'off here');
	assert.deepEqual(
		changes(here).map((c) => [c.layer, c.value]),
		[
			['user', true],
			['project', false],
		],
	);
	const cleared = reduce(here, 'd');
	assert.equal(row(cleared, 'sentry').value, 'user');
	assert.deepEqual(changes(cleared), []);
});

test('turning a default-on plugin off writes a user false, and d goes back to the default', () => {
	const s = press(page(), FD, 'u');
	assert.equal(row(s, FD).value, 'off');
	assert.deepEqual(
		changes(s).map((c) => [c.layer, c.value]),
		[
			['user', false],
			['project', undefined],
		],
	);
	assert.equal(row(reduce(s, 'd'), FD).value, 'user');
	// with the optional plugins switched off by default, space turns one on for this project
	assert.equal(row(press(page({}, {}, { DF_INSTALL_OPTIONAL: '0' }), FD, 'space'), FD).value, 'project');
});

test('a required server cannot be turned off by space or u', () => {
	const msg = 'playwright is required: it cannot be turned off';
	assert.equal(press(page({}, servers({ playwright: true })), 'playwright', 'space').message, msg);
	assert.equal(press(page(), 'playwright', 'u').message, msg);
	assert.equal(press(page(), 'playwright', 'u').edits.size, 0);
	// but it can be moved between scopes
	const moved = press(page(), 'playwright', 'p');
	assert.equal(row(moved, 'playwright').value, 'project');
	assert.equal(row(reduce(moved, 'u'), 'playwright').value, 'user');
	// the required plugin is always for all projects
	assert.equal(press(page(), SP, 'u').message, `${SP} is required: it cannot be turned off`);
	assert.equal(press(page(), SP, 'p').edits.size, 0);
});

test('space on a DF_-sourced option leaves the state and explains', () => {
	const s = page({}, {}, { DF_EFFORT: 'low' });
	for (const k of ['space', 'u', 'p', 'd', 'enter']) {
		const after = press(s, 'models.effort', k);
		assert.equal(after.message, 'models.effort is set by DF_EFFORT; change it in your shell or ~/.dev-factory/.env.local', k);
		assert.equal(after.edits.size, 0);
		assert.equal(after.editing, null);
	}
	assert.equal(ENV_OVERRIDES['models.effort'], 'DF_EFFORT');
});

test('space flips a boolean in its scope hint layer', () => {
	const key = Object.entries(optionCatalog().options).find(([k, o]) => o.type === 'boolean' && typeof row(page(), k)?.value === 'boolean')[0];
	const o = optionCatalog().options[key];
	const before = row(page(), key).value;
	const s = press(page(), key, 'space');
	assert.equal(row(s, key).value, !before);
	assert.deepEqual(changes(s), [{ layer: o.scopeHint, key, value: !before }]);
});

test('enter then input on a number validates: "abc" is refused with the problem, "3" is recorded in the project layer', () => {
	const open = press(page(), 'caps.maxConcurrent', 'enter');
	assert.deepEqual(open.editing, { id: 'caps.maxConcurrent', text: String(row(open, 'caps.maxConcurrent').value) });
	const bad = reduce(open, { input: 'abc' });
	assert.match(bad.message, /caps\.maxConcurrent must be a number/);
	assert.equal(bad.edits.size, 0);
	const negative = reduce(press(page(), 'caps.maxResumes', 'enter'), { input: '-2' });
	assert.match(negative.message, /caps\.maxResumes must be a non-negative integer/);
	const good = reduce(open, { input: '3' });
	assert.equal(good.editing, null);
	assert.equal(row(good, 'caps.maxConcurrent').value, 3);
	assert.equal(row(good, 'caps.maxConcurrent').source, 'project');
	assert.deepEqual(changes(good), [{ layer: 'project', key: 'caps.maxConcurrent', value: 3 }]);
	// typing goes through the same checks
	let typed = reduce(open, 'backspace');
	for (const c of '7') typed = reduce(typed, { char: c });
	assert.equal(typed.editing.text, String(row(open, 'caps.maxConcurrent').value).slice(0, -1) + '7');
	assert.equal(reduce(typed, 'esc').editing, null);
	assert.equal(reduce(typed, 'esc').edits.size, 0);
});

test('models and effort are written to the user layer', () => {
	const s = reduce(press(page(), 'models.effort', 'enter'), { input: 'low' });
	assert.deepEqual(changes(s), [{ layer: 'user', key: 'models.effort', value: 'low' }]);
});

test('a list is comma-separated, numbers stay numbers in a list of numbers, a map is JSON', () => {
	const ports = reduce(press(page(), 'cleanup.ports', 'enter'), { input: '3000, 3001' });
	assert.deepEqual(row(ports, 'cleanup.ports').value, [3000, 3001]);
	assert.match(reduce(press(page(), 'cleanup.ports', 'enter'), { input: '3000, x' }).message, /cleanup\.ports must be a list of port numbers/);
	const bugs = reduce(press(page(), 'tasks.bugTypes', 'enter'), { input: 'Bug, Defect' });
	assert.deepEqual(row(bugs, 'tasks.bugTypes').value, ['Bug', 'Defect']);
	const none = reduce(press(page(), 'tasks.ignoreCommentAuthors', 'enter'), { input: '' });
	assert.deepEqual(row(none, 'tasks.ignoreCommentAuthors').value, []);
	const map = reduce(press(page(), 'repoSkills', 'enter'), { input: '{"qa":["repo-qa"]}' });
	assert.deepEqual(changes(map), [{ layer: 'project', key: 'repoSkills', value: { qa: ['repo-qa'] } }]);
	assert.match(reduce(press(page(), 'repoSkills', 'enter'), { input: '{nope' }).message, /repoSkills is not valid JSON/);
	assert.match(reduce(press(page(), 'repoSkills', 'enter'), { input: '{"deploy":["x"]}' }).message, /repoSkills\.deploy is not a phase/);
});

test('d removes the override from both layers', () => {
	const s = press(page({ caps: { maxConcurrent: 2 } }, { caps: { maxConcurrent: 3 } }), 'caps.maxConcurrent', 'd');
	assert.deepEqual(changes(s), [
		{ layer: 'user', key: 'caps.maxConcurrent', value: undefined },
		{ layer: 'project', key: 'caps.maxConcurrent', value: undefined },
	]);
	assert.equal(row(s, 'caps.maxConcurrent').value, defaults.caps.maxConcurrent);
	assert.equal(row(s, 'caps.maxConcurrent').source, 'default');
});

test('u and p put a setting’s value in that layer; u drops the project’s own so the value stays', () => {
	const s = press(page({}, { caps: { maxConcurrent: 4 } }), 'caps.maxConcurrent', 'u');
	assert.equal(row(s, 'caps.maxConcurrent').value, 4);
	assert.deepEqual(changes(s), [
		{ layer: 'user', key: 'caps.maxConcurrent', value: 4 },
		{ layer: 'project', key: 'caps.maxConcurrent', value: undefined },
	]);
	assert.deepEqual(changes(press(page(), 'caps.maxConcurrent', 'p')), [
		{ layer: 'project', key: 'caps.maxConcurrent', value: defaults.caps.maxConcurrent },
	]);
});

test('a secret is entered with enter, shown masked, and recorded for .env.local', () => {
	const id = rowsFor().find((r) => r.kind === 'secret').id;
	const open = press(page(), id, 'enter');
	assert.deepEqual(open.editing, { id, secret: true, text: '' });
	let typed = open;
	for (const c of 'hunter2') typed = reduce(typed, { char: c });
	assert.ok(!render(typed, { width: 100 }).includes('hunter2'));
	assert.match(render(typed, { width: 100 }), /\*{7}/);
	const done = reduce(typed, 'enter');
	assert.equal(row(done, id).value, 'set');
	assert.deepEqual(changes(done), [{ layer: 'env', key: id, value: 'hunter2' }]);
	assert.equal(reduce(reduce(open, { secret: '' }), 'q').exit, 'discard');
	assert.equal(press(page(), id, 'space').edits.size, 0);
});

test('q with edits asks first; a second q discards; s saves', () => {
	const edited = press(page(), 'sentry', 'space');
	const asked = reduce(edited, 'q');
	assert.equal(asked.message, 'unsaved changes: s saves, q again discards');
	assert.equal(asked.exit, undefined);
	assert.equal(reduce(asked, 'q').exit, 'discard');
	// any other key disarms it
	assert.equal(reduce(reduce(asked, 'down'), 'q').exit, undefined);
	assert.equal(reduce(page(), 'q').exit, 'discard');
	assert.equal(reduce(edited, 's').exit, 'save');
});

test('left and right collapse and expand a group; a search narrows the rows', () => {
	let s = focus(page(), 'sentry');
	s = reduce(s, 'left');
	assert.ok(s.collapsed.has('MCP servers'));
	assert.deepEqual(stops(s)[s.cursor], { group: 'MCP servers' });
	assert.match(render(s, { width: 100 }), /▸ MCP servers \(\d+\) ◂/);
	s = reduce(s, 'right');
	assert.equal(s.collapsed.size, 0);
	const found = reduce(page(), { search: 'maxconc' });
	assert.deepEqual(
		stops(found).map((x) => found.rows[x.index].id),
		['caps.maxConcurrent'],
	);
	assert.match(render(reduce(page(), { search: 'zzzz' }), { width: 80 }), /nothing matches "zzzz"/);
	// typing a search: / then characters
	let typed = reduce(page(), '/');
	for (const c of 'sentry') typed = reduce(typed, { char: c });
	assert.equal(typed.filter, 'sentry');
	assert.equal(reduce(typed, 'enter').searching, false);
});

test('render keeps every line within width and marks the cursor row', () => {
	const s = press(page({}, servers({ sentry: true })), 'sentry', 'down');
	const cursorId = s.rows[stops(s)[s.cursor].index].id;
	for (const width of [40, 60, 80, 120]) {
		const text = render(s, { width });
		for (const line of text.split('\n')) assert.ok(line.length <= width, `${width}: ${line}`);
	}
	const text = render(s, { width: 120 });
	const lines = text.split('\n');
	assert.equal(lines[0], 'dev-factory settings: /repo');
	assert.match(
		lines.find((l) => l.startsWith('▸ ') && !l.includes('(')),
		/^▸ stack-overflow|^▸ \S/,
	);
	assert.equal(lines.filter((l) => l.startsWith('▸ ') && l.includes(cursorId)).length, 1);
	assert.match(text, /▾ MCP servers \(\d+\)/);
	assert.match(text, /^  sentry\s+project\s+project/m);
	assert.match(
		text,
		/↑↓ move {2}space on\/off {2}u all projects {2}p this project {2}d default {2}⏎ edit {2}\/ search {2}s save \(0 changes\) {2}q quit/,
	);
	const edited = render(reduce(s, 'space'), { width: 120 });
	assert.match(edited, /s save \(1 changes\)/);
	assert.match(edited, new RegExp(`${cursorId}\\s+\\S+\\s+\\S+\\*`));
	// with a height the page scrolls to the cursor
	const tall = render(focus(page(), 'zzz-none'), { width: 100, height: 12 });
	assert.ok(tall.split('\n').length <= 12);
	const deep = render(focus(page(), 'sandbox.enabled'), { width: 100, height: 12 });
	assert.ok(deep.split('\n').length <= 12);
	assert.match(deep, /▸ sandbox\.enabled/);
});

test('setRow and resetRow make the same edits by name', () => {
	const base = page();
	assert.deepEqual(
		changes(setRow(base, 'sentry', 'on')).map((c) => [c.layer, c.value]),
		[
			['project', true],
			['user', undefined],
		],
	);
	assert.deepEqual(changes(setRow(base, 'sentry', 'on', { layer: 'user' }))[0], { layer: 'user', key: 'mcp.servers.sentry', value: true });
	assert.equal(setRow(base, 'sentry', 'off').message, 'sentry is already off');
	assert.equal(setRow(base, 'playwright', 'off').message, 'playwright is required: it cannot be turned off');
	assert.match(setRow(base, 'sentry', 'maybe').message, /not on, off, user, project or default/);
	assert.match(setRow(base, 'nothing.here', 'x').message, /not a server, plugin, secret or setting/);
	// a plugin by the name before the marketplace
	assert.equal(changes(setRow(base, 'frontend-design', 'off'))[0].value, false);
	assert.deepEqual(changes(setRow(base, 'caps.maxConcurrent', '5')), [{ layer: 'project', key: 'caps.maxConcurrent', value: 5 }]);
	assert.deepEqual(changes(setRow(base, 'caps.maxConcurrent', '5', { layer: 'user' })), [{ layer: 'user', key: 'caps.maxConcurrent', value: 5 }]);
	assert.match(setRow(base, 'caps.maxConcurrent', 'abc').message, /must be a number/);
	assert.equal(setRow(base, 'caps.maxConcurrent', String(defaults.caps.maxConcurrent), { layer: 'project' }).edits.size, 1);
	assert.deepEqual(changes(setRow(base, 'secret:NEW_TOKEN', 'abc')), [{ layer: 'env', key: 'NEW_TOKEN', value: 'abc' }]);
	assert.match(setRow(base, 'secret:not a name', 'abc').message, /not a variable name/);
	assert.equal(resetRow(page({}, servers({ sentry: true })), 'sentry').edits.size, 2);
	assert.match(resetRow(base, 'sentry').message, /no override/);
	assert.deepEqual(
		changes(resetRow(page({ caps: { maxConcurrent: 2 } }, { caps: { maxConcurrent: 3 } }), 'caps.maxConcurrent', { layer: 'project' })),
		[{ layer: 'project', key: 'caps.maxConcurrent', value: undefined }],
	);
});

test('sourceFrom reads a layer list the way sourceOf reads the files', () => {
	assert.equal(sourceFrom(L({ models: { effort: 'low' } }), 'models.effort', {}), 'user');
	assert.equal(sourceFrom(L({ models: { effort: 'low' } }, { models: { effort: 'high' } }), 'models.effort', {}), 'project');
	assert.equal(sourceFrom(L({}, { caps: { maxConcurrent: 2 } }), 'caps.maxConcurrent', { DF_CONFIG: '/x' }), 'file');
	assert.equal(sourceFrom(L(), 'models.effort', { DF_EFFORT: 'low' }), 'DF_EFFORT');
	assert.equal(sourceFrom(L(), 'models.effort', {}), 'default');
});

test('setEnvValue replaces a name where it stands, keeps the rest, writes mode 600 and refuses an unsafe value', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-envval-'));
	const file = path.join(dir, '.env.local');
	fs.writeFileSync(file, '# tokens\nA=1\nexport B=old\n\nC=3\nB=dup\n', { mode: 0o644 });
	setEnvValue('B', 'new', { dir });
	assert.equal(fs.readFileSync(file, 'utf8'), '# tokens\nA=1\nexport B=new\n\nC=3\n');
	setEnvValue('D', 'has space', { dir });
	setEnvValue('E', 'tok-en_1.2/3', { dir });
	const parsed = parseEnvText(fs.readFileSync(file, 'utf8'));
	assert.equal(parsed.get('D'), 'has space');
	assert.equal(parsed.get('E'), 'tok-en_1.2/3');
	assert.match(fs.readFileSync(file, 'utf8'), /^D='has space'$/m);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.throws(() => setEnvValue('F', "it's", { dir }), /quote or a line break/);
	assert.throws(() => setEnvValue('1bad', 'x', { dir }), /not a variable name/);
	setEnvValue('NEWFILE', 'x', { dir: path.join(dir, 'fresh') });
	assert.equal(fs.statSync(path.join(dir, 'fresh', '.env.local')).mode & 0o777, 0o600);
});

// ---- the command line ----

// A stand-in for `claude`: logs its arguments and answers `plugin list --json` with an empty list.
function fakeClaude() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-fake-claude-'));
	const bin = path.join(dir, 'claude');
	fs.writeFileSync(
		bin,
		`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.DF_FAKE_LOG) fs.appendFileSync(process.env.DF_FAKE_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'plugin' && args[1] === 'list') console.log('[]');
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
					.map((l) => JSON.parse(l).args.join(' '))
			: [];
	return { bin, log, calls };
}

function sandbox() {
	const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-settings-repo-')));
	spawnSync('git', ['init', '-q', repo]);
	const state = fs.mkdtempSync(path.join(os.tmpdir(), 'df-settings-state-'));
	const fake = fakeClaude();
	const env = {
		...process.env,
		DF_STATE_DIR: state,
		DF_CLAUDE_BIN: fake.bin,
		DF_FAKE_LOG: fake.log,
		DF_MCP_LISTING: path.join(state, 'listing.txt'),
	};
	delete env.DF_CONFIG;
	for (const k of Object.keys(env)) if (/^DF_(EFFORT|MAX_|MODEL)/.test(k)) delete env[k];
	fs.writeFileSync(env.DF_MCP_LISTING, '');
	const run = (args, input = '') => spawnSync('node', [SCRIPT, ...args], { cwd: repo, env, encoding: 'utf8', input });
	const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
	return { repo, state, fake, env, run, read, project: path.join(repo, '.devfactory', 'config.json'), user: path.join(state, 'config.json') };
}

test('CLI: settings list --json prints an array of rows and exits 0 without a terminal', () => {
	const { run } = sandbox();
	const r = spawnSync('node', [SCRIPT, 'list', '--json'], {
		cwd: process.cwd(),
		env: { ...process.env, DF_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'df-s-')) },
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	assert.equal(r.status, 0, r.stderr);
	const rows = JSON.parse(r.stdout);
	assert.ok(Array.isArray(rows) && rows.length > 100);
	assert.deepEqual(Object.keys(rows[0]), ['group', 'kind', 'id', 'title', 'type', 'value', 'source', 'locked', 'editable']);
	assert.equal(rows.find((x) => x.id === 'playwright').locked, true);
	const text = run([]);
	assert.equal(text.status, 0, text.stderr);
	assert.match(text.stdout, /^MCP servers$/m);
	assert.match(text.stdout, /^ {2}playwright\s+user\s+default\s+\(required\)$/m);
});

test('CLI: settings set playwright off exits 1 and says it is required', () => {
	const { run, fake } = sandbox();
	const r = run(['set', 'playwright', 'off']);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /required/);
	assert.deepEqual(fake.calls(), []);
});

test('CLI: settings set sentry on writes the project layer and makes Claude match', () => {
	const { run, read, project, fake } = sandbox();
	const r = run(['set', 'sentry', 'on']);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(read(project).mcp.servers, { sentry: true });
	assert.ok(
		fake.calls().some((c) => c.startsWith('mcp add-json -s local sentry')),
		fake.calls().join('\n'),
	);
	assert.match(r.stdout, /add\s+sentry/);
	// to all projects instead: the user file gets it and the project file loses it
	assert.equal(run(['set', 'sentry', 'on', '--user']).status, 0);
	assert.equal(read(project).mcp?.servers?.sentry, undefined);
	// turning it off removes it from both
	const off = run(['set', 'sentry', 'off']);
	assert.equal(off.status, 0, off.stderr);
	assert.ok(fake.calls().some((c) => c.startsWith('mcp remove -s user sentry')));
});

test('CLI: settings set on an unchanged row exits 1 with the reason', () => {
	const { run } = sandbox();
	const r = run(['set', 'sentry', 'off']);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /sentry is already off/);
	const bad = run(['set', 'caps.maxConcurrent', 'abc']);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /must be a number/);
	assert.equal(run(['set']).status, 3);
	assert.equal(run(['frobnicate']).status, 3);
});

test('CLI: settings set writes a setting to its hinted layer, --user or --project overrides it, reset removes it', () => {
	const { run, read, project, user } = sandbox();
	assert.equal(run(['set', 'caps.maxConcurrent', '3']).status, 0);
	assert.equal(read(project).caps.maxConcurrent, 3);
	assert.equal(run(['set', 'models.effort', 'low']).status, 0);
	assert.equal(read(user).models.effort, 'low');
	assert.equal(run(['set', 'models.effort', 'high', '--project']).status, 0);
	assert.equal(read(project).models.effort, 'high');
	assert.equal(run(['set', 'cleanup.ports', '3000,3001']).status, 0);
	assert.deepEqual(read(project).cleanup.ports, [3000, 3001]);
	assert.equal(run(['reset', 'caps.maxConcurrent']).status, 0);
	assert.equal(read(project).caps?.maxConcurrent, undefined);
	const list = JSON.parse(run(['list', '--json']).stdout);
	assert.deepEqual(
		['value', 'source'].map((k) => list.find((x) => x.id === 'models.effort')[k]),
		['high', 'project'],
	);
	assert.equal(run(['reset', 'caps.maxConcurrent']).status, 1);
	// a variable that decides the value is named, and nothing is written
	const fixed = spawnSync('node', [SCRIPT, 'set', 'models.effort', 'max'], {
		cwd: process.cwd(),
		env: { ...process.env, DF_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'df-s-')), DF_EFFORT: 'low' },
		encoding: 'utf8',
	});
	assert.equal(fixed.status, 1);
	assert.match(fixed.stderr, /set by DF_EFFORT/);
});

test('CLI: settings set secret:NAME reads the value from stdin, writes .env.local with mode 600 and never prints it', () => {
	const { run, state } = sandbox();
	const r = run(['set', 'secret:CONTEXT7_API_KEY'], 'abc\n');
	assert.equal(r.status, 0, r.stderr);
	const file = path.join(state, '.env.local');
	assert.equal(fs.readFileSync(file, 'utf8'), 'CONTEXT7_API_KEY=abc\n');
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.ok(!r.stdout.includes('abc') && !r.stderr.includes('abc'));
	assert.match(r.stdout, /CONTEXT7_API_KEY/);
	// replaced where it stands
	assert.equal(run(['set', 'secret:CONTEXT7_API_KEY'], 'zq9-second').status, 0);
	assert.equal(fs.readFileSync(file, 'utf8'), 'CONTEXT7_API_KEY=zq9-second\n');
	// never on the command line
	const argv = run(['set', 'secret:CONTEXT7_API_KEY', 'ghi']);
	assert.equal(argv.status, 1);
	assert.match(argv.stderr, /standard input/);
	assert.ok(!fs.readFileSync(file, 'utf8').includes('ghi'));
	// the list shows it as set, with no value
	const list = JSON.parse(run(['list', '--json']).stdout);
	assert.ok(!JSON.stringify(list).includes('zq9'));
});

test('CLI: from a linked worktree the main checkout’s settings are read and written', () => {
	const { repo, run, env, read, project, fake } = sandbox();
	spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
	const wt = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-wt-'))), 'wt');
	spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', wt]);
	const r = spawnSync('node', [SCRIPT, 'set', 'sentry', 'on'], { cwd: wt, env, encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(read(project).mcp.servers, { sentry: true });
	assert.equal(fs.existsSync(path.join(wt, '.devfactory', 'config.json')), false);
	assert.ok(fake.calls().length > 0);
	void run;
});
