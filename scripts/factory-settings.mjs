// The settings file the scheduled pass runs with: settings.factory.json plus what this repository chose. Network
// access for the task tracker and for each enabled MCP server, their permission rules, and any extra domains the
// repository lists in sandbox.extraDomains. Nothing is allowed that is not in use.
//
//   factory-settings.mjs [OUT_FILE]     write the effective settings (default: stdout)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';
import { allowRules, catalog, readProject } from './mcp.mjs';

const BASE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'settings.factory.json');

export function build({ cfg = load(), mcpFile = path.resolve('.mcp.json'), base = JSON.parse(fs.readFileSync(BASE, 'utf8')), cat = catalog() } = {}) {
	const out = JSON.parse(JSON.stringify(base));
	const domains = new Set(out.sandbox?.network?.allowedDomains ?? []);
	for (const id of Object.keys(readProject(mcpFile).mcpServers ?? {})) for (const d of cat[id]?.domains ?? []) domains.add(d);
	const source = get('tasks.source', { config: cfg });
	if (source === 'jira') {
		const site = get('sources.jira.site', { config: cfg });
		if (site) domains.add(site);
	}
	for (const d of get('sandbox.extraDomains', { config: cfg }) ?? []) domains.add(d);
	out.sandbox.network.allowedDomains = [...domains];
	out.permissions.allow = [...new Set([...out.permissions.allow, ...allowRules(mcpFile)])];
	return out;
}

if (isMain(import.meta.url)) {
	const text = JSON.stringify(build(), null, '\t') + '\n';
	if (process.argv[2]) fs.writeFileSync(process.argv[2], text);
	else process.stdout.write(text);
}
