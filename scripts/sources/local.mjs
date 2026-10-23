// Local task source: one markdown file per task under sources.local.dir (default .factory/tasks), with a small
// frontmatter block. No account, no network, and the plan lives in the repository next to the code.
//
//   ---
//   key: TASK-3
//   title: Add CSV export
//   state: ready
//   type: story
//   labels: [dev-factory]
//   blockedBy: [TASK-2]
//   updated: 2026-01-01T10:00:00.000Z
//   ---
//   <description>
//
//   ## Activity
//   - 2026-01-01T10:00:00.000Z [dev-factory] phase: claim started
import fs from 'node:fs';
import path from 'node:path';
import { get } from '../config.mjs';
import { KEY_RE, asList, matches, normaliseRef, parseBlockedBy, stateOf } from './common.mjs';

const ACTIVITY = '## Activity';

export function parseFile(text) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!m) throw new Error('task file has no frontmatter');
	const meta = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
		if (!kv) continue;
		const v = kv[2].trim();
		meta[kv[1]] = v.startsWith('[')
			? v
					.slice(1, v.lastIndexOf(']'))
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			: v;
	}
	const at = m[2].indexOf(`\n${ACTIVITY}`);
	const startsWithActivity = m[2].startsWith(ACTIVITY);
	const split = startsWithActivity ? 0 : at;
	const body = split === -1 ? m[2] : m[2].slice(0, split);
	const log = split === -1 ? '' : m[2].slice(split).replace(/^\s*## Activity\s*/, '');
	const comments = log
		.split(/\r?\n/)
		.filter((l) => l.startsWith('- '))
		.map((l) => l.slice(2));
	return { meta, body: body.trim(), comments };
}

export function serialize({ meta, body, comments = [] }) {
	const order = ['key', 'title', 'state', 'type', 'labels', 'blockedBy', 'parent', 'updated'];
	const keys = [...order.filter((k) => meta[k] !== undefined), ...Object.keys(meta).filter((k) => !order.includes(k))];
	const front = keys.map((k) => `${k}: ${Array.isArray(meta[k]) ? `[${meta[k].join(', ')}]` : meta[k]}`).join('\n');
	const log = comments.length ? `\n\n${ACTIVITY}\n${comments.map((c) => `- ${c}`).join('\n')}` : '';
	return `---\n${front}\n---\n${body.trim()}${log}\n`;
}

export function localSource(cfg, { root = process.cwd(), env = process.env, now = () => new Date() } = {}) {
	const g = (k) => get(k, { config: cfg, env });
	const dir = path.resolve(root, g('sources.local.dir'));
	const states = g('sources.local.states');
	const prefix = g('sources.local.keyPrefix') ?? 'TASK';
	const label = g('tasks.label');
	const blocked = g('tasks.blockedLabel');

	const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : []);
	const fileFor = (key) => {
		const f = files().find((n) => n.startsWith(`${key}-`) || n === `${key}.md`);
		return f ? path.join(dir, f) : null;
	};
	const read = (key) => {
		const f = fileFor(key);
		if (!f) throw new Error(`no task ${key} in ${dir}`);
		return { file: f, ...parseFile(fs.readFileSync(f, 'utf8')) };
	};
	const write = (file, data) => fs.writeFileSync(file, serialize(data));

	const all = () => files().map((f) => ({ file: path.join(dir, f), ...parseFile(fs.readFileSync(path.join(dir, f), 'utf8')) }));
	const stateName = (data) => stateOf(data.meta.state, states);

	const normalise = (data, index) => ({
		key: data.meta.key,
		title: data.meta.title,
		state: stateName(data),
		updated: data.meta.updated,
		labels: asList(data.meta.labels),
		type: data.meta.type ?? 'task',
		blockedBy: [...new Set([...asList(data.meta.blockedBy), ...parseBlockedBy(data.body)])]
			.map((r) => normaliseRef(r, prefix))
			.filter(Boolean)
			.map((k) => ({ key: k, done: index.get(k) === 'done' })),
	});

	return {
		name: 'local',
		async list(filter = {}) {
			const everything = all();
			const index = new Map(everything.map((d) => [d.meta.key, stateName(d)]));
			return everything
				.map((d) => normalise(d, index))
				.filter((t) => t.labels.includes(label))
				.filter((t) => !(filter.states?.includes('ready') && t.labels.includes(blocked)))
				.filter((t) => matches(t, filter, now().getTime()));
		},
		async get(key) {
			const d = read(key);
			const index = new Map(all().map((x) => [x.meta.key, stateName(x)]));
			return { ...normalise(d, index), body: d.body, comments: d.comments };
		},
		async create({ title, body, type = 'task', labels = [label], blockedBy = [], parent }) {
			fs.mkdirSync(dir, { recursive: true });
			const n = Math.max(0, ...all().map((d) => Number(/-(\d+)$/.exec(d.meta.key)?.[1] ?? 0))) + 1;
			const key = `${prefix}-${n}`;
			const slug = title
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '')
				.slice(0, 40);
			const meta = { key, title, state: asList(states.ready)[0], type, labels, blockedBy, updated: now().toISOString() };
			if (parent) meta.parent = parent;
			const file = path.join(dir, `${key}-${slug}.md`);
			write(file, { meta, body });
			return { key, file };
		},
		async setState(key, state) {
			const d = read(key);
			const native = state === 'ready' ? asList(states.ready).at(-1) : asList(states[state]).at(0);
			if (!native) throw new Error(`unknown state ${state}`);
			d.meta.state = native;
			d.meta.updated = now().toISOString();
			write(d.file, d);
		},
		async comment(key, text) {
			const d = read(key);
			d.comments.push(`${now().toISOString()} ${text.replace(/\r?\n/g, ' ')}`);
			d.meta.updated = now().toISOString();
			write(d.file, d);
		},
		async addLabel(key, name) {
			const d = read(key);
			d.meta.labels = [...new Set([...asList(d.meta.labels), name])];
			d.meta.updated = now().toISOString();
			write(d.file, d);
		},
		async removeLabel(key, name) {
			const d = read(key);
			d.meta.labels = asList(d.meta.labels).filter((l) => l !== name);
			d.meta.updated = now().toISOString();
			write(d.file, d);
		},
		async init() {
			fs.mkdirSync(dir, { recursive: true });
			return { dir };
		},
	};
}

export { KEY_RE };
