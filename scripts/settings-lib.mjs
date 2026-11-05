// Shared by the settings page and its commands. Everything here is pure: the page (scripts/settings.mjs) reads the layers, calls
// these, and writes what `changes` returns.
//   optionCatalog()                  the groups and every setting of config.json: its group, title, type, scope hint and DF_* variable
//   buildRows({ layers, ... })       one row per server, plugin, secret and setting, in the catalogue's group order
//   initialState(rows, { repo })     the page's state; reduce(state, key) returns the next one
//   changes(state)                   the layer writes the edits come to: { layer: 'user' | 'project' | 'env', key, value }
//   setRow(state, ref, text, opts)   the same edit by id or key, for `settings set`
//   grouped(state) / stops(state)    what the page shows and where the cursor can stand (`render` draws it)
//
// A server or plugin row is `off`, `project` (this project), `user` (all projects) or `off here` (on for all projects, a project-layer
// false in this one). Required rows are `locked`: they can be moved between scopes (a server) but never turned off.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_OVERRIDES, get, merge, requiredServers, sourceFrom, validate } from './config.mjs';
import { envValueProblem } from './state-env.mjs';

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A fresh copy on every call, so a caller can sort or edit it freely.
export function optionCatalog() {
	return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'settings', 'options.json'), 'utf8'));
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const dig = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const layerData = (ls, name) => ls.find((l) => l.name === name)?.data ?? {};

// ---- the rows ----

// The value and source of a server or plugin row from the two layer values (true, false or undefined). Mirrors desired() and
// desiredPlugins(): the tests hold the two together.
function toggleView(row) {
	const { user: u, project: p } = row.lv;
	let value;
	if (row.kind === 'plugin' && row.locked) value = 'user';
	else if (u === true) value = p === false && !row.locked ? 'off here' : 'user';
	else if (p === true) value = 'project';
	else if (row.locked) value = row.home;
	else if (u === undefined && row.defaultOn) value = p === false ? (row.home === 'user' ? 'off here' : 'off') : row.home;
	else value = 'off';
	const source =
		value === 'user'
			? u === true
				? 'user'
				: 'default'
			: value === 'project'
				? p === true
					? 'project'
					: 'default'
				: value === 'off here'
					? 'project'
					: u === false
						? 'user'
						: p === false
							? 'project'
							: 'default';
	return { value, source };
}

const effective = (lv) => [lv.user, lv.project].reduce((acc, v) => (v === undefined ? acc : merge(acc, v)), lv.defaults);

function optionView(row) {
	if (row.fixed || sameLv(row.lv, row.origLv)) return { value: row.baseValue, source: row.baseSource };
	return { value: effective(row.lv), source: row.lv.project !== undefined ? 'project' : row.lv.user !== undefined ? 'user' : 'default' };
}

const sameLv = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function view(row) {
	if (row.kind === 'option') return optionView(row);
	if (row.kind === 'secret')
		return { value: row.lv.env !== undefined ? 'set' : row.baseValue, source: row.lv.env !== undefined ? '.env.local' : row.baseSource };
	return toggleView(row);
}

function finish(row) {
	return { ...row, ...view(row), pending: !sameLv(row.lv, row.origLv) };
}

function toggleRow(fields) {
	const lv = fields.lv;
	return finish({ type: 'boolean', editable: true, origLv: clone(lv), ...fields });
}

