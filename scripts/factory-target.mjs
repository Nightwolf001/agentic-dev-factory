// Where an improvement to the factory itself can be made from here. The factory is changed in a checkout of its own source:
//   self      the repository you are in is the plugin's own repository (you are developing the plugin)
//   clone     improvement.factoryRepo (or DF_FACTORY_REPO) names a local checkout of the plugin's repository, so the scan
//             can run from any project and still change the factory in its source repository
//   vendored  the plugin is copied into this repository at dev-factory/
//   none      an installed plugin lives in Claude's plugin cache, which no improvement touches
//
//   factory-target.mjs        print {"mode","repo","prefix","reason"} for the current directory
//
// `prefix` is the folder of the factory inside `repo` ('' for self and clone, 'dev-factory/' for vendored); it goes into the
// improver's run.json as factoryPrefix, and the guards confine the improver to it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';

export function isPluginRepo(dir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name === 'dev-factory';
	} catch {
		return false;
	}
}

const gitRoot = (cwd) => {
	try {
		return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return null;
	}
};

const expand = (p) => path.resolve(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

export function resolveTarget({ cfg = load(), cwd = process.cwd(), env = process.env } = {}) {
	const configured = get('improvement.factoryRepo', { config: cfg, env });
	if (configured) {
		const dir = expand(configured);
		if (!gitRoot(dir)) return { mode: 'none', reason: `improvement.factoryRepo ${dir} is not a git checkout` };
		if (!isPluginRepo(dir))
			return {
				mode: 'none',
				reason: `improvement.factoryRepo ${dir} is not a checkout of the dev-factory repository (no .claude-plugin/plugin.json named dev-factory)`,
			};
		return { mode: 'clone', repo: dir, prefix: '' };
	}
	const root = gitRoot(cwd);
	if (!root) return { mode: 'none', reason: 'not inside a git repository' };
	if (isPluginRepo(root)) return { mode: 'self', repo: root, prefix: '' };
	if (isPluginRepo(path.join(root, 'dev-factory'))) return { mode: 'vendored', repo: root, prefix: 'dev-factory/' };
	return {
		mode: 'none',
		reason: 'the plugin is installed from the marketplace, outside this repository; set improvement.factoryRepo (or DF_FACTORY_REPO) to a checkout of the dev-factory repository, or run the scan from that checkout',
	};
}

if (isMain(import.meta.url)) console.log(JSON.stringify(resolveTarget()));
