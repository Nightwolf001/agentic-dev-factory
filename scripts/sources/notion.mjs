// Notion task source. Listing goes over the Notion API with NOTION_TOKEN (an internal integration shared with the
// database), so a scheduled pass can decide cheaply whether there is work; everything that writes is done by the
// session through the Notion MCP, as skills/task-source/notion.md describes.
//
// The database needs a title, a Status (status or select) property, a Tags (multi-select) property carrying
// tasks.label, and a unique-ID property so each page has a stable key such as TASK-12. An optional relation
// property named "Blocked by" (to the same database) expresses dependencies. When sources.notion.project is set, a
// "Project" property (select or text) holding that name keeps the factory to its own repository's tasks.
import { get } from '../config.mjs';
import { asList, matches, stateOf } from './common.mjs';

const VERSION = '2022-06-28';

export function notionSource(cfg, { env = process.env, fetchImpl = fetch } = {}) {
	const g = (k) => get(k, { config: cfg, env });
	const db = g('sources.notion.databaseId');
	const P = g('sources.notion.properties');
	const states = g('sources.notion.states');
	const label = g('tasks.label');
	const blockedLabel = g('tasks.blockedLabel');
	const headers = { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': VERSION, 'Content-Type': 'application/json' };
	const call = async (method, path, body) => {
		const r = await fetchImpl(`https://api.notion.com/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
		if (!r.ok) throw new Error(`notion ${method} ${path} ${r.status}`);
		return r.json();
	};

	let schema;
	const typeOf = async (name, fallback) => {
		schema ??= (await call('GET', `/databases/${db}`)).properties ?? {};
		return schema[name]?.type ?? fallback;
	};
	const project = g('sources.notion.project');

	const keyOf = (page) => {
		const u = page.properties?.[P.id]?.unique_id;
		return u ? `${u.prefix ?? 'TASK'}-${u.number}` : null;
	};
	const statusName = (page) => {
		const p = page.properties?.[P.status];
		return p?.status?.name ?? p?.select?.name;
	};
	const tags = (page) => (page.properties?.[P.labels]?.multi_select ?? []).map((t) => t.name);

	const pageState = new Map();
	const doneOf = async (pageId) => {
		if (!pageState.has(pageId)) pageState.set(pageId, stateOf(statusName(await call('GET', `/pages/${pageId}`)), states) === 'done');
		return pageState.get(pageId);
	};

	const normalise = async (page) => ({
		key: keyOf(page) ?? page.id,
		title: (page.properties?.[P.title]?.title ?? []).map((t) => t.plain_text).join(''),
		state: stateOf(statusName(page), states),
		updated: page.last_edited_time,
		labels: tags(page),
		type: page.properties?.[P.type]?.select?.name ?? 'task',
		pageId: page.id,
		blockedBy: await Promise.all((page.properties?.['Blocked by']?.relation ?? []).map(async (r) => ({ key: r.id, done: await doneOf(r.id) }))),
	});

	return {
		name: 'notion',
		async list(filter = {}) {
			const kind = await typeOf(P.status, 'status');
			const wanted = (filter.states ?? []).flatMap((s) => asList(states[s]));
			const clauses = [{ property: P.labels, multi_select: { contains: label } }];
			if (wanted.length) clauses.push({ or: wanted.map((n) => ({ property: P.status, [kind]: { equals: n } })) });
			// one database can serve several repositories: with a project set, only that repository's tasks are the factory's
			if (project && P.project) clauses.push({ property: P.project, [await typeOf(P.project, 'select')]: { equals: project } });
			if (filter.states?.includes('ready')) clauses.push({ property: P.labels, multi_select: { does_not_contain: blockedLabel } });
			const res = await call('POST', `/databases/${db}/query`, { filter: { and: clauses }, page_size: 50 });
			const tasks = await Promise.all((res.results ?? []).map(normalise));
			return tasks.filter((t) => matches(t, filter));
		},
	};
}
