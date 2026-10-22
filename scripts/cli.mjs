// One entry point for the things a person runs in a terminal, so nobody has to know where the plugin is installed:
//
//   dev-factory doctor [--ci|--wizard]     check this machine and the configuration
//   dev-factory install [--apply] [--load] launchers, plugins and the scheduler for this repository
//   dev-factory mcp list|enable|connect... optional MCP servers
//   dev-factory tasks list|create|init...  tasks in the configured task source
//   dev-factory config get|validate        read the merged configuration
//   dev-factory tick | improve             run one scheduled pass now
//   dev-factory cloud init [--github-actions]  set the repository up for Claude Code on the web or GitHub Actions
//   dev-factory qa|worktree|env ...        the QA recorder, worktree helper and environment script
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
	tasks: ['node', 'scripts/tasks.mjs'],
	config: ['node', 'scripts/config.mjs'],
	tick: ['bash', 'scripts/tick.sh'],
	improve: ['bash', 'scripts/improve.sh'],
	cloud: ['node', 'scripts/cloud.mjs'],
	qa: ['node', 'bin/qa.mjs'],
	worktree: ['node', 'scripts/worktree.mjs'],
	env: ['bash', 'scripts/e2e-env.sh'],
};

export function resolve(argv) {
	const [name, ...rest] = argv;
	if (name === 'path') return { print: PLUGIN_ROOT };
	const found = COMMANDS[name];
	if (!found) return { usage: `usage: dev-factory ${[...Object.keys(COMMANDS), 'path'].join('|')} [args]` };
	return { cmd: found[0], args: [path.join(PLUGIN_ROOT, found[1]), ...rest] };
}

if (isMain(import.meta.url)) {
	const r = resolve(process.argv.slice(2));
	if (r.print) console.log(r.print);
	else if (r.usage) {
		console.error(r.usage);
		process.exit(3);
	} else process.exit(spawnSync(r.cmd, r.args, { stdio: 'inherit' }).status ?? 1);
}
