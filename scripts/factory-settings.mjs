// The settings file the scheduled pass runs with: settings.factory.json plus what this repository chose. Network
// access for the task tracker and for each enabled MCP server, their permission rules, and any extra domains the
// repository lists in sandbox.extraDomains. Nothing is allowed that is not in use.
//
//   factory-settings.mjs [OUT_FILE]     write the effective settings (default: stdout)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, layers, load } from './config.mjs';
import { isMain } from './is-main.mjs';
import { takeoverOn } from './takeover.mjs';
import { allowRules, catalog, claudeListing, desired, externalServers, mainCheckout, readProject } from './mcp.mjs';

const BASE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'settings.factory.json');

// what the cleanup script and an agent under takeover run to see and stop host processes
export const TAKEOVER_EXCLUDED = ['kill *', 'pkill *', 'killall *', 'lsof *', 'ps *', 'pgrep *', 'node *cleanup.mjs*', 'dev-factory cleanup*'];

// `want` is desired(): the servers the settings turn on, whose hosts and tools the pass gets. The ids in a legacy .mcp.json and the
// `external` ones (catalog servers Claude has from elsewhere: user scope, a claude.ai connector) are added to them.
// `root` is the folder both `cfg` and `want` are read from (the main checkout), so they never come from two places.
export function build({
	env = process.env,
	root = mainCheckout() ?? process.cwd(),
	cfg = load(undefined, { from: root, env }),
	mcpFile = path.resolve('.mcp.json'),
	base = JSON.parse(fs.readFileSync(BASE, 'utf8')),
	cat = catalog(),
	want = desired(layers({ from: root, env }), cat),
	external = [],
	state = env.DF_STATE_DIR || path.join(os.homedir(), '.dev-factory'),
} = {}) {
	const out = JSON.parse(JSON.stringify(base));
	const domains = new Set(out.sandbox?.network?.allowedDomains ?? []);
	const wanted = want.map((w) => w.id);
	for (const id of new Set([...wanted, ...Object.keys(readProject(mcpFile).mcpServers ?? {}), ...external]))
		for (const d of cat[id]?.domains ?? []) domains.add(d);
	const source = get('tasks.source', { config: cfg });
	if (source === 'jira') {
		const site = get('sources.jira.site', { config: cfg });
		if (site) domains.add(site);
	}
	for (const d of get('sandbox.extraDomains', { config: cfg }) ?? []) domains.add(d);
	// null leaves the base file's choice; a cloud environment that supplies its own sandbox can switch ours off
	const sandboxOn = get('sandbox.enabled', { config: cfg });
	if (typeof sandboxOn === 'boolean') out.sandbox.enabled = sandboxOn;
	out.sandbox.network.allowedDomains = [...domains];
	// the pass keeps its locks, live-stack records and run pointer in the state folder, and e2e-env.sh (run outside the sandbox) writes there too
	out.sandbox.filesystem = { ...out.sandbox.filesystem, allowWrite: [...new Set([...(out.sandbox.filesystem?.allowWrite ?? []), state])] };
	// takeover: stopping a process or a session outside the sandbox needs those commands to run outside it (the guard still refuses the protected targets)
	if (takeoverOn({ env })) out.sandbox.excludedCommands = [...new Set([...(out.sandbox.excludedCommands ?? []), ...TAKEOVER_EXCLUDED])];
	out.permissions.allow = [...new Set([...out.permissions.allow, ...allowRules(mcpFile, [...wanted, ...external])])];
	return out;
}

if (isMain(import.meta.url)) {
	// the main checkout's settings and legacy file, also when the pass runs from a linked worktree
	const root = mainCheckout() ?? process.cwd();
	const mcpFile = path.resolve(process.env.DF_MCP_FILE || path.join(root, '.mcp.json'));
	const want = desired(layers({ from: root }), catalog());
	const external = externalServers(
		mcpFile,
		claudeListing(),
		catalog(),
		want.map((w) => w.id),
	).map((s) => s.id);
	const text = JSON.stringify(build({ root, mcpFile, want, external }), null, '\t') + '\n';
	if (process.argv[2]) fs.writeFileSync(process.argv[2], text);
	else process.stdout.write(text);
}
