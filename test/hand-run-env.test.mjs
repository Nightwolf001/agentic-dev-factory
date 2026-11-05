import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// open-prs.mjs and frontier.mjs are also run by hand (the status command, a person in a terminal), where nothing has
// loaded the state folder's .env.local. They must read the tracker token from it themselves, or a Notion count fails
// with a 401 and the frontier says there is no token. A preloaded fetch stands in for the Notion API and reports the
// Authorization header it was sent.
const stubFetch = `data:text/javascript,${encodeURIComponent(
	"globalThis.fetch = async (u, o) => { process.stderr.write('AUTH ' + o.headers.Authorization + '\\n'); return new Response(JSON.stringify({ properties: {}, results: [], has_more: false }), { status: 200 }); };",
)}`;

function run(script, args = []) {
	const state = fs.mkdtempSync(path.join(os.tmpdir(), 'df-hand-run-'));
	fs.writeFileSync(path.join(state, '.env.local'), 'NOTION_TOKEN=ntn_from_state_folder\nDF_TAKEOVER=1\n');
	const env = { ...process.env, DF_STATE_DIR: state, DF_TASK_SOURCE: 'notion', DF_NOTION_DATABASE_ID: 'db1', PATH: '/nonexistent' };
	delete env.NOTION_TOKEN;
	delete env.DF_TAKEOVER;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'df-hand-run-cwd-'));
	return spawnSync(process.execPath, ['--import', stubFetch, new URL(`../scripts/${script}`, import.meta.url).pathname, ...args], {
		encoding: 'utf8',
		env,
		cwd,
	});
}

test('open-prs.mjs run by hand sends the Notion token from the state folder', () => {
	const r = run('open-prs.mjs');
	assert.match(r.stderr, /AUTH Bearer ntn_from_state_folder/);
	assert.doesNotMatch(r.stdout, /401/);
});

test('frontier.mjs check run by hand finds the Notion token in the state folder', () => {
	const r = run('frontier.mjs', ['check']);
	assert.doesNotMatch(r.stdout, /no Notion token/);
	assert.match(r.stderr, /AUTH Bearer ntn_from_state_folder/);
});
