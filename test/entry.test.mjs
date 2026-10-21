import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every CLI usage line ends in exit 3 and an error on stderr, so "main() ran" is observable without side effects.
const CLIS = ['bin/qa.mjs', 'scripts/run-context.mjs', 'scripts/run-record.mjs', 'scripts/frontier.mjs', 'scripts/config.mjs'];
const ran = (file) => spawnSync('node', [file], { encoding: 'utf8', env: { ...process.env, DF_STATE_DIR: os.tmpdir() } });

function layouts() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'df-entry-'));
	const spaced = path.join(base, 'with space', 'dev-factory');
	fs.mkdirSync(path.dirname(spaced), { recursive: true });
	fs.cpSync(ROOT, spaced, { recursive: true, filter: (p) => !/\/(test|node_modules)(\/|$)/.test(p) });
	const link = path.join(base, 'link');
	fs.symlinkSync(ROOT, link);
	const spacedLink = path.join(base, 'with space', 'link');
	fs.symlinkSync(ROOT, spacedLink);
	return { plain: ROOT, spaced, link, spacedLink };
}

test('every CLI runs its main() from a plain, symlinked or space-containing path, and from a relative one', () => {
	for (const [name, dir] of Object.entries(layouts())) {
		for (const cli of CLIS) {
			const r = ran(path.join(dir, cli));
			assert.notEqual(r.status, 0, `${name} ${cli}: main() did not run (exit 0, no usage)`);
			assert.match(r.stderr, /usage|no value|qa:/i, `${name} ${cli}`);
		}
	}
	for (const cli of CLIS) {
		const r = spawnSync('node', [path.join('dev-factory', cli)], {
			cwd: path.join(ROOT, '..'),
			encoding: 'utf8',
			env: { ...process.env, DF_STATE_DIR: os.tmpdir() },
		});
		assert.notEqual(r.status, 0, `relative ${cli}`);
	}
});

test('importing a CLI module does not run its main()', async () => {
	const r = spawnSync('node', ['-e', `import('${path.join(ROOT, 'scripts/config.mjs')}').then(() => console.log('imported'))`], {
		encoding: 'utf8',
	});
	assert.equal(r.stdout.trim(), 'imported');
	assert.equal(r.stderr, '');
});
