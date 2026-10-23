// Picks the task source named by tasks.source. Every source answers list({ states, staleMinutes }); local and github
// also read, create and update tasks (scripts/tasks.mjs). Jira and Notion writes go through their MCP servers.
import { get } from '../config.mjs';
import { githubSource } from './github.mjs';
import { jiraSource } from './jira.mjs';
import { localSource } from './local.mjs';
import { notionSource } from './notion.mjs';

export { STATES, isBuildable, fingerprintOf } from './common.mjs';

// Why the source cannot be read from a script right now, or null when it can.
export function missingCredentials(cfg, env = process.env) {
	const source = get('tasks.source', { config: cfg, env });
	if (source === 'jira' && (!env.JIRA_API_TOKEN || !env.JIRA_EMAIL)) return 'no Jira API token (set JIRA_API_TOKEN and JIRA_EMAIL)';
	if (source === 'notion' && !env.NOTION_TOKEN) return 'no Notion token (set NOTION_TOKEN)';
	return null;
}

export function makeSource(cfg, opts = {}) {
	const env = opts.env ?? process.env;
	switch (get('tasks.source', { config: cfg, env })) {
		case 'local':
			return localSource(cfg, opts);
		case 'github':
			return githubSource(cfg, opts);
		case 'jira':
			return jiraSource(cfg, opts);
		case 'notion':
			return notionSource(cfg, opts);
		default:
			throw new Error('tasks.source must be local, github, notion or jira');
	}
}

// Sources whose writes the scripts can do themselves, without an MCP session.
export const SCRIPTED = ['local', 'github'];
