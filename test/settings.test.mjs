import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { ENV_OVERRIDES, sourceFrom } from '../scripts/config.mjs';
import { catalog, desired, secretsReport } from '../scripts/mcp-scope.mjs';
import { desiredPlugins, pluginCatalog } from '../scripts/plugins.mjs';
import { runPage, writeChanges } from '../scripts/settings.mjs';
import { buildRows, changes, initialState, optionCatalog, publicRow, reduce, render, resetRow, setRow, stops } from '../scripts/settings-lib.mjs';
import { envValueProblem, parseEnvText, setEnvValue } from '../scripts/state-env.mjs';

// every temporary folder a test makes is removed when the file is done
const temps = [];
const tmp = (prefix) => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	temps.push(dir);
	return dir;
};
after(() => {
	for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

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
	// the cursor is on the row below sentry, and only that row carries the marker
	assert.equal(lines.filter((l) => l.startsWith('▸ ') && /^▸ sequential-thinking\s/.test(l)).length, 1);
	assert.equal(cursorId, 'sequential-thinking');
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
	const dir = tmp('df-envval-');
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
	assert.throws(() => setEnvValue('F', "it's", { dir }), /F: the value holds a quote or a line break/);
	assert.equal(envValueProblem('plain value'), null);
	for (const bad of ["it's", 'a\nb', 'a\rb', 'a\0b']) assert.match(envValueProblem(bad), /quote or a line break/);
	assert.throws(() => setEnvValue('1bad', 'x', { dir }), /not a variable name/);
	setEnvValue('NEWFILE', 'x', { dir: path.join(dir, 'fresh') });
	assert.equal(fs.statSync(path.join(dir, 'fresh', '.env.local')).mode & 0o777, 0o600);
});

// ---- the command line ----

