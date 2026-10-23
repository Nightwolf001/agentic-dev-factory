// Optional MCP servers. The plugin ships none: every server is listed in mcp/catalog.json with what it is for and what
// happens without it, and a repository turns on the ones it wants. They are written to the repository's own
// .mcp.json (project scope, merged, never overwriting a server that is already there), which Claude Code reads and
// which the scheduled pass is started with.
//
//   mcp.mjs list                  every catalog server: enabled or not, what it is for, what you lose without it
//   mcp.mjs enable ID [ID...]     add the servers to .mcp.json
//   mcp.mjs disable ID [ID...]    remove them again
//   mcp.mjs recommend             the ids worth enabling for tasks.source and this repository
//   mcp.mjs connect [--all]       enable the recommended servers (or all), then show which still need a login
//   mcp.mjs allow                 the permission rules for the enabled servers (used by the scheduler's settings)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';

const CATALOG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'catalog.json');

export const catalog = () => JSON.parse(fs.readFileSync(CATALOG, 'utf8')).servers;

export function readProject(file) {
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { mcpServers: {} };
}

export function enable(ids, file, cat = catalog()) {
	const doc = readProject(file);
	doc.mcpServers ??= {};
	const added = [];
	for (const id of ids) {
		if (!cat[id]) throw new Error(`unknown MCP server '${id}' (see: mcp.mjs list)`);
		if (doc.mcpServers[id]) continue;
		doc.mcpServers[id] = cat[id].config;
		added.push(id);
	}
	fs.writeFileSync(file, JSON.stringify(doc, null, '\t') + '\n');
	return added;
}

export function disable(ids, file) {
	const doc = readProject(file);
	const removed = ids.filter((id) => doc.mcpServers?.[id]);
	for (const id of removed) delete doc.mcpServers[id];
	fs.writeFileSync(file, JSON.stringify(doc, null, '\t') + '\n');
	return removed;
}

// What this setup would use: the tracker's server for the chosen source, plus the ones flagged recommended.
export function recommend(cfg, cat = catalog()) {
	const source = get('tasks.source', { config: cfg });
	const ids = Object.entries(cat)
		.filter(([, s]) => s.recommended || s.tracker === (source === 'jira' ? 'jira' : source === 'notion' ? 'notion' : null))
		.map(([id]) => id);
	return ids;
}

export function status(file, cat = catalog()) {
	const on = new Set(Object.keys(readProject(file).mcpServers ?? {}));
	return Object.entries(cat).map(([id, s]) => ({
		id,
		enabled: on.has(id),
		title: s.title,
		category: s.category,
		purpose: s.purpose,
		without: s.without,
	}));
}

// Where each enabled server stands, from the text of `claude mcp list`: connected, needs a login (run /mcp), or not
// started yet (restart claude so it reads .mcp.json).
export function connectReport(file, listOutput = '', cat = catalog()) {
	const lines = String(listOutput).split('\n');
	return Object.keys(readProject(file).mcpServers ?? {}).map((id) => {
		const line = lines.find((l) => l.startsWith(`${id}:`) || l.startsWith(`plugin:dev-factory:${id}:`)) ?? '';
		const state =
			/connected/i.test(line) && !/needs auth|failed/i.test(line)
				? 'connected'
				: /needs auth/i.test(line)
					? 'needs login'
					: /failed/i.test(line)
						? 'failed'
						: 'not started';
		return { id, state, login: Boolean(cat[id]?.requires?.some((r) => /oauth/i.test(r))) };
	});
}

// Permission rules: both spellings of every enabled server, since the plugin names its own servers plugin_dev-factory_<id>.
export function allowRules(file) {
	return Object.keys(readProject(file).mcpServers ?? {}).flatMap((id) => [`mcp__${id}`, `mcp__plugin_dev-factory_${id}`]);
}

if (isMain(import.meta.url)) {
	const [cmd, ...ids] = process.argv.slice(2);
	const file = path.resolve(process.env.DF_MCP_FILE || '.mcp.json');
	try {
		if (cmd === 'list')
			for (const s of status(file)) console.log(`${s.enabled ? 'on ' : 'off'}  ${s.id.padEnd(20)} ${s.purpose}\n     without it: ${s.without}`);
		else if (cmd === 'enable') console.log(JSON.stringify({ added: enable(ids, file) }));
		else if (cmd === 'disable') console.log(JSON.stringify({ removed: disable(ids, file) }));
		else if (cmd === 'connect') {
			const all = ids.includes('--all');
			const chosen = all ? Object.keys(catalog()) : recommend(load());
			const added = enable(chosen, file);
			let listing = '';
			try {
				listing = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
			} catch {
				/* claude not on PATH, or no answer: report what is enabled */
			}
			if (added.length) console.log(`enabled: ${added.join(', ')}`);
			for (const r of connectReport(file, listing)) {
				const hint = {
					'needs login': 'in claude run /mcp and log in',
					failed: 'see: claude mcp list',
					'not started': 'restart claude so it reads .mcp.json',
				};
				const next = r.state === 'connected' ? '' : `  -> ${hint[r.state]}`;
				console.log(`${r.state === 'connected' ? 'ok  ' : 'todo'}  ${r.id.padEnd(20)} ${r.state}${next}`);
			}
		} else if (cmd === 'recommend') console.log(recommend(load()).join(' '));
		else if (cmd === 'allow') console.log(JSON.stringify(allowRules(file)));
		else {
			console.error('usage: mcp.mjs list | enable ID... | disable ID... | recommend | connect [--all] | allow');
			process.exit(3);
		}
	} catch (e) {
		console.error(`mcp: ${e.message}`);
		process.exit(1);
	}
}
