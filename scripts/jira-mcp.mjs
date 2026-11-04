// A small MCP server (stdio) for Jira on an API token. The Atlassian MCP server signs in with OAuth, which does not survive an
// unattended pass, and its API-token mode offers no Jira tools; this one talks to Jira's REST API with JIRA_EMAIL and JIRA_API_TOKEN
// and offers the same tool names the task-source skill uses, so the skill needs no change.
//
//   JIRA_SITE         the Jira host (example.atlassian.net); else sources.jira.site from the settings
//   JIRA_EMAIL, JIRA_API_TOKEN   read from the environment of the pass; never written to a file (scripts/jira-mcp-config.mjs
//                                writes a server entry that holds neither)
//
// Tools: getJiraIssue, searchJiraIssuesUsingJql, getTransitionsForJiraIssue, transitionJiraIssue, addCommentToJiraIssue,
// editJiraIssue, createJiraIssue, addRemoteLinkToJiraIssue, lookupJiraAccountId, uploadAttachmentToJiraIssue. Comments and
// descriptions go in and out as text (see scripts/adf.mjs): `[~accountid:ID]` in a comment becomes a real mention.
//
// uploadAttachmentToJiraIssue reads only .dev-factory/evidence/<KEY>/run-N/ of the same ticket's worktree, takes a bare file name,
// refuses a link that leads out of that folder, and does not upload a file already attached with the same name and size.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { adfToText, textToAdf } from './adf.mjs';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const BARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/;

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

