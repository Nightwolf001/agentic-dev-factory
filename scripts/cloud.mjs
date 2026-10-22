// Sets a repository up so the factory runs where there is no developer machine: Claude Code on the web (cloud sessions
// install the plugin from the committed project settings), a GitHub Actions schedule, or a Claude Code routine.
//
//   cloud.mjs init [--marketplace OWNER/REPO] [--github-actions] [--routine]
//
//   (always)          merge the marketplace and enabledPlugins into .claude/settings.json so a fresh cloud session
//                     installs dev-factory and its required plugins on start
//   --github-actions  write .github/workflows/dev-factory-tick.yml (a pass every 15 minutes, state cached between runs)
//   --routine         print how to schedule /dev-factory:tick as a Claude Code routine
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { PLUGIN_ROOT } from './plugin-root.mjs';

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// OWNER/REPO of the marketplace that serves this plugin: the --marketplace argument, else plugin.json's repository URL.
export function marketplaceRepo(arg, pluginJson = read(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))) {
	if (arg) return arg;
	const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(pluginJson.repository ?? '');
	if (!m) throw new Error('no marketplace repository: pass --marketplace OWNER/REPO (plugin.json has no GitHub repository URL)');
	return m[1];
}

const OFFICIAL = { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } };

export function mergeSettings(existing, repo, required = ['superpowers@claude-plugins-official']) {
	const out = { ...existing };
	out.extraKnownMarketplaces = {
		...existing.extraKnownMarketplaces,
		'dev-factory': { source: { source: 'github', repo } },
		'claude-plugins-official': existing.extraKnownMarketplaces?.['claude-plugins-official'] ?? OFFICIAL,
	};
	out.enabledPlugins = { ...existing.enabledPlugins, 'dev-factory@dev-factory': true, ...Object.fromEntries(required.map((id) => [id, true])) };
	return out;
}

export function renderWorkflow(template, repo) {
	return template.replaceAll('__MARKETPLACE__', repo);
}

export const ROUTINE_HELP = `Claude Code routine: in a Claude Code session in this repository run /schedule and ask for
  "a routine that runs /dev-factory:tick every 15 minutes in this repository".
The routine runs in Claude's cloud, installs the plugin from .claude/settings.json, and uses your connected GitHub account.
Set runtime.mode to cloud in dev-factory.config.json if it is not detected, and use tasks.source github, notion or jira
(a local task source needs the task files committed, since the cloud checkout has only what is pushed).`;

if (isMain(import.meta.url)) {
	const argv = process.argv.slice(2);
	const flag = (n) => argv.includes(`--${n}`);
	const value = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
	if (argv[0] !== 'init') {
		console.error('usage: cloud.mjs init [--marketplace OWNER/REPO] [--github-actions] [--routine]');
		process.exit(3);
	}
	try {
		const repo = marketplaceRepo(value('marketplace'));
		const settingsFile = path.resolve('.claude', 'settings.json');
		let current = {};
		try {
			current = read(settingsFile);
		} catch {
			/* a new file */
		}
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		fs.writeFileSync(settingsFile, JSON.stringify(mergeSettings(current, repo), null, '\t') + '\n');
		console.log(`wrote ${settingsFile}: cloud sessions install dev-factory from ${repo}`);
		if (flag('github-actions')) {
			const template = fs.readFileSync(
				path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'dev-factory-tick.yml'),
				'utf8',
			);
			const file = path.resolve('.github', 'workflows', 'dev-factory-tick.yml');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, renderWorkflow(template, repo));
			console.log(`wrote ${file}; add the secrets listed at its top, then run it once with workflow_dispatch`);
		}
		if (flag('routine')) console.log(ROUTINE_HELP);
	} catch (e) {
		console.error(`cloud: ${e.message}`);
		process.exit(1);
	}
}
