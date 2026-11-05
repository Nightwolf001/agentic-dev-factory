// One entry point for the things a person runs in a terminal, so nobody has to know where the plugin is installed:
//
//   dev-factory doctor [--ci|--wizard]     check this machine and the configuration
//   dev-factory install [--apply] [--load] [--isolate]  launchers, plugins and the scheduler for this repository (--isolate: a state folder of its own)
//   dev-factory mcp list|enable|connect... optional MCP servers
//   dev-factory plugins sync|list          companion plugins, for all projects or this one
//   dev-factory settings [list|set|reset]  every server, plugin, secret and setting with its value and source; edit them on a page
//   dev-factory migrate [--apply]          move this repository's old settings and QA files into .devfactory/
//   dev-factory tasks list|create|init...  tasks in the configured task source
//   dev-factory config get|validate|...    read the layered configuration; write-from-env fills .devfactory/ from DF_PROJECT_*
//   dev-factory scheduler on|off|status    switch the scheduled passes of this repository on or off
//   dev-factory tick | improve             run one scheduled pass now
//   dev-factory cloud init [--github-actions]  set the repository up for Claude Code on the web or GitHub Actions
//   dev-factory qa|worktree|env ...        the QA recorder, worktree helper and environment script
//   dev-factory cleanup                    tear down what a run left: its stack, dev server, browser and Maestro sessions
//   dev-factory import-env [--apply]       move an older plugin-directory .env.local into the state folder (dry run unless --apply)
//   dev-factory update [--check]           update every installed copy of the plugin and remove stale cached versions
//   dev-factory target                     where an improvement to the factory itself can be made from here
//   dev-factory path                       print the plugin directory
//
// `dev-factory` is bin/dev-factory (on PATH while the plugin is enabled in a Claude Code session) and the launcher that
// `install` writes to ~/.dev-factory/bin/dev-factory (always the newest installed version).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { isMain } from './is-main.mjs';
import { PLUGIN_ROOT } from './plugin-root.mjs';

export const COMMANDS = {
	doctor: ['bash', 'scripts/doctor.sh'],
	install: ['bash', 'scripts/install.sh'],
	mcp: ['node', 'scripts/mcp.mjs'],
	plugins: ['node', 'scripts/plugins.mjs'],
	tasks: ['node', 'scripts/tasks.mjs'],
	config: ['node', 'scripts/config.mjs'],
	settings: ['node', 'scripts/settings.mjs'],
	// a fixed extra argument follows the script: `dev-factory migrate` is `project-dir.mjs migrate`
	migrate: ['node', 'scripts/project-dir.mjs', 'migrate'],
	tick: ['bash', 'scripts/tick.sh'],
	improve: ['bash', 'scripts/improve.sh'],
	scheduler: ['bash', 'scripts/scheduler.sh'],
	cloud: ['node', 'scripts/cloud.mjs'],
	target: ['node', 'scripts/factory-target.mjs'],
	qa: ['node', 'bin/qa.mjs'],
	worktree: ['node', 'scripts/worktree.mjs'],
	env: ['bash', 'scripts/e2e-env.sh'],
	cleanup: ['node', 'scripts/cleanup.mjs'],
	update: ['node', 'scripts/update.mjs'],
	'import-env': ['bash', 'scripts/import-env.sh'],
	'jira-mcp': ['node', 'scripts/jira-mcp.mjs'],
};

// A repository that `install --isolate` gave a state folder of its own runs every command on that folder, as its scheduled passes do:
// the folder df_state_dir (scripts/runtime.sh) picks, unless DF_STATE_DIR already names one. null means nothing to change.
export function stateDirFor(env = process.env) {
	if (env.DF_STATE_DIR) return null;
	const r = spawnSync('bash', ['-c', `DIR="${PLUGIN_ROOT}"; . "${PLUGIN_ROOT}/scripts/runtime.sh"; df_state_dir; echo; df_machine_dir`], {
		encoding: 'utf8',
		env,
	});
	const [own, machine] = (r.stdout || '').split('\n');
	return r.status === 0 && own && own !== machine ? own : null;
}

// install and import-env work on the machine folder itself.
const MACHINE_WIDE = new Set(['install', 'import-env']);

export function resolve(argv) {
	const [name, ...rest] = argv;
	if (name === 'path') return { print: PLUGIN_ROOT };
	const found = COMMANDS[name];
	if (!found) return { usage: `usage: dev-factory ${[...Object.keys(COMMANDS), 'path'].join('|')} [args]` };
	return { cmd: found[0], args: [path.join(PLUGIN_ROOT, found[1]), ...found.slice(2), ...rest] };
}

if (isMain(import.meta.url)) {
	const r = resolve(process.argv.slice(2));
	if (r.print) console.log(r.print);
	else if (r.usage) {
		console.error(r.usage);
		process.exit(3);
	} else {
		const dir = MACHINE_WIDE.has(process.argv[2]) ? null : stateDirFor();
		process.exit(spawnSync(r.cmd, r.args, { stdio: 'inherit', env: dir ? { ...process.env, DF_STATE_DIR: dir } : process.env }).status ?? 1);
	}
}
