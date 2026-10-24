import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ENV_OVERRIDES } from '../scripts/config.mjs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const config = JSON.parse(read('config.json'));

// maps whose entries are the user's own (task types, status names, globs): documented as one setting
const OPEN = [
	/^git\.branchTypes$/,
	/^pr\.sizeLabels$/,
	/^pr\.categoryByBranchType$/,
	/^models\.efforts$/,
	/^review\.specialistAxes$/,
	/^environments$/,
	/^sources\.\w+\.(states|properties)$/,
];
function leaves(obj, prefix = '') {
	return Object.entries(obj).flatMap(([k, v]) => {
		const key = prefix ? `${prefix}.${k}` : k;
		return v && typeof v === 'object' && !Array.isArray(v) && !OPEN.some((re) => re.test(key)) ? leaves(v, key) : [key];
	});
}

test('every setting in config.json is in the README reference with its default, so the docs cannot fall behind the code', () => {
	const readme = read('README.md');
	const reference = readme.slice(readme.indexOf('### Complete reference'), readme.indexOf('## Starting a session'));
	assert.ok(reference.length > 1000, 'the reference exists');
	const missing = leaves(config).filter((k) => !new RegExp(`^\\|\\s*\`${k.replace(/\./g, '\\.')}\`\\s*\\|`, 'm').test(reference));
	assert.deepEqual(missing, [], `settings missing from the README reference: ${missing.join(', ')}`);
});

test('the README names no setting that config.json does not have', () => {
	const readme = read('README.md');
	const reference = readme.slice(readme.indexOf('### Complete reference'), readme.indexOf('## Starting a session'));
	const known = new Set(leaves(config));
	const documented = [...reference.matchAll(/^\|\s*`([a-z][A-Za-z.]+)`\s*\|/gm)].map((m) => m[1]);
	assert.ok(documented.length >= known.size);
	for (const k of documented) assert.ok(known.has(k), `README documents ${k}, which is not a setting`);
});

test('the variables the README lists as overriding a setting are the ones the code reads', () => {
	const readme = read('README.md');
	const section = readme.slice(readme.indexOf('#### Variables that override a setting'), readme.indexOf('#### Common changes'));
	const listed = Object.fromEntries([...section.matchAll(/^\|\s*`([\w.]+)`\s*\|\s*`(DF_\w+)`\s*\|/gm)].map((m) => [m[1], m[2]]));
	assert.deepEqual(listed, ENV_OVERRIDES);
});

test('the README examples of settings are valid settings', async () => {
	const { merge, validate } = await import('../scripts/config.mjs');
	const readme = read('README.md');
	const block = /#### Common changes\s+```json\n([\s\S]*?)```/.exec(readme)[1];
	const example = JSON.parse(block);
	for (const k of Object.keys(example)) assert.ok(k in config, `${k} is a real section`);
	assert.deepEqual(validate(merge(config, example)), []);
});
