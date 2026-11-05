import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('hooks.json loads the settings pane module next to the command hooks', () => {
	const hooks = JSON.parse(read('hooks/hooks.json'));
	assert.deepEqual(hooks.modules, ['./settings-pane.tsx']);
	assert.ok(fs.existsSync(new URL('../hooks/settings-pane.tsx', import.meta.url)));
	for (const event of ['SessionStart', 'PreToolUse', 'SubagentStop']) assert.ok(hooks.hooks[event], event);
	const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
	assert.equal(manifest.types, './types/settings-pane.d.ts');
	assert.ok(fs.existsSync(new URL('../types/settings-pane.d.ts', import.meta.url)));
});

test('the pane answers both command names and changes settings only through the settings command line', () => {
	const src = read('hooks/settings-pane.tsx');
	assert.match(src, /name: 'dev-factory-settings'/);
	assert.match(src, /command: 'dev-factory-settings'/);
	assert.match(src, /command: 'dev-factory:settings'/);
	// every command it runs is `dev-factory settings list|set|reset`, through the launcher
	const runs = [...src.matchAll(/\['settings', '([a-z]+)'/g)].map((m) => m[1]);
	assert.ok(runs.length > 0);
	for (const sub of runs) assert.ok(['list', 'set', 'reset'].includes(sub), sub);
	assert.doesNotMatch(src, /\.env\.local'?\s*[,)]/, 'it never writes the secrets file itself');
	assert.match(src, /secret:\$\{r\.id\}`\], v\)/, 'a secret goes to settings set on standard input');
});

test('/dev-factory:settings falls back to the conversation and never asks for a secret there', () => {
	const md = read('commands/settings.md');
	assert.match(md, /^---\ndescription: /);
	assert.match(md, /scripts\/settings\.mjs" list/);
	assert.match(md, /scripts\/settings\.mjs" set/);
	assert.match(md, /Never ask for a secret's value in the conversation/);
	assert.match(md, /pbpaste \| dev-factory settings set secret:/);
});