// A stand-in for `claude`: logs its arguments and answers `plugin list --json` with an empty list.
function fakeClaude() {
	const dir = tmp('df-fake-claude-');
	const bin = path.join(dir, 'claude');
	fs.writeFileSync(
		bin,
		`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.DF_FAKE_LOG) fs.appendFileSync(process.env.DF_FAKE_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'plugin' && args[1] === 'list') console.log('[]');
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
					.map((l) => JSON.parse(l).args.join(' '))
			: [];
	return { bin, log, calls };
}

function sandbox() {
	const repo = tmp('df-settings-repo-');
	spawnSync('git', ['init', '-q', repo]);
	const state = tmp('df-settings-state-');
	const fake = fakeClaude();
	const env = {
		...process.env,
		DF_STATE_DIR: state,
		DF_CLAUDE_BIN: fake.bin,
		DF_FAKE_LOG: fake.log,
		DF_MCP_LISTING: path.join(state, 'listing.txt'),
	};
	for (const k of ['DF_CONFIG', 'DF_PROJECT_CONFIG', 'DF_PROJECT_QA', 'DF_FACTORY_REPO']) delete env[k];
	for (const k of Object.keys(env)) if (/^DF_(EFFORT|MAX_|MODEL)/.test(k)) delete env[k];
	fs.writeFileSync(env.DF_MCP_LISTING, '');
	const run = (args, input = '', extra = {}) =>
		spawnSync('node', [SCRIPT, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', input });
	const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
	return { repo, state, fake, env, run, read, project: path.join(repo, '.devfactory', 'config.json'), user: path.join(state, 'config.json') };
}

test('CLI: settings list --json prints an array of rows and exits 0 without a terminal', () => {
	const { run } = sandbox();
	const r = run(['list', '--json']);
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

test('CLI: settings set on a row that is already as asked exits 0 and says so; a refused change exits 1', () => {
	const { run, read, project, user, fake } = sandbox();
	const r = run(['set', 'sentry', 'off']);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /sentry is already off/);
	const bad = run(['set', 'caps.maxConcurrent', 'abc']);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /must be a number/);
	assert.equal(run(['set']).status, 3);
	assert.equal(run(['frobnicate']).status, 3);
	// a required server is on already; `on` does not touch it
	const pw = run(['set', 'playwright', 'on']);
	assert.equal(pw.status, 0, pw.stderr);
	assert.match(pw.stdout, /playwright is already on \(all projects\)/);
	// on for all projects: `on` with no layer never narrows it to this project
	assert.equal(run(['set', 'sentry', 'on', '--user']).status, 0);
	const calls = fake.calls().length;
	const again = run(['set', 'sentry', 'on']);
	assert.equal(again.status, 0, again.stderr);
	assert.match(again.stdout, /sentry is already on \(all projects\)/);
	assert.deepEqual(read(user).mcp.servers, { sentry: true });
	assert.equal(fs.existsSync(project), false, 'the project layer was not touched');
	assert.equal(fake.calls().length, calls, 'no sync for a change that is not one');
	// an explicit layer is a move
	assert.equal(run(['set', 'sentry', 'on', '--project']).status, 0);
	assert.deepEqual(read(project).mcp.servers, { sentry: true });
	const repeat = run(['set', 'sentry', 'on']);
	assert.match(repeat.stdout, /sentry is already on \(this project\)/);
	assert.equal(run(['set', 'sentry', 'on', '--project']).status, 0);
	// a setting at the value it has in that layer
	assert.equal(run(['set', 'caps.maxConcurrent', '3']).status, 0);
	const same = run(['set', 'caps.maxConcurrent', '3']);
	assert.equal(same.status, 0, same.stderr);
	assert.match(same.stdout, /caps\.maxConcurrent is already 3 \(this project\)/);
	// reset with nothing to remove
	assert.equal(run(['reset', 'models.effort']).status, 0);
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
	// a variable that decides the value is named, and nothing is written
	const fixed = run(['set', 'models.effort', 'max'], '', { DF_EFFORT: 'low' });
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
	const { repo, env, read, project, fake } = sandbox();
	spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
	const wt = path.join(tmp('df-wt-'), 'wt');
	spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', wt]);
	const r = spawnSync('node', [SCRIPT, 'set', 'sentry', 'on'], { cwd: wt, env, encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(read(project).mcp.servers, { sentry: true });
	assert.equal(fs.existsSync(path.join(wt, '.devfactory', 'config.json')), false);
	assert.ok(fake.calls().length > 0);
});

test('a secret .env.local cannot keep is refused where it is entered, with the entry still open', () => {
	const id = rowsFor().find((r) => r.kind === 'secret').id;
	const open = press(page(), id, 'enter');
	for (const bad of ["it's", 'two\nlines']) {
		const refused = reduce(open, { secret: bad });
		assert.equal(refused.message, envValueProblem(bad));
		assert.deepEqual(refused.editing, open.editing);
		assert.equal(refused.edits.size, 0);
	}
	let typed = open;
	for (const c of "a'b") typed = reduce(typed, { char: c });
	assert.equal(reduce(typed, 'enter').message, envValueProblem("a'b"));
	assert.equal(reduce(typed, 'enter').edits.size, 0);
	assert.equal(setRow(page(), `secret:${id}`, 'a\nb').message, `${id}: ${envValueProblem('a\nb')}`);
	assert.equal(changes(setRow(page(), `secret:${id}`, 'a\nb')).length, 0);
});

test('CLI: a secret with a quote is refused before anything is written', () => {
	const { run, state, user } = sandbox();
	const r = run(['set', 'secret:CONTEXT7_API_KEY'], "it's\n");
	assert.equal(r.status, 1);
	assert.match(r.stderr, /quote or a line break/);
	assert.ok(!r.stderr.includes("it's"));
	assert.equal(fs.existsSync(path.join(state, '.env.local')), false);
	assert.equal(fs.existsSync(user), false);
});

test('writeChanges tells each change as it writes, and a failure says what was saved and how to apply it', () => {
	const dir = tmp('df-write-');
	const env = { DF_STATE_DIR: dir };
	const told = [];
	assert.deepEqual(writeChanges([{ layer: 'user', key: 'models.effort', value: 'low' }], { repo: dir, env, say: (l) => told.push(l) }), [
		'set models.effort = "low" (user)',
	]);
	assert.deepEqual(told, ['set models.effort = "low" (user)']);
	const later = [];
	assert.throws(
		() =>
			writeChanges(
				[
					{ layer: 'user', key: 'caps.maxConcurrent', value: 2 },
					{ layer: 'env', key: '1bad', value: 'x' },
				],
				{ repo: dir, env, say: (l) => later.push(l) },
			),
		/1bad is not a variable name \(1 earlier change was saved, listed above; dev-factory mcp sync and dev-factory plugins sync apply them\)/,
	);
	assert.deepEqual(later, ['set caps.maxConcurrent = 2 (user)']);
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).caps.maxConcurrent, 2);
	// nothing saved yet: the plain error
	assert.throws(
		() => writeChanges([{ layer: 'env', key: '1bad', value: 'x' }], { repo: dir, env, say: () => {} }),
		/^Error: 1bad is not a variable name$/,
	);
	// a write to the project layer while DF_CONFIG stands in for it is refused (the page never offers one)
	assert.throws(
		() =>
			writeChanges([{ layer: 'project', key: 'caps.maxConcurrent', value: 2 }], {
				repo: dir,
				env: { ...env, DF_CONFIG: '/x/c.json' },
				say: () => {},
			}),
		/the project layer is DF_CONFIG \(\/x\/c\.json\)/,
	);
});

test('with DF_CONFIG standing in for the project layer, project writes are refused and say why', () => {
	const replaced = '/work/machine.json';
	const blocked = `the project layer is DF_CONFIG (${replaced}): edit that file`;
	const state = initialState(rowsFor(), { repo: '/repo', projectReplaced: replaced });
	for (const [id, ...keys] of [
		['sentry', 'space'],
		['sentry', 'p'],
		['caps.maxConcurrent', 'p'],
		['caps.maxConcurrent', 'enter', { input: '4' }],
	]) {
		const after = press(state, id, ...keys);
		assert.equal(after.message, blocked, `${id} ${keys.join(' ')}`);
		assert.equal(after.edits.size, 0);
	}
	// all projects still works
	assert.equal(row(press(state, 'sentry', 'u'), 'sentry').value, 'user');
	assert.equal(changes(press(state, 'models.effort', 'enter', { input: 'low' }))[0].layer, 'user');
	// removing what DF_CONFIG's file holds is a project write too
	const held = initialState(rowsFor({}, { caps: { maxConcurrent: 4 } }), { repo: '/repo', projectReplaced: replaced });
	assert.equal(press(held, 'caps.maxConcurrent', 'd').message, blocked);
	assert.equal(setRow(state, 'caps.maxConcurrent', '5', { layer: 'project' }).message, blocked);
	assert.equal(setRow(state, 'caps.maxConcurrent', '5').message, blocked, 'the hinted layer is the project');
	assert.equal(setRow(state, 'sentry', 'on').message, blocked);
	assert.equal(resetRow(held, 'caps.maxConcurrent', { layer: 'project' }).message, blocked);
	assert.equal(setRow(state, 'caps.maxConcurrent', '5', { layer: 'user' }).message, '');
});

test('CLI: with DF_CONFIG set, settings set and reset refuse the project layer', () => {
	const { run, read, project, user } = sandbox();
	const file = path.join(tmp('df-machine-'), 'machine.json');
	fs.writeFileSync(file, JSON.stringify({ caps: { maxConcurrent: 4 } }));
	const extra = { DF_CONFIG: file };
	const blocked = new RegExp(`the project layer is DF_CONFIG \\(${file.replace(/[.\\/]/g, '\\$&')}\\): edit that file`);
	for (const args of [
		['set', 'caps.maxConcurrent', '3'],
		['set', 'caps.maxConcurrent', '3', '--project'],
		['set', 'sentry', 'on'],
		['reset', 'caps.maxConcurrent', '--project'],
	]) {
		const r = run(args, '', extra);
		assert.equal(r.status, 1, args.join(' '));
		assert.match(r.stderr, blocked, args.join(' '));
	}
	assert.equal(fs.existsSync(project), false, 'nothing was written to .devfactory');
	assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { caps: { maxConcurrent: 4 } });
	assert.equal(run(['set', 'caps.maxConcurrent', '3', '--user'], '', extra).status, 0);
	assert.equal(read(user).caps.maxConcurrent, 3);
	const list = JSON.parse(run(['list', '--json'], '', extra).stdout);
	assert.equal(list.find((x) => x.id === 'caps.maxConcurrent').source, 'file');
});

test('turning mobile.appDir on or off makes maestro required or not, in the session', () => {
	const state = page();
	assert.equal(row(state, 'maestro').locked, false);
	const set = press(state, 'mobile.appDir', 'enter', { input: 'app' });
	assert.equal(row(set, 'mobile.appDir').value, 'app');
	assert.equal(row(set, 'maestro').locked, true);
	assert.equal(row(set, 'maestro').value, 'user');
	assert.equal(press(set, 'maestro', 'u').message, 'maestro is required: it cannot be turned off');
	// and back
	const cleared = press(set, 'mobile.appDir', 'd');
	assert.equal(row(cleared, 'maestro').locked, false);
	assert.equal(row(cleared, 'maestro').value, 'off');
	assert.equal(row(press(cleared, 'maestro', 'space'), 'maestro').value, 'project');
	// already set in the layers: locked from the start, and unlocked by d
	const given = page({}, { mobile: { appDir: 'app' } });
	assert.equal(row(given, 'maestro').locked, true);
	assert.equal(row(press(given, 'mobile.appDir', 'd'), 'maestro').locked, false);
});

test('on with no layer clears a project-level off instead of narrowing', () => {
	const off = page(servers({ sentry: true }), servers({ sentry: false }));
	assert.equal(row(off, 'sentry').value, 'off here');
	const on = setRow(off, 'sentry', 'on');
	assert.equal(row(on, 'sentry').value, 'user');
	assert.deepEqual(
		changes(on).map((c) => [c.layer, c.value]),
		[
			['user', true],
			['project', undefined],
		],
	);
});

// ---- the terminal ----

// Streams standing in for a terminal: keys written to stdin, everything drawn collected from stdout.
function fakeTerminal() {
	const stdin = new PassThrough();
	stdin.setRawMode = (on) => {
		stdin.raw = on;
	};
	const stdout = new PassThrough();
	stdout.columns = 80;
	stdout.rows = 24;
	let out = '';
	stdout.on('data', (d) => (out += d));
	return { stdin, stdout, written: () => out };
}
const ALT_ON = '\x1b[?1049h\x1b[?25l';
const ALT_OFF = '\x1b[?25h\x1b[?1049l';
const listeners = () => ['exit', 'uncaughtException', 'SIGINT', 'SIGTERM', 'SIGHUP'].map((e) => process.listenerCount(e));

test('runPage draws on the alternate screen, takes keys, and puts the terminal back and its handlers away', async () => {
	const before = listeners();
	const t = fakeTerminal();
	const done = runPage(page(), t);
	t.stdin.write(' ');
	t.stdin.write('s');
	const final = await done;
	assert.equal(final.exit, 'save');
	assert.equal(changes(final)[0].key, 'mcp.servers.21st');
	assert.ok(t.written().startsWith(ALT_ON));
	assert.ok(t.written().endsWith(ALT_OFF));
	assert.equal(t.stdin.raw, false);
	assert.deepEqual(listeners(), before);
	// Ctrl-C leaves without saving
	const c = fakeTerminal();
	const quit = runPage(page(), c);
	c.stdin.write('\x03');
	assert.equal((await quit).exit, 'discard');
	assert.ok(c.written().endsWith(ALT_OFF));
});

test('an error before the first draw puts the terminal back before it is passed on', async () => {
	const before = listeners();
	const t = fakeTerminal();
	await assert.rejects(
		runPage(page(), {
			...t,
			draw: () => {
				throw new Error('cannot draw');
			},
		}),
		/cannot draw/,
	);
	assert.ok(t.written().startsWith(ALT_ON));
	assert.ok(t.written().endsWith(ALT_OFF), 'the alternate screen was left last, so the message that follows is seen');
	assert.equal(t.stdin.raw, false);
	assert.deepEqual(listeners(), before);
	// and one while a key is handled
	const k = fakeTerminal();
	let calls = 0;
	const failing = runPage(page(), {
		...k,
		draw: (state, o) => {
			if (++calls > 1) throw new Error('later');
			return render(state, o);
		},
	});
	k.stdin.write('d');
	await assert.rejects(failing, /later/);
	assert.ok(k.written().endsWith(ALT_OFF));
	assert.deepEqual(listeners(), before);
});

test('CLI: a sync that fails says how to run it again, and the settings stay saved', () => {
	const { run, read, project } = sandbox();
	const r = run(['set', 'sentry', 'on'], '', { DF_FAKE_FAIL: 'sentry' });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /FAILED add sentry/);
	assert.match(r.stderr, /settings: the mcp sync did not finish; run dev-factory mcp sync to retry/);
	assert.deepEqual(read(project).mcp.servers, { sentry: true });
});
