import './isolate-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ENV_OVERRIDES } from '../scripts/config.mjs';
import { optionCatalog } from '../scripts/settings-lib.mjs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const config = JSON.parse(read('config.json'));

// maps whose entries are the user's own (task types, status names, globs) are documented as one setting; the option
// catalogue says which keys are maps. The two catalog-built sections are not options but are open as well.
const OPEN = [
	...Object.entries(optionCatalog().options)
		.filter(([, o]) => o.type === 'map')
		.map(([k]) => new RegExp(`^${k.replace(/\./g, '\\.')}$`)),
	/^mcp\.servers$/,
	/^plugins\.enabled$/,
];
function leaves(obj, prefix = '') {
	return Object.entries(obj).flatMap(([k, v]) => {
		const key = prefix ? `${prefix}.${k}` : k;
		return v && typeof v === 'object' && !Array.isArray(v) && !OPEN.some((re) => re.test(key)) ? leaves(v, key) : [key];
	});
}

test('every setting in config.json is in the reference with its default, so the docs cannot fall behind the code', () => {
	const readme = read('docs/reference.md');
	const reference = readme.slice(readme.indexOf('### Complete reference'), readme.indexOf('## Starting a session'));
	assert.ok(reference.length > 1000, 'the reference exists');
	const missing = leaves(config).filter((k) => !new RegExp(`^\\|\\s*\`${k.replace(/\./g, '\\.')}\`\\s*\\|`, 'm').test(reference));
	assert.deepEqual(missing, [], `settings missing from the reference: ${missing.join(', ')}`);
});

test('the reference names no setting that config.json does not have', () => {
	const readme = read('docs/reference.md');
	const reference = readme.slice(readme.indexOf('### Complete reference'), readme.indexOf('## Starting a session'));
	const known = new Set(leaves(config));
	const documented = [...reference.matchAll(/^\|\s*`([a-z][A-Za-z.]+)`\s*\|/gm)].map((m) => m[1]);
	assert.ok(documented.length >= known.size);
	for (const k of documented) assert.ok(known.has(k), `the reference documents ${k}, which is not a setting`);
});

test('the variables the reference lists as overriding a setting are the ones the code reads', () => {
	const readme = read('docs/reference.md');
	const section = readme.slice(readme.indexOf('#### Variables that override a setting'), readme.indexOf('#### Common changes'));
	const listed = Object.fromEntries([...section.matchAll(/^\|\s*`([\w.]+)`\s*\|\s*`(DF_\w+)`\s*\|/gm)].map((m) => [m[1], m[2]]));
	assert.deepEqual(listed, ENV_OVERRIDES);
});

test('the reference examples of settings are valid settings', async () => {
	const { merge, validate } = await import('../scripts/config.mjs');
	const readme = read('docs/reference.md');
	const block = /#### Common changes\s+```json\n([\s\S]*?)```/.exec(readme)[1];
	const example = JSON.parse(block);
	for (const k of Object.keys(example)) assert.ok(k in config, `${k} is a real section`);
	assert.deepEqual(validate(merge(config, example)), []);
});

test('the reference has a Settings page section and a Moving to .devfactory section that name their commands', () => {
	const readme = read('docs/reference.md');
	const section = (title) => {
		const start = readme.indexOf(`\n## ${title}\n`);
		assert.ok(start >= 0, `## ${title}`);
		const next = readme.indexOf('\n## ', start + 1);
		return readme.slice(start, next < 0 ? undefined : next);
	};
	const page = section('Settings page');
	for (const needle of ['dev-factory settings list', 'dev-factory settings set', 'secret:', 'DF_CONFIG', '--json', 'exit'])
		assert.ok(page.includes(needle), `Settings page: ${needle}`);
	for (const group of optionCatalog().groups) assert.ok(page.includes(group), `Settings page names the group ${group}`);
	const moving = section('Moving to .devfactory');
	for (const needle of ['dev-factory migrate', 'git rm', 'dev-factory mcp migrate', '--apply'])
		assert.ok(moving.includes(needle), `Moving to .devfactory: ${needle}`);
});

test('the reference explains the three state folders in one place and the cloud variables', () => {
	const readme = read('docs/reference.md');
	for (const needle of [
		'`.devfactory/`',
		'`.factory/`',
		'`.dev-factory/`',
		'DF_PROJECT_CONFIG',
		'DF_PROJECT_QA',
		'enabledMcpjsonServers',
		'managed.json',
	])
		assert.ok(readme.includes(needle), needle);
	assert.match(readme, /claude plugin install dev-factory@dev-factory --scope user/);
	// what a routine and a cloud session cannot have
	assert.match(readme, /`DF_PROJECT_CONFIG` stands in for the project layer only/);
	assert.match(readme, /The `jira` server is left out and not approved/);
	assert.match(readme, /used by the routine: enabledMcpjsonServers/);
	assert.match(readme, /nothing new is written to them, with one exception: `dev-factory cloud init --routine`/);
	assert.match(readme, /strictly unless a wanted server is available only from elsewhere/);
});
