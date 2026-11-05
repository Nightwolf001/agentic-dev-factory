import './isolate-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ENV_OVERRIDES } from '../scripts/config.mjs';
import { optionCatalog } from '../scripts/settings-lib.mjs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const config = JSON.parse(read('config.json'));
const catalog = optionCatalog();

const GROUPS = [
	'MCP servers',
	'Plugins',
	'Secrets',
	'Tasks',
	'Sources',
	'Models',
	'Caps and budgets',
	'Git and pull requests',
	'Environment',
	'Mobile lane',
	'Telemetry',
	'Review and QA',
	'Self-improvement',
	'Sandbox',
	'Runtime',
];
const TYPES = ['boolean', 'number', 'string', 'list', 'map'];
// built from the catalogs, not from options: the page makes these rows itself
const NOT_OPTIONS = new Set(['mcp.servers', 'plugins.enabled']);
const maps = new Set(Object.keys(catalog.options).filter((k) => catalog.options[k].type === 'map'));

function dig(obj, dotted) {
	return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}
function leaves(obj, prefix = '') {
	return Object.entries(obj).flatMap(([k, v]) => {
		const key = prefix ? `${prefix}.${k}` : k;
		if (NOT_OPTIONS.has(key)) return [];
		return v && typeof v === 'object' && !Array.isArray(v) && !maps.has(key) ? leaves(v, key) : [key];
	});
}

test('every leaf of config.json is an option or lies inside a map option', () => {
	const missing = leaves(config).filter((k) => !(k in catalog.options));
	assert.deepEqual(missing, [], `settings without an entry in settings/options.json: ${missing.join(', ')}`);
});

test('every option names a key config.json has, and its type fits the default', () => {
	for (const [key, o] of Object.entries(catalog.options)) {
		const value = dig(config, key);
		assert.notEqual(value, undefined, `${key} is not in config.json`);
		assert.ok(TYPES.includes(o.type), `${key} has type ${o.type}`);
		assert.ok(!NOT_OPTIONS.has(key), `${key} is built from a catalog, not an option`);
		if (o.type === 'map') assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${key} is a map, so an object in the defaults`);
		else if (Array.isArray(value)) assert.equal(o.type, 'list', `${key} defaults to an array, so it is a list`);
		else if (value !== null) assert.equal(o.type, typeof value, `${key} defaults to a ${typeof value}`);
	}
});

test('every option has a short title, a scope hint and a group', () => {
	for (const [key, o] of Object.entries(catalog.options)) {
		assert.ok(typeof o.title === 'string' && o.title.length > 0 && o.title.length <= 60, `${key} has a title of at most 60 characters`);
		assert.ok(['user', 'project'].includes(o.scopeHint), `${key} has a scope hint`);
		const user = /^(models\.|runtime\.)/.test(key) || key === 'alerts.notify';
		assert.equal(o.scopeHint, user ? 'user' : 'project', `${key} scope hint`);
	}
});

test("every env override in config.mjs's ENV_OVERRIDES is on its option, and every option's env is an override", () => {
	for (const [key, name] of Object.entries(ENV_OVERRIDES)) assert.equal(catalog.options[key]?.env, name, `${key} should carry ${name}`);
	for (const [key, o] of Object.entries(catalog.options)) if (o.env !== undefined) assert.equal(ENV_OVERRIDES[key], o.env, `${key} env`);
});

test('groups are the listed fifteen and every option belongs to one of them', () => {
	assert.deepEqual(catalog.groups, GROUPS);
	for (const [key, o] of Object.entries(catalog.options)) assert.ok(GROUPS.includes(o.group), `${key} is in the unknown group ${o.group}`);
	for (const g of ['MCP servers', 'Plugins', 'Secrets'])
		assert.deepEqual(
			Object.entries(catalog.options).filter(([, o]) => o.group === g),
			[],
			`${g} is built from the catalogs and holds no options`,
		);
});

test('Sources holds every sources.* key and nothing else', () => {
	for (const [key, o] of Object.entries(catalog.options)) assert.equal(o.group === 'Sources', key.startsWith('sources.'), key);
});

test('the maps are the objects whose keys a project names itself', () => {
	assert.deepEqual(
		[...maps].sort(),
		[
			'environments',
			'git.branchTypes',
			'models.efforts',
			'pr.categoryByBranchType',
			'pr.sizeLabels',
			'repoSkills',
			'review.specialistAxes',
			'sources.github.states',
			'sources.jira.states',
			'sources.local.states',
			'sources.notion.properties',
			'sources.notion.states',
		].sort(),
	);
});

test('optionCatalog returns a copy, so a caller cannot change the catalogue', () => {
	const a = optionCatalog();
	a.groups.push('x');
	delete a.options['tasks.source'];
	assert.equal(optionCatalog().groups.length, 15);
	assert.ok('tasks.source' in optionCatalog().options);
});
