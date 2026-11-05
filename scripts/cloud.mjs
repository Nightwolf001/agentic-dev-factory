// Sets a repository up so the factory runs where there is no developer machine: Claude Code on the web (cloud sessions
// install the plugin from the committed project settings), a GitHub Actions schedule, or a Claude Code routine.
//
//   cloud.mjs init [--marketplace OWNER/REPO] [--github-actions] [--routine]
//
//   (always)          merge the marketplace and enabledPlugins into .claude/settings.json so a fresh cloud session
//                     installs dev-factory and its required plugins on start
//   --github-actions  write .github/workflows/dev-factory-tick.yml (a pass every scheduler.intervalMinutes, state cached between runs)
//   --routine         write .mcp.json with the servers this project wants and approve them in .claude/settings.json, then print how
//                     to schedule /dev-factory:tick as a Claude Code routine. A routine has no ~/.claude.json, so it reads committed
//                     files. This is the one place the factory writes .mcp.json: variable references only, never a value, and only its own ids.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, layers, load } from './config.mjs';
import { isMain } from './is-main.mjs';
import { catalog, desired, serverConfig } from './mcp-scope.mjs';
import { PLUGIN_ROOT } from './plugin-root.mjs';

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// OWNER/REPO of the marketplace that serves this plugin: the --marketplace argument, else plugin.json's repository URL.
export function marketplaceRepo(arg, pluginJson = read(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))) {
	if (arg) return arg;
	// owner/name, where the name may contain dots (my.repo); a trailing .git or slash is not part of it
	const m = /github\.com[/:]([^/\s]+\/[^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/.exec(pluginJson.repository ?? '');
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

// The committed .mcp.json for a routine: the servers the project wants, written from the catalog as variable references. Merged into
// what is there: an entry the factory writes replaces only its own id, so a server the person added by hand and every other key stay.
// A server that starts through this machine's launcher (the jira server) is left out: a routine has no launcher and Claude does not
// expand `~`, so the entry could not start, and a committed file must not carry this machine's folders. It is not approved either.
// -> { mcp, written, skipped }: the merged document, the ids written, the ids left out
export function routineConfig(existing, ids, cat = catalog(), env = process.env) {
	const mcp = { ...existing, mcpServers: { ...existing.mcpServers } };
	const written = [];
	const skipped = [];
	for (const id of ids) {
		if (needsLauncher(id, cat)) {
			skipped.push(id);
			continue;
		}
		mcp.mcpServers[id] = serverConfig(id, cat, env);
		written.push(id);
	}
	return { mcp, written, skipped };
}

const needsLauncher = (id, cat) => /\$\{DF_LAUNCHER/.test(String(cat[id]?.config?.command ?? ''));

export const launcherNote = (skipped) =>
	`${skipped.join(', ')} ${skipped.length > 1 ? 'need' : 'needs'} the dev-factory launcher, which a routine does not have, so ${skipped.length > 1 ? 'they are' : 'it is'} not in .mcp.json; a Jira routine needs the claude.ai Atlassian connector, or passes scheduled on a machine where dev-factory install has written the launcher`;

// settings.enabledMcpjsonServers gains the ids, without dropping or repeating what is there.
export function approveServers(existing, ids) {
	return { ...existing, enabledMcpjsonServers: [...new Set([...(existing.enabledMcpjsonServers ?? []), ...ids])] };
}

// GitHub Actions runs a schedule at most every 5 minutes, and a cron step has to divide the hour or the day.
// -> { cron, minutes, note }: the interval actually used, and why when it is not the one asked for.
export function cronFor(minutes) {
	const asked = Number(minutes);
	if (!Number.isInteger(asked) || asked < 1) throw new Error(`scheduler.intervalMinutes must be a whole number of minutes (got ${minutes})`);
	if (asked < 5) return { cron: '*/5 * * * *', minutes: 5, note: `GitHub Actions runs a schedule at most every 5 minutes, so ${asked} became 5` };
	if (asked < 60) {
		const step = [5, 6, 10, 12, 15, 20, 30].reduce((best, d) => (Math.abs(d - asked) < Math.abs(best - asked) ? d : best), 5);
		return {
			cron: `*/${step} * * * *`,
			minutes: step,
			note: step === asked ? null : `a cron step has to divide the hour, so ${asked} minutes became ${step}`,
		};
	}
	// "every N hours" in cron restarts at midnight, so only a divisor of 24 keeps the gaps equal
	const hours = [1, 2, 3, 4, 6, 8, 12, 24].reduce((best, d) => (Math.abs(d * 60 - asked) < Math.abs(best * 60 - asked) ? d : best), 1);
	return {
		cron: hours === 24 ? '0 0 * * *' : `0 */${hours} * * *`,
		minutes: hours * 60,
		note: hours * 60 === asked ? null : `a cron schedule needs whole hours that divide the day, so ${asked} minutes became ${hours * 60}`,
	};
}

export function renderWorkflow(template, repo, minutes = 5) {
	return template.replaceAll('__MARKETPLACE__', repo).replaceAll('__CRON__', cronFor(minutes).cron);
}

export const SESSION_VARIABLES = `The project settings and QA profiles are not committed (.devfactory/ stays out of git), so give the session
them as environment variables; the plugin writes the files when the session starts:
  DF_PROJECT_CONFIG   the contents of .devfactory/config.json (JSON, raw or base64)
  DF_PROJECT_QA       the contents of .devfactory/qa.yaml (YAML, raw or base64), if you keep QA profiles
Secrets (JIRA_EMAIL, JIRA_API_TOKEN, NOTION_TOKEN, ...) go in as secrets, never in these two.`;

export const routineHelp = (minutes = 5) => `Claude Code routine: in a Claude Code session in this repository run /schedule and ask for
  "a routine that runs /dev-factory:tick every ${minutes} minutes in this repository".
The routine runs in Claude's cloud, installs the plugin from .claude/settings.json, and uses your connected GitHub account.
Use tasks.source github, notion or jira (a local task source needs the task files committed, since the cloud checkout has only
what is pushed). Commit .mcp.json and .claude/settings.json so the routine finds its servers, and set runtime.mode to cloud
in the project settings if it is not detected.
${SESSION_VARIABLES}`;
export const ROUTINE_HELP = routineHelp();

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
		const readJson = (file) => {
			try {
				return read(file);
			} catch (e) {
				// only a missing file is a new file: one that exists and does not parse (a comment, a stray comma) is the person's to fix
				if (e.code === 'ENOENT') return {};
				throw new Error(`${file} exists but cannot be read as JSON (${e.message}); fix it or move it, nothing was changed`);
			}
		};
		const settingsFile = path.resolve('.claude', 'settings.json');
		const mcpFile = path.resolve('.mcp.json');
		let settings = mergeSettings(readJson(settingsFile), repo);
		let mcp = null;
		// both files are read before either is written, so one that cannot be read changes nothing
		if (flag('routine')) {
			const cat = catalog();
			const ids = desired(layers(), cat).map((w) => w.id);
			const out = routineConfig(readJson(mcpFile), ids, cat);
			mcp = out.mcp;
			settings = approveServers(settings, out.written);
			if (out.skipped.length) console.error(`note: ${launcherNote(out.skipped)}`);
		}
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		fs.writeFileSync(settingsFile, JSON.stringify(settings, null, '\t') + '\n');
		console.log(`wrote ${settingsFile}: cloud sessions install dev-factory from ${repo}`);
		if (mcp) {
			fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, '\t') + '\n');
			console.log(`wrote ${mcpFile} (variable references only; commit it with .claude/settings.json)`);
		}
		if (flag('github-actions')) {
			const template = fs.readFileSync(
				path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'dev-factory-tick.yml'),
				'utf8',
			);
			const file = path.resolve('.github', 'workflows', 'dev-factory-tick.yml');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const wanted = get('scheduler.intervalMinutes', { config: load() }) ?? 5;
			const { minutes, note } = cronFor(wanted);
			fs.writeFileSync(file, renderWorkflow(template, repo, wanted));
			console.log(
				`wrote ${file} (a pass every ${minutes} minutes${note ? `: ${note}` : ''}); add the secrets listed at its top, then run it once with workflow_dispatch`,
			);
			console.log(
				'GitHub Actions: set the repository variables DF_PROJECT_CONFIG (the contents of .devfactory/config.json) and DF_PROJECT_QA (the contents of .devfactory/qa.yaml, if you keep one); the workflow writes .devfactory/ from them before the pass.',
			);
		}
		if (flag('routine')) console.log(routineHelp(get('scheduler.intervalMinutes', { config: load() }) ?? 5));
	} catch (e) {
		console.error(`cloud: ${e.message}`);
		process.exit(1);
	}
}