export function makeTools({ site, email, token, fetchImpl = fetch, roots = null }) {
	const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
	const base = `https://${site}/rest/api/3`;
	const call = async (method, p, body, extra = {}) => {
		const r = await fetchImpl(`${base}${p}`, {
			method,
			headers: {
				Authorization: auth,
				Accept: 'application/json',
				...(body && !extra.form ? { 'Content-Type': 'application/json' } : {}),
				...(extra.headers ?? {}),
			},
			body: extra.form ?? (body ? JSON.stringify(body) : undefined),
		});
		if (!r.ok) throw new Error(`Jira ${method} ${p.split('?')[0].replace(/\/[A-Z][A-Z0-9_]*-\d+/g, '/<issue>')} answered ${r.status}`);
		return r.status === 204 ? null : r.json().catch(() => null);
	};
	const issueKey = (v) => {
		if (!KEY.test(String(v))) throw new Error('issueIdOrKey must be an issue key such as APP-12');
		return String(v);
	};
	const flatten = (i) => ({
		key: i.key,
		summary: i.fields?.summary,
		status: i.fields?.status?.name,
		labels: i.fields?.labels ?? [],
		issuetype: i.fields?.issuetype?.name,
		assignee: i.fields?.assignee ? { accountId: i.fields.assignee.accountId, displayName: i.fields.assignee.displayName } : null,
		reporter: i.fields?.reporter ? { accountId: i.fields.reporter.accountId, displayName: i.fields.reporter.displayName } : null,
		description: i.fields?.description ? (typeof i.fields.description === 'string' ? i.fields.description : adfToText(i.fields.description)) : '',
		comments: (i.fields?.comment?.comments ?? []).map((c) => ({
			id: c.id,
			author: c.author?.accountId,
			created: c.created,
			body: typeof c.body === 'string' ? c.body : adfToText(c.body),
		})),
		issuelinks: i.fields?.issuelinks ?? [],
		attachments: (i.fields?.attachment ?? []).map((a) => ({ filename: a.filename, size: a.size })),
	});

	return {
		getJiraIssue: {
			description: 'Read one Jira issue (summary, status, labels, people, description and comments as text).',
			input: { issueIdOrKey: 'string' },
			async run({ issueIdOrKey }) {
				const k = issueKey(issueIdOrKey);
				return flatten(
					await call(
						'GET',
						`/issue/${k}?fields=summary,status,labels,issuetype,assignee,reporter,description,comment,issuelinks,attachment`,
					),
				);
			},
		},
		searchJiraIssuesUsingJql: {
			description: 'Search issues with JQL.',
			input: { jql: 'string', maxResults: 'number?', fields: 'string[]?' },
			async run({ jql, maxResults = 50, fields }) {
				if (typeof jql !== 'string' || !jql) throw new Error('jql is required');
				const f = (fields ?? ['summary', 'status', 'labels', 'issuetype', 'updated', 'issuelinks'])
					.filter((x) => /^[A-Za-z_.]+$/.test(x))
					.join(',');
				const r = await call(
					'GET',
					`/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${Math.min(100, Number(maxResults) || 50)}&fields=${f}`,
				);
				return { issues: (r?.issues ?? []).map((i) => ({ key: i.key, fields: i.fields })) };
			},
		},
		getTransitionsForJiraIssue: {
			description: 'The transitions this issue offers, with the status each leads to.',
			input: { issueIdOrKey: 'string' },
			async run({ issueIdOrKey }) {
				const r = await call('GET', `/issue/${issueKey(issueIdOrKey)}/transitions`);
				return { transitions: (r?.transitions ?? []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name })) };
			},
		},
		transitionJiraIssue: {
			description: 'Move an issue with a transition id from getTransitionsForJiraIssue.',
			input: { issueIdOrKey: 'string', transition: '{ id: string }' },
			async run({ issueIdOrKey, transition }) {
				if (!transition?.id) throw new Error('transition.id is required');
				await call('POST', `/issue/${issueKey(issueIdOrKey)}/transitions`, { transition: { id: String(transition.id) } });
				return { ok: true };
			},
		},
		addCommentToJiraIssue: {
			description:
				'Add a comment. commentBody is text (blank lines separate paragraphs, [~accountid:ID] is a real mention) or an Atlassian Document Format document ({ type: "doc", ... }), which is sent as it is.',
			input: { issueIdOrKey: 'string', commentBody: 'string | object' },
			async run({ issueIdOrKey, commentBody }) {
				const isDoc = commentBody && typeof commentBody === 'object' && commentBody.type === 'doc' && Array.isArray(commentBody.content);
				if (!isDoc && (typeof commentBody !== 'string' || !commentBody.trim())) throw new Error('commentBody is required');
				const r = await call('POST', `/issue/${issueKey(issueIdOrKey)}/comment`, { body: isDoc ? commentBody : textToAdf(commentBody) });
				return { id: r?.id };
			},
		},
		editJiraIssue: {
			description: 'Change labels: update.labels is a list of { add } / { remove }. Other fields are not changed from here.',
			input: { issueIdOrKey: 'string', update: '{ labels: [{ add?: string, remove?: string }] }' },
			async run({ issueIdOrKey, update }) {
				const labels = (update?.labels ?? []).filter((l) => (l.add ?? l.remove) && /^[A-Za-z0-9._:-]+$/.test(l.add ?? l.remove));
				if (!labels.length) throw new Error('update.labels needs at least one { add } or { remove } with a label name');
				await call('PUT', `/issue/${issueKey(issueIdOrKey)}`, { update: { labels } });
				return { ok: true };
			},
		},
		createJiraIssue: {
			description: 'Create an issue.',
			input: {
				projectKey: 'string',
				issueTypeName: 'string',
				summary: 'string',
				description: 'string?',
				labels: 'string[]?',
				assigneeAccountId: 'string?',
			},
			async run({ projectKey, issueTypeName, summary, description = '', labels = [], assigneeAccountId }) {
				if (!/^[A-Z][A-Z0-9_]*$/.test(projectKey ?? '')) throw new Error('projectKey is not a project key');
				const fields = {
					project: { key: projectKey },
					issuetype: { name: issueTypeName },
					summary,
					description: textToAdf(description),
					labels,
				};
				if (assigneeAccountId) fields.assignee = { accountId: assigneeAccountId };
				const r = await call('POST', '/issue', { fields });
				return { key: r?.key };
			},
		},
		addRemoteLinkToJiraIssue: {
			description: 'Link a URL (a branch, a pull request) to an issue.',
			input: { issueIdOrKey: 'string', url: 'string', title: 'string' },
			async run({ issueIdOrKey, url, title }) {
				if (!/^https:\/\/\S+$/.test(url ?? '')) throw new Error('url must be an https address');
				await call('POST', `/issue/${issueKey(issueIdOrKey)}/remotelink`, { object: { url, title: String(title ?? url).slice(0, 255) } });
				return { ok: true };
			},
		},
		lookupJiraAccountId: {
			description: 'Find an account id by name or email, for a mention.',
			input: { searchString: 'string' },
			async run({ searchString }) {
				const r = await call('GET', `/user/search?query=${encodeURIComponent(String(searchString ?? ''))}&maxResults=5`);
				return { users: (r ?? []).map((u) => ({ accountId: u.accountId, displayName: u.displayName })) };
			},
		},
		uploadAttachmentToJiraIssue: {
			description:
				'Attach one evidence file of this ticket: worktree is the ticket worktree, run the QA run number, fileName a bare file name.',
			input: { issueIdOrKey: 'string', worktree: 'string', run: 'number', fileName: 'string' },
			async run({ issueIdOrKey, worktree, run, fileName }) {
				const k = issueKey(issueIdOrKey);
				if (!BARE_NAME.test(fileName ?? '') || fileName.includes('..')) throw new Error('fileName must be a bare file name');
				if (!Number.isInteger(run) || run < 1) throw new Error('run must be a QA run number');
				const wt = fs.realpathSync(path.resolve(String(worktree ?? '')));
				if (roots && !roots.some((r) => wt === r || wt.startsWith(r + path.sep)))
					throw new Error('that worktree is not one of this repository’s');
				let belongs = false;
				try {
					belongs = JSON.parse(fs.readFileSync(path.join(wt, '.dev-factory', 'run.json'), 'utf8')).key === k;
				} catch {
					/* no run.json */
				}
				if (!belongs) throw new Error('that worktree is not the one for this issue');
				// the run's folder itself may be a link: it has to resolve to where it is written, inside this worktree's evidence
				const evidence = path.join(wt, '.dev-factory', 'evidence', k);
				const dir = fs.realpathSync(path.join(evidence, `run-${run}`));
				if (dir !== path.join(fs.realpathSync(evidence), `run-${run}`))
					throw new Error('the run’s evidence folder is a link out of the worktree');
				const file = fs.realpathSync(path.join(dir, fileName));
				if (!file.startsWith(dir + path.sep)) throw new Error('that file is not inside the run’s evidence folder');
				const size = fs.statSync(file).size;
				if (size > MAX_UPLOAD_BYTES) throw new Error(`the file is ${size} bytes; Jira takes at most ${MAX_UPLOAD_BYTES}`);
				const have = (await call('GET', `/issue/${k}?fields=attachment`))?.fields?.attachment ?? [];
				if (have.some((a) => a.filename === fileName && a.size === size)) return { skipped: 'already attached', fileName, size };
				const form = new FormData();
				form.append('file', new Blob([fs.readFileSync(file)]), fileName);
				await call('POST', `/issue/${k}/attachments`, null, { form, headers: { 'X-Atlassian-Token': 'no-check' } });
				return { attached: fileName, size };
			},
		},
	};
}