// secrets: the rows of secretsReport ({ name, state, neededBy }). env: the environment (a DF_* variable decides a setting's value).
export function buildRows({ layers: ls, mcpCat = {}, pluginCat = { plugins: [] }, options = optionCatalog(), secrets = [], env = process.env }) {
	const merged = ls.reduce((acc, l) => merge(acc, l.data), {});
	const user = layerData(ls, 'user');
	const project = layerData(ls, 'project');
	const required = requiredServers(merged, mcpCat);
	const byGroup = new Map(options.groups.map((g) => [g, []]));
	const add = (row) => (byGroup.get(row.group) ?? byGroup.set(row.group, []).get(row.group)).push(row);

	for (const [id, s] of Object.entries(mcpCat)) {
		const lv = { user: dig(user, `mcp.servers.${id}`), project: dig(project, `mcp.servers.${id}`) };
		add(
			toggleRow({
				group: 'MCP servers',
				kind: 'mcp',
				id,
				title: s.purpose ?? s.title ?? id,
				catRequired: s.required === true,
				locked: required.includes(id),
				defaultOn: required.includes(id),
				home: s.defaultScope === 'project' ? 'project' : 'user',
				lv,
			}),
		);
	}
	for (const p of pluginCat.plugins) {
		const lv = { user: dig(user, `plugins.enabled.${p.id}`), project: dig(project, `plugins.enabled.${p.id}`) };
		add(
			toggleRow({
				group: 'Plugins',
				kind: 'plugin',
				id: p.id,
				title: p.why ?? p.id,
				locked: p.required === true,
				defaultOn: p.required === true || env.DF_INSTALL_OPTIONAL !== '0',
				home: p.defaultScope === 'project' ? 'project' : 'user',
				lv,
			}),
		);
	}
	for (const s of secrets) {
		const set = s.state === 'set';
		add(
			finish({
				group: 'Secrets',
				kind: 'secret',
				id: s.name,
				title: `needed by ${s.neededBy.join(', ')}`,
				type: 'secret',
				locked: false,
				editable: true,
				baseValue: set ? 'set' : 'empty',
				baseSource: set ? (env[s.name] ? 'shell' : '.env.local') : '',
				lv: {},
				origLv: {},
			}),
		);
	}
	for (const [key, o] of Object.entries(options.options)) {
		const name = ENV_OVERRIDES[key];
		const fixed = Boolean(name && env[name] !== undefined && env[name] !== '');
		const lv = { defaults: dig(layerData(ls, 'defaults'), key), user: dig(user, key), project: dig(project, key) };
		add(
			finish({
				group: o.group,
				kind: 'option',
				id: key,
				title: o.title,
				type: o.type,
				locked: false,
				editable: !fixed,
				fixed,
				scopeHint: o.scopeHint === 'user' ? 'user' : 'project',
				baseValue: get(key, { config: merged, env }),
				baseSource: sourceFrom(ls, key, env),
				lv,
				origLv: clone(lv),
			}),
		);
	}
	return [...byGroup.values()].flatMap((rows) => rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

// The brief form of a row, for `list --json`: none of the page's bookkeeping.
export const publicRow = ({ group, kind, id, title, type, value, source, locked, editable }) => ({
	group,
	kind,
	id,
	title,
	type,
	value,
	source,
	locked,
	editable,
});

// ---- the page's state ----

// projectReplaced: the DF_CONFIG file when it stands in for the project layer, so a write to .devfactory/config.json would have no effect.
export function initialState(rows, { repo = null, projectReplaced = null } = {}) {
	return {
		repo,
		projectReplaced,
		rows,
		cursor: 0,
		collapsed: new Set(),
		filter: '',
		edits: new Map(),
		message: '',
		quitArmed: false,
		editing: null,
		searching: false,
	};
}

// The rows by group, after the search filter: [{ group, rows: [index], collapsed }]
export function grouped(state) {
	const f = state.filter.toLowerCase();
	const by = new Map();
	state.rows.forEach((r, index) => {
		if (f && !`${r.id} ${r.title} ${r.group}`.toLowerCase().includes(f)) return;
		(by.get(r.group) ?? by.set(r.group, []).get(r.group)).push(index);
	});
	return [...by].map(([group, rows]) => ({ group, rows, collapsed: state.collapsed.has(group) }));
}

// Where the cursor can stand: every row of an open group, and the header of a collapsed one.
export function stops(state) {
	return grouped(state).flatMap((g) => (g.collapsed ? [{ group: g.group }] : g.rows.map((index) => ({ index }))));
}

export const editCount = (state) => new Set([...state.edits.keys()].map((k) => k.split(':').slice(0, 2).join(':'))).size;

// The layer writes the edits come to. A server or plugin edit writes both layers, so the other layer loses its key.
export function changes(state) {
	return [...state.edits.values()].map(({ layer, key, value }) => ({ layer, key, value }));
}

const rowKey = (row) => `${row.kind}:${row.id}`;
// the settings key a row writes (a secret's is the variable name)
const keyOf = (row) => (row.kind === 'mcp' ? `mcp.servers.${row.id}` : row.kind === 'plugin' ? `plugins.enabled.${row.id}` : row.id);

// Stores a row's new layer values: updates the row and its edits (none left when it is back where it started).
function store(state, index, lv, message = '') {
	const old = state.rows[index];
	// the project layer can be written only in a repository, and not while DF_CONFIG stands in for it
	if (old.kind !== 'secret' && !sameLv({ v: lv.project }, { v: old.lv.project })) {
		const blocked = projectBlock(state);
		if (blocked) return { ...state, message: blocked };
	}
	const row = finish({ ...old, lv });
	let rows = state.rows.map((r, i) => (i === index ? row : r));
	if (row.kind === 'option' && row.id === 'mobile.appDir') rows = relock(rows);
	const edits = new Map([...state.edits].filter(([k]) => !k.startsWith(`${rowKey(row)}:`)));
	if (row.pending) {
		// a server or plugin edit writes both layers (the other loses its key); a setting only the layers that differ
		const toggle = row.kind === 'mcp' || row.kind === 'plugin';
		const writes = (row.kind === 'secret' ? ['env'] : ['user', 'project'])
			.filter((layer) => toggle || !sameLv({ v: row.lv[layer] }, { v: row.origLv[layer] }))
			.map((layer) => ({ layer, key: keyOf(row), value: row.lv[layer] }))
			// the layer that gets a value first, then the one that is cleared
			.sort((a, b) => (b.value !== undefined) - (a.value !== undefined));
		for (const w of writes) edits.set(`${rowKey(row)}:${w.layer}`, w);
	}
	return { ...state, rows, edits, message };
}

// A mobile app makes the device runner required (requiredServers), so its lock follows the setting, in both directions.
function relock(rows) {
	const cat = Object.fromEntries(rows.filter((r) => r.kind === 'mcp').map((r) => [r.id, { required: r.catRequired }]));
	const required = requiredServers(configOf(rows), cat);
	return rows.map((r) =>
		r.kind === 'mcp' && r.locked !== required.includes(r.id) ? finish({ ...r, locked: !r.locked, defaultOn: !r.locked }) : r,
	);
}

const REQUIRED = (row) => `${row.id} is required: it cannot be turned off`;
const NO_REPO = 'there is no git repository here: only u (all projects) can be changed';
const projectBlock = (state) =>
	state.projectReplaced ? `the project layer is DF_CONFIG (${state.projectReplaced}): edit that file` : state.repo ? null : NO_REPO;

// Moves a server or plugin row to `target`: off, project, user, offhere or default.
function retarget(state, index, target) {
	const row = state.rows[index];
	if (row.locked && (row.kind === 'plugin' ? target !== 'default' : target === 'off' || target === 'offhere'))
		return { ...state, message: REQUIRED(row) };
	const { user, project } = row.lv;
	const lv =
		target === 'off'
			? { user: row.defaultOn && row.home === 'user' ? false : undefined, project: row.defaultOn && row.home === 'project' ? false : undefined }
			: target === 'project'
				? { user: undefined, project: true }
				: target === 'user'
					? { user: true, project: undefined }
					: target === 'offhere'
						? { user, project: false }
						: row.value === 'off here'
							? { user, project: undefined }
							: { user: undefined, project: undefined };
	return store(state, index, lv);
}

const ON_FOR_ALL = 'on for all projects: u turns it off there, p adds a project-level off';

function toggleKey(state, index, key) {
	const row = state.rows[index];
	const v = row.value;
	if (key === 'space') {
		if (v === 'user') return { ...state, message: ON_FOR_ALL };
		if (v === 'off here') return { ...state, message: 'off in this project only: d turns it back on here, u turns it off for all projects' };
		return retarget(state, index, v === 'off' ? 'project' : 'off');
	}
	if (key === 'u') return retarget(state, index, v === 'user' || v === 'off here' ? 'off' : 'user');
	if (key === 'p')
		return retarget(
			state,
			index,
			v === 'project' ? 'off' : v === 'user' ? (row.locked ? 'project' : 'offhere') : v === 'off here' ? 'user' : 'project',
		);
	return retarget(state, index, 'default');
}

// ---- values typed into a setting ----

const numeric = (s) => /^-?\d+(\.\d+)?$/.test(s);

// text -> { value } or { problem }
export function parseInput(row, text) {
	const t = String(text ?? '');
	if (row.type === 'boolean') {
		if (/^(true|on|yes|1)$/i.test(t.trim())) return { value: true };
		if (/^(false|off|no|0)$/i.test(t.trim())) return { value: false };
		return { problem: `${row.id} must be true or false` };
	}
	if (row.type === 'number')
		return t.trim() !== '' && Number.isFinite(Number(t)) ? { value: Number(t) } : { problem: `${row.id} must be a number` };
	if (row.type === 'string') return t === '' ? { problem: `${row.id} is empty: d goes back to the default` } : { value: t };
	if (row.type === 'list' && !t.trim().startsWith('[')) {
		const items = t
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		// ports and the like: numbers when the list holds numbers (or nothing yet) and every item looks like one
		const now = Array.isArray(row.value) ? row.value : [];
		const asNumbers = items.length > 0 && items.every(numeric) && (now.length === 0 || now.some((x) => typeof x === 'number'));
		return { value: asNumbers ? items.map(Number) : items };
	}
	try {
		const value = JSON.parse(t);
		if (row.type === 'map' && !isObject(value)) return { problem: `${row.id} must be a JSON object` };
		if (row.type === 'list' && !Array.isArray(value)) return { problem: `${row.id} must be a list` };
		return { value };
	} catch (e) {
		return { problem: `${row.id} is not valid JSON: ${e.message}` };
	}
}

// The text a setting is edited as.
export function editText(row) {
	const v = row.value;
	if (v === undefined || v === null) return '';
	if (row.type === 'list') return v.every((x) => typeof x === 'string' || typeof x === 'number') ? v.join(', ') : JSON.stringify(v);
	if (row.type === 'map') return JSON.stringify(v);
	return String(v);
}

// The configuration the rows come to, for validate().
function configOf(rows, replace) {
	const cfg = {};
	for (const r of rows) {
		if (r.kind !== 'option') continue;
		const value = replace && replace.id === r.id ? replace.value : r.value;
		if (value === undefined) continue;
		const keys = r.id.split('.');
		let at = cfg;
		for (const k of keys.slice(0, -1)) at = at[k] ??= {};
		at[keys.at(-1)] = value;
	}
	return cfg;
}

function writeOption(state, index, layer, value) {
	const row = state.rows[index];
	const before = validate(configOf(state.rows));
	const added = validate(configOf(state.rows, { id: row.id, value })).filter((p) => !before.includes(p));
	if (added.length) return { ...state, message: added[0] };
	return store(state, index, { ...row.lv, [layer]: value });
}

const FIXED = (row) => `${row.id} is set by ${ENV_OVERRIDES[row.id]}; change it in your shell or ~/.dev-factory/.env.local`;

function optionKey(state, index, key) {
	const row = state.rows[index];
	if (row.fixed) return { ...state, message: FIXED(row) };
	if (key === 'd') return store(state, index, { ...row.lv, user: undefined, project: undefined });
	if (key === 'space' || (key === 'enter' && row.type === 'boolean')) {
		if (row.type !== 'boolean') return state;
		return writeOption(state, index, row.scopeHint, !row.value);
	}
	if (key === 'enter') return { ...state, editing: { id: row.id, text: editText(row) } };
	if (row.value === undefined) return { ...state, message: `${row.id} has no value to move` };
	return moveTo(state, index, key === 'u' ? 'user' : 'project');
}

// u / p on a setting: its value in effect goes to that layer; for u the project layer drops its own, so the value stays what it is.
function moveTo(state, index, layer) {
	const row = state.rows[index];
	return store(state, index, { ...row.lv, [layer]: clone(row.value), ...(layer === 'user' ? { project: undefined } : {}) });
}

// ---- keys ----

function editKey(state, key) {
	const { editing } = state;
	const index = state.rows.findIndex((r) => r.id === editing.id);
	const row = state.rows[index];
	if (key === 'esc') return { ...state, editing: null };
	if (key === 'backspace') return { ...state, editing: { ...editing, text: editing.text.slice(0, -1) } };
	if (key && typeof key === 'object' && 'char' in key) return { ...state, editing: { ...editing, text: editing.text + key.char } };
	let text;
	if (key === 'enter') text = editing.text;
	else if (key && typeof key === 'object' && 'input' in key && !editing.secret) text = key.input;
	else if (key && typeof key === 'object' && 'secret' in key && editing.secret) text = key.secret;
	else return state;
	if (editing.secret) {
		if (!text) return { ...state, editing: null, message: 'nothing entered: the secret is unchanged' };
		// refused here, with the entry still open: a value .env.local cannot keep would fail at save, after other changes were written
		if (envValueProblem(text)) return { ...state, message: envValueProblem(text) };
		return store({ ...state, editing: null }, index, { env: text }, `${row.id} will be saved to .env.local`);
	}
	const parsed = parseInput(row, text);
	if (parsed.problem) return { ...state, message: parsed.problem };
	return writeOption({ ...state, editing: null }, index, row.scopeHint, parsed.value);
}

function searchKey(state, key) {
	if (key === 'esc' || key === 'enter') return { ...state, searching: false };
	if (key === 'backspace') return { ...state, filter: state.filter.slice(0, -1), cursor: 0 };
	if (key && typeof key === 'object' && 'char' in key) return { ...state, filter: state.filter + key.char, cursor: 0 };
	return state;
}

export function reduce(prev, key) {
	let state = { ...prev, quitArmed: key === 'q' ? prev.quitArmed : false, message: '' };
	if (key && typeof key === 'object' && 'search' in key) return { ...state, filter: key.search, cursor: 0 };
	if (state.editing) return editKey(state, key);
	if (state.searching) return searchKey(state, key);
	const list = stops(state);
	const cursor = Math.min(state.cursor, Math.max(0, list.length - 1));
	state = { ...state, cursor };
	const stop = list[cursor];
	if (key === 'up') return { ...state, cursor: Math.max(0, cursor - 1) };
	if (key === 'down') return { ...state, cursor: Math.min(list.length - 1, cursor + 1) };
	if (key === '/') return { ...state, searching: true };
	if (key === 's') return { ...state, exit: 'save' };
	if (key === 'q') {
		if (editCount(state) > 0 && !state.quitArmed) return { ...state, quitArmed: true, message: 'unsaved changes: s saves, q again discards' };
		return { ...state, exit: 'discard' };
	}
	if (!stop) return state;
	const group = stop.group ?? state.rows[stop.index].group;
	const collapse = (on) => {
		const collapsed = new Set(state.collapsed);
		on ? collapsed.add(group) : collapsed.delete(group);
		const next = { ...state, collapsed };
		return {
			...next,
			cursor: Math.max(
				0,
				stops(next).findIndex((s) => (s.group ?? next.rows[s.index].group) === group),
			),
		};
	};
	if (key === 'left') return stop.group ? state : collapse(true);
	if (key === 'right') return stop.group ? collapse(false) : state;
	if (stop.group) return key === 'space' || key === 'enter' ? collapse(false) : state;
	const row = state.rows[stop.index];
	if (!['space', 'u', 'p', 'd', 'enter'].includes(key)) return state;
	if (row.kind === 'option') return optionKey(state, stop.index, key);
	if (row.kind === 'secret') {
		if (key === 'enter') return { ...state, editing: { id: row.id, secret: true, text: '' } };
		return { ...state, message: key === 'd' ? 'a secret has no default: edit it with enter' : '' };
	}
	if (key === 'enter') return state;
	return toggleKey(state, stop.index, key);
}

// ---- the same edits by name: `settings set` ----

const TOGGLE_WORDS = { on: null, off: 'off', default: 'default', user: 'user', all: 'user', project: 'project', this: 'project' };

// Sets one row by its id (a server, a plugin, a setting's key, or secret:NAME) the way the keys would. `layer` is --user / --project.
// A state with no edit and a message means nothing changed.
export function setRow(state, ref, text, { layer } = {}) {
	let name = String(ref);
	let secret = false;
	if (name.startsWith('secret:')) {
		secret = true;
		name = name.slice('secret:'.length);
	}
	let index = state.rows.findIndex((r) => r.id === name && (secret ? r.kind === 'secret' : true));
	// a plugin by the part before the marketplace
	if (index < 0 && !secret) {
		const some = state.rows.map((r, i) => [r, i]).filter(([r]) => r.kind === 'plugin' && r.id.split('@')[0] === name);
		if (some.length === 1) index = some[0][1];
	}
	if (secret && index < 0) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ...state, message: `${name} is not a variable name` };
		const row = finish({
			group: 'Secrets',
			kind: 'secret',
			id: name,
			title: 'set by hand',
			type: 'secret',
			locked: false,
			editable: true,
			baseValue: 'empty',
			baseSource: '',
			lv: {},
			origLv: {},
		});
		state = { ...state, rows: [...state.rows, row] };
		index = state.rows.length - 1;
	}
	if (index < 0) return { ...state, message: `${name} is not a server, plugin, secret or setting (dev-factory settings list)` };
	const row = state.rows[index];
	// nothing to change because the row is already as asked: not a refusal, so `settings set` can be run again and again
	const noop = (message) => ({ ...state, message, noop: true });
	const edited = (next, none) => (next.edits.size === 0 && !next.message ? { ...next, message: none, noop: true } : next);
	const where = (l) => (l === 'user' ? 'all projects' : 'this project');
	if (row.kind === 'secret') {
		if (!text) return { ...state, message: 'nothing to save: the value was empty' };
		const problem = envValueProblem(text);
		if (problem) return { ...state, message: `${row.id}: ${problem}` };
		return store(state, index, { env: text }, '');
	}
	if (row.kind === 'option') {
		if (row.fixed) return { ...state, message: FIXED(row) };
		const parsed = parseInput(row, text);
		if (parsed.problem) return { ...state, message: parsed.problem };
		const at = layer ?? row.scopeHint;
		if (sameLv({ v: row.lv[at] }, { v: parsed.value })) return noop(`${row.id} is already ${JSON.stringify(parsed.value)} (${where(at)})`);
		return edited(writeOption(state, index, at, parsed.value), `${row.id} is already ${JSON.stringify(parsed.value)}`);
	}
	const word = String(text).toLowerCase();
	if (!(word in TOGGLE_WORDS)) return { ...state, message: `${text} is not on, off, user, project or default` };
	let target = TOGGLE_WORDS[word];
	if (word === 'on') {
		// `on` with no layer never narrows a server that is on for all projects to this one, and clears a project-level off
		if (!layer && (row.value === 'user' || row.value === 'project')) return noop(`${row.id} is already on (${where(row.value)})`);
		target = layer === 'user' ? 'user' : layer === 'project' || row.value !== 'off here' ? 'project' : 'default';
	}
	if (target === 'off' && layer === 'project' && row.value === 'user') target = 'offhere';
	const states = { off: 'off', project: 'on (this project)', user: 'on (all projects)', offhere: 'off in this project' };
	const reached = { off: 'off', project: 'project', user: 'user', offhere: 'off here' }[target];
	if (reached && row.value === reached) return noop(`${row.id} is already ${states[target]}`);
	return edited(retarget(state, index, target), `${row.id} is already as it would be`);
}

