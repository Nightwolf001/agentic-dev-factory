// Imported first by every test that loads the factory's configuration or runs one of its scripts. The user layer of
// the configuration is read from <DF_STATE_DIR>/config.json, so a test that left DF_STATE_DIR alone would pick up the
// settings of whoever runs it. Pointing it at an empty folder makes the shipped defaults the only thing in effect;
// a test that needs a user file or a state of its own sets DF_STATE_DIR itself afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The same holds for the environment: a person's shell can export factory settings (DF_FACTORY_REPO, DF_TAKEOVER, ...) and the
// credentials the servers and trackers read (CONTEXT7_API_KEY, NOTION_TOKEN, ...), and the scripts the tests run inherit them. They
// are removed here, so a result never depends on whose machine runs the suite; a test that needs one sets it itself.
import { TRACKER_NAMES } from '../scripts/state-env.mjs';

const catalog = JSON.parse(fs.readFileSync(new URL('../mcp/catalog.json', import.meta.url), 'utf8'));
const secrets = Object.values(catalog.servers ?? catalog).flatMap((s) => (Array.isArray(s?.secrets) ? s.secrets : []));
for (const name of Object.keys(process.env))
	if (name.startsWith('DF_') || secrets.includes(name) || TRACKER_NAMES.includes(name) || name === 'CLAUDE_CODE_OAUTH_TOKEN')
		delete process.env[name];

process.env.DF_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'df-test-state-'));
