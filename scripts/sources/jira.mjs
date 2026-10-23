// Jira task source. Preflight and listing go over the REST API with JIRA_EMAIL and JIRA_API_TOKEN, so a scheduled
// pass can decide cheaply whether there is work; everything that writes (claim, transition, comment, create) is done
// by the session through the Atlassian MCP, as skills/task-source/jira.md describes.
import { get } from '../config.mjs';
import { asList, matches, stateOf } from './common.mjs';

const quote = (n) => `"${n}"`;
const names = (v) => asList(v).map(quote).join(', ');

// JQL for one list filter. Project keys are quoted: some (MAX, for one) are reserved JQL words.
export function jql(cfg, filter = {}, env = process.env) {
	const g = (k) => get(k, { config: cfg, env });
	const states = g('sources.jira.states');
	const projects = g('sources.jira.projects').map(quote).join(', ');
	const parts = [`project in (${projects})`, 'assignee = currentUser()', `labels = "${g('tasks.label')}"`];
	if (filter.states?.length) {
		const native = filter.states.flatMap((s) => asList(states[s]));
		parts.push(`status in (${names(native)})`);
	}
	if (filter.states?.includes('ready')) {
		if (g('sources.jira.requireSprint')) parts.push('sprint in openSprints()');
		parts.push(`labels != "${g('tasks.blockedLabel')}"`);
	}
	if (filter.staleMinutes != null) parts.push(`updated <= -${filter.staleMinutes}m`);
	return `${parts.join(' AND ')}${filter.states?.includes('ready') ? ' ORDER BY Rank ASC' : ''}`;
}

export function normalise(issue, cfg, env = process.env) {
	const states = get('sources.jira.states', { config: cfg, env });
	const done = (st) => stateOf(st?.name, states) === 'done' || st?.statusCategory?.key === 'done';
	return {
		key: issue.key,
		title: issue.fields?.summary,
		state: stateOf(issue.fields?.status?.name, states),
		updated: issue.fields?.updated,
		labels: issue.fields?.labels ?? [],
		type: issue.fields?.issuetype?.name ?? 'task',
		blockedBy: (issue.fields?.issuelinks ?? [])
			.filter((l) => l.type?.inward === 'is blocked by' && l.inwardIssue)
			.map((l) => ({ key: l.inwardIssue.key, done: done(l.inwardIssue.fields?.status) })),
	};
}

export function jiraSource(cfg, { env = process.env, fetchImpl = fetch } = {}) {
	const site = get('sources.jira.site', { config: cfg, env });
	const auth = 'Basic ' + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
	return {
		name: 'jira',
		async list(filter = {}) {
			const url = `https://${site}/rest/api/3/search/jql?jql=${encodeURIComponent(jql(cfg, filter, env))}&fields=summary,status,updated,labels,issuetype,issuelinks&maxResults=50`;
			const r = await fetchImpl(url, { headers: { Authorization: auth, Accept: 'application/json' } });
			if (!r.ok) throw new Error(`jira search ${r.status}`);
			return ((await r.json()).issues ?? []).map((i) => normalise(i, cfg, env)).filter((t) => matches(t, filter));
		},
	};
}