// ---- drawing ----

const FOOTER = ['↑↓ move', 'space on/off', 'u all projects', 'p this project', 'd default', '⏎ edit', '/ search'];

function show(row) {
	const v = row.value;
	if (v === undefined || v === null) return 'unset';
	if (Array.isArray(v) && v.length === 0) return '(none)';
	if (Array.isArray(v)) return v.every((x) => typeof x !== 'object') ? v.join(',') : JSON.stringify(v);
	return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// The page as text, no line longer than `width`. With a `height` only the lines around the cursor are kept.
export function render(state, { width = 80, height = Infinity } = {}) {
	const fit = (s) => (s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s);
	const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
	const list = stops(state);
	const at = list[Math.min(state.cursor, list.length - 1)];
	const groups = grouped(state);
	const idw = Math.min(44, Math.max(28, ...groups.flatMap((g) => g.rows.map((i) => state.rows[i].id.length))));
	const body = [];
	let cursorLine = 0;
	for (const g of groups) {
		const here = at?.group === g.group;
		if (here) cursorLine = body.length;
		body.push(`${g.collapsed ? '▸' : '▾'} ${g.group} (${g.rows.length})${here ? ' ◂' : ''}`);
		if (g.collapsed) continue;
		for (const i of g.rows) {
			const r = state.rows[i];
			if (at?.index === i) cursorLine = body.length;
			const source = `${r.source}${r.pending ? '*' : ''}`;
			body.push(`${at?.index === i ? '▸' : ' '} ${cut(r.id, idw)} ${cut(show(r), 14)} ${source.padEnd(12)} ${r.title}`.trimEnd());
		}
	}
	if (!groups.length) body.push(`nothing matches "${state.filter}"`);
	const foot = [];
	let line = '';
	for (const seg of [...FOOTER, `s save (${editCount(state)} changes)`, 'q quit']) {
		if (line && line.length + 2 + seg.length > width) {
			foot.push(line);
			line = '';
		}
		line += (line ? '  ' : '') + seg;
	}
	foot.push(line);
	const row = state.editing && state.rows.find((r) => r.id === state.editing.id);
	if (row)
		foot.push(
			`${row.id}: ${state.editing.secret ? '*'.repeat(state.editing.text.length) : state.editing.text}_  (enter saves the edit, esc cancels)`,
		);
	else if (state.searching) foot.push(`/${state.filter}_  (enter keeps the filter, esc stops typing)`);
	else if (state.filter) foot.push(`filter: ${state.filter}  (/ to change)`);
	if (state.message) foot.push(state.message);
	const head = [`dev-factory settings: ${state.repo ?? '(no repository)'}`];
	const room = Math.max(3, height - head.length - foot.length);
	const start = body.length > room ? Math.min(Math.max(0, cursorLine - Math.floor(room / 2)), body.length - room) : 0;
	return [...head, ...body.slice(start, start + room), ...foot].map(fit).join('\n');
}

// `settings reset`: the row's overrides removed (only `layer`'s with --user / --project), back to the default.
export function resetRow(state, ref, { layer } = {}) {
	const name = String(ref).replace(/^secret:/, '');
	const index = state.rows.findIndex((r) => r.id === name);
	if (index < 0) return { ...state, message: `${name} is not a server, plugin or setting (dev-factory settings list)` };
	const row = state.rows[index];
	if (row.kind === 'secret') return { ...state, message: 'a secret has no default' };
	if (row.fixed) return { ...state, message: FIXED(row) };
	if (row.kind === 'option') {
		const lv = { ...row.lv, ...(layer ? { [layer]: undefined } : { user: undefined, project: undefined }) };
		const next = store(state, index, lv);
		return next.edits.size || next.message ? next : { ...next, message: `${row.id} has no override to remove`, noop: true };
	}
	const next = layer && row.value !== 'off here' ? store(state, index, { ...row.lv, [layer]: undefined }) : retarget(state, index, 'default');
	return next.edits.size || next.message ? next : { ...next, message: `${row.id} has no override to remove`, noop: true };
}
