import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { evaluate } from '../scripts/guard-lib.mjs';
import { PLUGIN_ROOT } from '../scripts/plugin-root.mjs';

// The settings, migrate, mcp, plugins, cloud and install commands change the person's own settings, secrets, servers and plugins:
// a factory run only reads them.
const ROLES = ['builder', 'reviewer', 'debugger', 'researcher', 'improver', 'promoter'];
const WRITERS = ['builder', 'improver', 'promoter'];
const run = (command, role, cwd = '/w') => evaluate(command, { role, branch: 'task/A-1-x', key: 'A-1', cwd });
const own = (script) => `node "${PLUGIN_ROOT}/scripts/${script}"`;

const REFUSED = [
	// settings: only the list
	'dev-factory settings',
	'dev-factory settings set mcp.servers.github true --user',
	'dev-factory settings set secret:JIRA_API_TOKEN',
	'printf %s abc | dev-factory settings set secret:JIRA_API_TOKEN',
	'dev-factory settings reset models.builder',
	`${own('settings.mjs')} set models.builder opus --project`,
	`node ${PLUGIN_ROOT}/scripts/settings.mjs reset x`,
	`${own('settings.mjs')}`,
	'node scripts/settings.mjs set models.builder opus',
	'~/.dev-factory/bin/dev-factory settings set models.builder opus',
	`node ${PLUGIN_ROOT}/scripts/cli.mjs settings set models.builder opus`,
	// migrate: only the dry run
	'dev-factory migrate --apply',
	`${own('project-dir.mjs')} migrate --apply`,
	'node scripts/project-dir.mjs migrate --apply',
	'dev-factory migrate "--apply"',
	'dev-factory migrate $flag',
	// mcp: only the reads
	'dev-factory mcp enable github',
	'dev-factory mcp disable github --user',
	'dev-factory mcp connect --all',
	'dev-factory mcp sync',
	'dev-factory mcp sync --dry-run',
	'dev-factory mcp migrate --apply',
	'dev-factory mcp write-config',
	'dev-factory mcp',
	`${own('mcp.mjs')} enable github`,
	`${own('mcp.mjs')} write-config`,
	'node scripts/mcp.mjs sync',
	// plugins: only the list
	'dev-factory plugins sync',
	'dev-factory plugins',
	`${own('plugins.mjs')} sync`,
	// cloud: nothing
	'dev-factory cloud init',
	'dev-factory cloud init --routine',
	`${own('cloud.mjs')} init --github-actions`,
	// install: only the dry run (--apply syncs servers and plugins)
	'dev-factory install --apply',
	`bash "${PLUGIN_ROOT}/scripts/install.sh" --apply`,
	// written so that the text does not show the word
	'dev-factory "settings" set x y',
	"dev-factory 'mcp' 'enable' github",
	'dev-factory mcp en""able github',
	'dev-factory settings {set,list} x y',
	'cmd=sync; dev-factory mcp $cmd',
	'dev-factory mcp $(echo sync)',
	'node scripts/SETTINGS.MJS set x y',
	'node --no-warnings scripts/mcp.mjs enable x',
	'env A=1 dev-factory plugins sync',
	'command dev-factory mcp sync',
	'bash -c "dev-factory mcp sync"',
	"sh -c 'node scripts/settings.mjs set x y'",
	'bash -lc "dev-factory plugins sync"',
	'bash ~/.dev-factory/bin/dev-factory settings set x y',
	'cd /tmp && dev-factory mcp sync',
	'x=$(dev-factory mcp enable github)',
	`P=${PLUGIN_ROOT}; node $P/scripts/settings.mjs set x y`,
	// the command word itself built at run time
	'x=settings; dev-factory $x set a b',
	'dev-factory $(echo settings) set a b',
	'dev-factory {settings,} set a b',
	'dev-factory "$X" set a b',
	'dev-factory `echo settings` set a b',
	`node ${PLUGIN_ROOT}/scripts/cli.mjs $C sync`,
	'bash -c "x=settings; dev-factory $x set a b"',
	'bash -c "dev-factory $(echo settings) set a b"',
	"bash -c 'dev-factory {settings,} set a b'",
	'bash -c \'dev-factory "$X" set a b\'',
	`bash -c "node ${PLUGIN_ROOT}/scripts/cli.mjs $C sync"`,
];