// The input notation of a tool ('string', 'number?', 'string[]?', '{ ... }', 'string | object') as a JSON schema: the type of each
// property, and which of them are required (those not marked with a trailing ?).
export function schemaFor(input) {
	const TYPES = { string: 'string', number: 'number', object: 'object', boolean: 'boolean' };
	const one = (t) => {
		if (t.endsWith('[]')) return { type: 'array', items: one(t.slice(0, -2)) };
		if (t.startsWith('{')) return { type: 'object' };
		return TYPES[t] ? { type: TYPES[t] } : {};
	};
	const properties = {};
	const required = [];
	for (const [name, notation] of Object.entries(input)) {
		const optional = notation.endsWith('?');
		const text = optional ? notation.slice(0, -1) : notation;
		const parts = text.split('|').map((x) => x.trim());
		const schemas = parts.map(one);
		properties[name] = { ...(schemas.length > 1 ? { anyOf: schemas } : schemas[0]), description: notation };
		if (!optional) required.push(name);
	}
	return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: true };
}

// ---- the MCP protocol: newline-delimited JSON-RPC over stdio ----
export async function handle(msg, tools) {
	const { id, method, params } = msg;
	const reply = (result) => ({ jsonrpc: '2.0', id, result });
	const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
	if (id === undefined) return null; // a notification: nothing to answer
	switch (method) {
		case 'initialize':
			return reply({
				protocolVersion: params?.protocolVersion ?? '2025-03-26',
				capabilities: { tools: {} },
				serverInfo: { name: 'dev-factory-jira', version: '1' },
			});
		case 'ping':
			return reply({});
		case 'tools/list':
			return reply({
				tools: Object.entries(tools).map(([name, t]) => ({
					name,
					description: t.description,
					inputSchema: schemaFor(t.input),
				})),
			});
		case 'tools/call': {
			const tool = tools[params?.name];
			if (!Object.hasOwn(tools, params?.name ?? '') || !tool) return error(-32602, `unknown tool ${params?.name}`);
			try {
				return reply(text(await tool.run(params.arguments ?? {})));
			} catch (e) {
				return reply(fail(e.message));
			}
		}
		default:
			return error(-32601, `method not found: ${method}`);
	}
}

export function configFromEnv(env = process.env) {
	let site = env.JIRA_SITE;
	if (!site) {
		try {
			site = get('sources.jira.site', { config: load() });
		} catch {
			/* no readable config */
		}
	}
	return { site, email: env.JIRA_EMAIL, token: env.JIRA_API_TOKEN };
}

// The worktrees of the repository the server was started in: an upload can only come from one of them.
export function worktreeRoots(cwd = process.cwd()) {
	const out = new Set();
	try {
		const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		for (const line of list.split('\n'))
			if (line.startsWith('worktree ')) {
				try {
					out.add(fs.realpathSync(line.slice(9)));
				} catch {
					/* a worktree that is gone */
				}
			}
	} catch {
		/* not a repository: nothing is allowed below */
	}
	return [...out];
}

if (isMain(import.meta.url)) {
	const cfg = { ...configFromEnv(), roots: worktreeRoots() };
	const missing = ['site', 'email', 'token'].filter((k) => !cfg[k]);
	if (missing.length) {
		console.error(
			`jira-mcp: missing ${missing.map((k) => ({ site: 'JIRA_SITE (or sources.jira.site)', email: 'JIRA_EMAIL', token: 'JIRA_API_TOKEN' })[k]).join(', ')}`,
		);
		process.exit(1);
	}
	const tools = makeTools(cfg);
	const rl = readline.createInterface({ input: process.stdin });
	rl.on('line', async (line) => {
		if (!line.trim()) return;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		const out = await handle(msg, tools);
		if (out) process.stdout.write(JSON.stringify(out) + '\n');
	});
}
