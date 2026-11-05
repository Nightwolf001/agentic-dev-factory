// Imported first by every test that loads the factory's configuration or runs one of its scripts. The user layer of
// the configuration is read from <DF_STATE_DIR>/config.json, so a test that left DF_STATE_DIR alone would pick up the
// settings of whoever runs it. Pointing it at an empty folder makes the shipped defaults the only thing in effect;
// a test that needs a user file or a state of its own sets DF_STATE_DIR itself afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DF_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'df-test-state-'));