const READS = [
	'dev-factory settings list',
	'dev-factory settings list --json',
	`${own('settings.mjs')} list`,
	'dev-factory migrate',
	`${own('project-dir.mjs')} migrate`,
	'dev-factory mcp list',
	'dev-factory mcp recommend',
	'dev-factory mcp doctor --lenient',
	'dev-factory mcp secrets',
	'dev-factory mcp allow',
	`${own('mcp.mjs')} list`,
	'dev-factory plugins list',
	`${own('plugins.mjs')} list`,
	'cat scripts/settings.mjs',
	'git diff -- scripts/mcp.mjs',
	'node --test test/settings.test.mjs',
];

test('no factory role changes the settings, servers or plugins through the factory’s own commands', () => {
	for (const role of ROLES) for (const c of REFUSED) assert.equal(run(c, role).deny, true, `${role}: ${c}`);
});

test('the reading forms of those commands stay allowed for the roles that write files', () => {
	for (const role of WRITERS) for (const c of READS) assert.equal(run(c, role).deny, false, `${role}: ${c} (${run(c, role).reason ?? ''})`);
});

test('the scheduler (no role) runs them all', () => {
	for (const c of [...REFUSED.slice(0, 20), 'dev-factory mcp write-config']) assert.equal(evaluate(c, { cwd: '/w' }).deny, false, c);
});

test('a repository’s own script of the same name is not the factory’s: only a scripts folder of the plugin is matched', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'df-guard-writers-'));
	try {
		const repo = path.join(tmp, 'app');
		fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
		fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
		for (const role of WRITERS) {
			const r = (c) => run(c, role, repo).deny;
			// the repository's own scripts: a scripts folder in a root with no bin/qa.mjs and no plugin manifest, or any other folder
			assert.equal(r('node scripts/config.mjs set port 3000'), false, `${role}: the repository's own config.mjs`);
			assert.equal(r('node scripts/settings.mjs set x y'), false, `${role}: the repository's own settings.mjs`);
			assert.equal(r('node src/mcp.mjs sync'), false, `${role}: a script outside a scripts folder`);
			assert.equal(r('node config.mjs write-from-env'), false, `${role}: a script at the top of the repository`);
			// (a promoter runs no shell writer at all, so `install` in its command is refused by its own rule)
			if (role !== 'promoter') assert.equal(r('bash scripts/install.sh --apply'), false, `${role}: the repository's own install.sh`);
			// the plugin, wherever it is: its own folder, a vendored copy, or any root that holds bin/qa.mjs
			assert.equal(r(`${own('config.mjs')} write-from-env`), true, role);
			assert.equal(r(`cd ${PLUGIN_ROOT}/scripts && node settings.mjs set x y`), true, `${role}: cd into the plugin first`);
		}
		fs.mkdirSync(path.join(repo, 'bin'));
		fs.writeFileSync(path.join(repo, 'bin', 'qa.mjs'), '');
		assert.equal(run('node scripts/settings.mjs set x y', 'builder', repo).deny, true, 'a root holding bin/qa.mjs is a copy of the plugin');
		const vendored = path.join(repo, 'dev-factory');
		fs.mkdirSync(path.join(vendored, '.claude-plugin'), { recursive: true });
		fs.writeFileSync(path.join(vendored, '.claude-plugin', 'plugin.json'), '{}');
		assert.equal(run('node dev-factory/scripts/mcp.mjs sync', 'builder', repo).deny, true, 'a vendored copy');
		// a folder that is not there cannot be told apart from the plugin: refused
		assert.equal(run('node scripts/settings.mjs set x y', 'builder', path.join(tmp, 'missing')).deny, true);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
