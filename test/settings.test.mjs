import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { enablePlugin } from '../scripts/enable-plugin.mjs';

const SCRIPT = new URL('../scripts/enable-plugin.mjs', import.meta.url).pathname;
const SHARED = new URL('../../.claude/settings.json', import.meta.url).pathname;

test('the committed settings do not turn the plugin on for every session in the checkout', () => {
	const shared = JSON.parse(fs.readFileSync(SHARED, 'utf8'));
	assert.equal(shared.enabledPlugins?.['dev-factory@dev-factory'], undefined);
	assert.equal(shared.extraKnownMarketplaces?.['dev-factory'], undefined);
});

test('enabling the plugin merges into existing settings and is idempotent', () => {
	const before = {
		teammateMode: 'auto',
		enabledPlugins: { 'other@x': true },
		extraKnownMarketplaces: { x: { source: { source: 'github', repo: 'a/b' } } },
	};
	const after = enablePlugin(before, '/repo/dev-factory');
	assert.equal(after.teammateMode, 'auto');
	assert.equal(after.enabledPlugins['other@x'], true);
	assert.equal(after.enabledPlugins['dev-factory@dev-factory'], true);
	assert.deepEqual(after.extraKnownMarketplaces['dev-factory'], { source: { source: 'directory', path: '/repo/dev-factory' } });
	assert.equal(after.extraKnownMarketplaces.x.source.repo, 'a/b');
	assert.deepEqual(enablePlugin(after, '/repo/dev-factory'), after);
});

test('the script writes the local settings file, creating it when missing', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-settings-'));
	const file = path.join(dir, '.claude', 'settings.local.json');
	assert.equal(spawnSync('node', [SCRIPT, file, '/repo/dev-factory']).status, 0);
	assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).enabledPlugins['dev-factory@dev-factory'], true);
	fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
	assert.equal(spawnSync('node', [SCRIPT, file, '/repo/dev-factory']).status, 0);
	const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert.deepEqual(merged.permissions.allow, ['Bash(ls)']);
	assert.equal(merged.enabledPlugins['dev-factory@dev-factory'], true);
	assert.notEqual(spawnSync('node', [SCRIPT]).status, 0, 'usage without arguments');
});
