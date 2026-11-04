// Jira task source. Preflight and listing go over the REST API with JIRA_EMAIL and JIRA_API_TOKEN, so a scheduled
// pass can decide cheaply whether there is work; everything that writes (claim, transition, comment, create) is done
// by the session through the Atlassian MCP, as skills/task-source/jira.md describes.
import { get } from '../config.mjs';
import { adfToText } from '../adf.mjs';
import { asList, matches, stateOf } from './common.mjs';

// Everything that reaches a JQL string is checked first: a project key, a label or a status name with a quote in it would end
// the string and change the query. Names the settings can legitimately hold pass; anything else is a configuration error.
const PROJECT = /^[A-Z][A-Z0-9_]*$/;
const LABEL = /^[A-Za-z0-9._:-]+$/;
const STATUS = /^[^"\\\u0000-\u001f]+$/;
const checked = (value, re, what) => {
	if (typeof value !== 'string' || !re.test(value)) throw new Error(`${what} is not usable in a Jira query`);
	return value;
};
const quote = (n) => `"${n}"`;
const names = (v) =>
	asList(v)
		.map((n) => quote(checked(n, STATUS, 'a status name')))
		.join(', ');

// JQL for one list filter. Project keys are quoted: some (MAX, for one) are reserved JQL words.
export function jql(cfg, filter = {}, env = process.env) {
	const g = (k) => get(k, { config: cfg, env });
	const states = g('sources.jira.states');
	const projects = g('sources.jira.projects')
		.map((p) => quote(checked(p, PROJECT, 'a project key')))
		.join(', ');
	const blockedLabel = checked(g('tasks.blockedLabel'), LABEL, 'tasks.blockedLabel');
	const parts = [`project in (${projects})`, 'assignee = currentUser()', `labels = "${checked(g('tasks.label'), LABEL, 'tasks.label')}"`];
	if (filter.label) parts.push(`labels = "${checked(filter.label, LABEL, 'a label')}"`);
	if (filter.notStates?.length) parts.push(`status not in (${names(filter.notStates.flatMap((s) => asList(states[s])))})`);
	if (filter.states?.length) {
		const native = filter.states.flatMap((s) => asList(states[s]));
		parts.push(`status in (${names(native)})`);
	}
	if (filter.states?.includes('ready')) {
		if (g('sources.jira.requireSprint')) parts.push('sprint in openSprints()');
		parts.push(`labels != "${blockedLabel}"`);
	}
	if (filter.staleMinutes != null) {
		const n = Number(filter.staleMinutes);
		if (!Number.isFinite(n) || n < 0) throw new Error('the stale window is not usable in a Jira query');
		parts.push(`updated <= -${Math.floor(n)}m`);
	}
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
		// the ticket's comments, oldest first, as text: [{ id, author, created, body }]
		async comments(key) {
			if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(String(key))) throw new Error(`${key} is not a Jira issue key`);
			// paged: a reply is the newest comment, which is on the last page of a long thread
			const all = [];
			for (let startAt = 0, pages = 0; pages < 50; pages++) {
				const r = await fetchImpl(`https://${site}/rest/api/3/issue/${key}/comment?orderBy=created&maxResults=100&startAt=${startAt}`, {
					headers: { Authorization: auth, Accept: 'application/json' },
				});
				if (!r.ok) throw new Error(`jira comments ${r.status}`);
				const page = await r.json();
				const got = page.comments ?? [];
				all.push(...got);
				startAt += got.length;
				if (!got.length || startAt >= (page.total ?? startAt)) break;
			}
			return all.map((c) => ({
				id: String(c.id),
				author: c.author?.accountId ?? c.author?.displayName ?? null,
				created: c.created,
				body: typeof c.body === 'string' ? c.body : adfToText(c.body),
			}));
		},
	};
}
