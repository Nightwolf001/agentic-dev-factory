// Adds the Jira API-token server to the repository's .mcp.json, so a scheduled pass can use Jira without an OAuth login.
//
//   jira-mcp-config.mjs [--file .mcp.json] [--name jira] [--print]
//
// The entry holds no secret: it starts scripts/jira-mcp.mjs through the launcher `dev-factory install` writes to the state folder
// (which finds the newest installed plugin, so an update does not break it), and the server reads JIRA_EMAIL and JIRA_API_TOKEN
// from the environment of the pass, where the state folder's .env.local put them. The only value in the entry is the Jira host.
import fs from 'node:fs';
import path from 'node:path';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';

export function entry({ site } = {}) {
	return {
		command: 'bash',
		args: ['-c', 'exec node "$("${DF_STATE_DIR:-$HOME/.dev-factory}/bin/dev-factory" path)/scripts/jira-mcp.mjs"'],
		...(site ? { env: { JIRA_SITE: site } } : {}),
	};
}

export function merge(existing, name, e) {
	return { ...existing, mcpServers: { ...(existing.mcpServers ?? {}), [name]: e } };
}

if (isMain(import.meta.url)) {
	const argv = process.argv.slice(2);
	const val = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
	try {
		let site;
		try {
			site = get('sources.jira.site', { config: load() });
		} catch {
			/* the server reads the site from the settings itself */
		}
		const file = path.resolve(val('file') ?? '.mcp.json');
		const name = val('name') ?? 'jira';
		if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('--name is a server name (letters, digits, - and _)');
		let existing = {};
		try {
			existing = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch {
			/* a new file */
		}
		const out = merge(existing, name, entry({ site }));
		if (argv.includes('--print')) console.log(JSON.stringify(out, null, 2));
		else {
			fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
			console.log(`wrote ${file}: server ${name} (Jira over an API token; set JIRA_EMAIL and JIRA_API_TOKEN in the state folder's .env.local)`);
		}
	} catch (e) {
		console.error(`jira-mcp-config: ${e.message}`);
		process.exit(1);
	}
}
