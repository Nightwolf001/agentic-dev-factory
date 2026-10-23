// Optional MCP servers. The plugin ships none: every server is listed in mcp/catalog.json with what it is for and what
// happens without it, and a repository turns on the ones it wants. They are written to the repository's own
// .mcp.json (project scope, merged, never overwriting a server that is already there), which Claude Code reads and
// which the scheduled pass is started with.
//
// A server you already have, at user scope or as a claude.ai connector, is used as it is: `enable` and `connect` do not
// write a second copy of it into .mcp.json (that makes Claude warn about duplicates and run two definitions), unless
// you pass --force. The scheduled pass is allowed to use those servers too.
//
//   mcp.mjs list                  every catalog server: enabled or not, what it is for, what you lose without it
//   mcp.mjs enable ID [ID...]     add the servers to .mcp.json (skips ones already configured elsewhere; --force adds anyway)
//   mcp.mjs disable ID [ID...]    remove them again
//   mcp.mjs recommend             the ids worth enabling for tasks.source and this repository
//   mcp.mjs connect [--all] [--force]   enable the recommended servers (or all), then show which still need a login
//   mcp.mjs doctor                one line per server: connected, pending approval, needs login, or not isolated
//   mcp.mjs allow                 the permission rules for the servers in use (used by the scheduler's settings)
//
// DF_MCP_LISTING names a file holding the output of `claude mcp list`, used instead of running it (tests, offline).
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
	if (!ids.length) return [];
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

// ---- what Claude already knows about: the text of `claude mcp list` ----

// "name: target - status" lines. A name may contain colons (plugin:dev-factory:notion), never a colon and a space.
export function parseListing(text) {
	return String(text ?? '')
		.split('\n')
		.map((line) => {
			const m = /^(.+?): (.*)$/.exec(line.trim());
			return m ? { name: m[1], rest: m[2] } : null;
		})
		.filter(Boolean);
}

// The entry that is this catalog server, however it was added: by its own name (user, project or local scope), as the
// plugin's own server, or as a claude.ai connector of that name. Other plugins' servers with a similar name are not it.
export function findServer(id, entries) {
	const lower = (e) => e.name.toLowerCase();
	return (
		entries.find((e) => e.name === id) ??
		entries.find((e) => e.name === `plugin:dev-factory:${id}`) ??
		entries.find((e) => lower(e).startsWith(`claude.ai ${id}`))
	);
}

export function stateOf(rest) {
	if (/pending approval/i.test(rest)) return 'pending approval';
	if (/needs auth/i.test(rest)) return 'needs login';
	if (/failed/i.test(rest)) return 'failed';
	if (/connected/i.test(rest)) return 'connected';
	return 'not started';
}

export function claudeListing(env = process.env) {
	if (env.DF_MCP_LISTING) {
		try {
			return fs.readFileSync(env.DF_MCP_LISTING, 'utf8');
		} catch {
			return '';
		}
	}
	try {
		return execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
	} catch {
		return '';
	}
}

// Catalog servers Claude has from somewhere other than this repository's .mcp.json.
export function externalServers(file, listing, cat = catalog()) {
	const mine = new Set(Object.keys(readProject(file).mcpServers ?? {}));
	const entries = parseListing(listing);
	return Object.keys(cat)
		.filter((id) => !mine.has(id))
		.flatMap((id) => {
			const e = findServer(id, entries);
			return e ? [{ id, name: e.name, state: stateOf(e.rest), rest: e.rest }] : [];
		});
}

// Which of `ids` to write, and which to leave because Claude already has them.
export function planEnable(ids, file, listing, { force = false } = {}, cat = catalog()) {
	if (force) return { write: ids, skipped: [] };
	const elsewhere = new Map(externalServers(file, listing, cat).map((s) => [s.id, s]));
	const write = [];
	const skipped = [];
	for (const id of ids) {
		if (elsewhere.has(id)) skipped.push({ id, name: elsewhere.get(id).name, state: elsewhere.get(id).state });
		else write.push(id);
	}
	return { write, skipped };
}

export function status(file, cat = catalog(), listing = '') {
	const on = new Set(Object.keys(readProject(file).mcpServers ?? {}));
	const elsewhere = new Map(externalServers(file, listing, cat).map((s) => [s.id, s]));
	return Object.entries(cat).map(([id, s]) => ({
		id,
		enabled: on.has(id),
		elsewhere: elsewhere.get(id)?.name ?? null,
		title: s.title,
		category: s.category,
		purpose: s.purpose,
		without: s.without,
	}));
}

// Where each enabled server stands, from the text of `claude mcp list`: connected, waiting for approval, needs a login
// (run /mcp), or not started yet (restart claude so it reads .mcp.json).
export function connectReport(file, listOutput = '', cat = catalog()) {
	const entries = parseListing(listOutput);
	return Object.keys(readProject(file).mcpServers ?? {}).map((id) => {
		const e = findServer(id, entries);
		return { id, state: e ? stateOf(e.rest) : 'not started', login: Boolean(cat[id]?.requires?.some((r) => /oauth/i.test(r))) };
	});
}

// One line per server in use, for the doctor: { level: 'ok' | 'warn', text }.
export function doctorLines(file, listing, cat = catalog()) {
	const entries = parseListing(listing);
	const lines = [];
	const mine = Object.keys(readProject(file).mcpServers ?? {});
	for (const r of connectReport(file, listing, cat)) {
		if (r.state === 'connected') lines.push({ level: 'ok', text: `MCP ${r.id} connected (.mcp.json)` });
		else if (r.state === 'pending approval')
			lines.push({ level: 'warn', text: `MCP ${r.id} is waiting for your approval: run claude in this repository and approve it` });
		else if (r.state === 'needs login') lines.push({ level: 'warn', text: `MCP ${r.id} needs a login: in claude run /mcp and authenticate it` });
		else
			lines.push({
				level: 'warn',
				text: `MCP ${r.id} is in .mcp.json but ${r.state} (restart claude, or remove it: dev-factory mcp disable ${r.id})`,
			});
	}
	for (const s of externalServers(file, listing, cat)) {
		lines.push({
			level: s.state === 'connected' ? 'ok' : 'warn',
			text: `MCP ${s.id} comes from "${s.name}" (${s.state}); the factory uses it as it is and adds nothing to .mcp.json`,
		});
	}
	// The browser the QA walks use should not share a profile with the person's own: --isolated
	const pw = findServer('playwright', entries);
	if (pw && !/--isolated/.test(pw.rest)) {
		lines.push({
			level: 'warn',
			text: `playwright ("${pw.name}") runs without --isolated, so QA walks share one browser profile and can collide. Fix: claude mcp remove playwright -s user && claude mcp add playwright -s user -- npx -y @playwright/mcp@0.0.82 --isolated --ignore-https-errors`,
		});
	}
	if (!mine.length && !externalServers(file, listing, cat).length)
		lines.push({ level: 'ok', text: 'no MCP servers in use (all are optional: dev-factory mcp list)' });
	return lines;
}

// Permission rules: both spellings of every server in use, since the plugin names its own servers plugin_dev-factory_<id>.
// `external` are the ids Claude has from elsewhere (user scope, a claude.ai connector).
export function allowRules(file, external = []) {
	return [...new Set([...Object.keys(readProject(file).mcpServers ?? {}), ...external])].flatMap((id) => [
		`mcp__${id}`,
		`mcp__plugin_dev-factory_${id}`,
	]);
}

if (isMain(import.meta.url)) {
	const [cmd, ...rest] = process.argv.slice(2);
	const force = rest.includes('--force');
	const ids = rest.filter((a) => !a.startsWith('--'));
	const file = path.resolve(process.env.DF_MCP_FILE || '.mcp.json');
	try {
		if (cmd === 'list') {
			for (const s of status(file, catalog(), claudeListing()))
				console.log(
					`${s.enabled ? 'on ' : s.elsewhere ? 'ext' : 'off'}  ${s.id.padEnd(20)} ${s.purpose}${s.elsewhere ? `\n     already available as "${s.elsewhere}"` : ''}\n     without it: ${s.without}`,
				);
		} else if (cmd === 'enable' || cmd === 'connect') {
			const chosen = cmd === 'connect' ? (rest.includes('--all') ? Object.keys(catalog()) : recommend(load())) : ids;
			const listing = claudeListing();
			const plan = planEnable(chosen, file, listing, { force });
			const added = enable(plan.write, file);
			if (cmd === 'enable') console.log(JSON.stringify({ added, skipped: plan.skipped }));
			else {
				if (added.length) console.log(`enabled: ${added.join(', ')}`);
				for (const s of plan.skipped)
					console.log(`skip  ${s.id.padEnd(20)} already available as "${s.name}" (${s.state}); --force adds it to .mcp.json anyway`);
				const hint = {
					'needs login': 'in claude run /mcp and log in',
					failed: 'see: claude mcp list',
					'pending approval': 'run claude in this repository and approve it',
					'not started': 'restart claude so it reads .mcp.json',
				};
				for (const r of connectReport(file, listing)) {
					const next = r.state === 'connected' ? '' : `  -> ${hint[r.state]}`;
					console.log(`${r.state === 'connected' ? 'ok  ' : 'todo'}  ${r.id.padEnd(20)} ${r.state}${next}`);
				}
			}
		} else if (cmd === 'disable') console.log(JSON.stringify({ removed: disable(ids, file) }));
		else if (cmd === 'recommend') console.log(recommend(load()).join(' '));
		else if (cmd === 'doctor')
			for (const l of doctorLines(file, claudeListing())) console.log(`${l.level === 'ok' ? 'ok   ' : 'warn '} ${l.text}`);
		else if (cmd === 'allow')
			console.log(
				JSON.stringify(
					allowRules(
						file,
						externalServers(file, claudeListing()).map((s) => s.id),
					),
				),
			);
		else {
			console.error('usage: mcp.mjs list | enable ID... [--force] | disable ID... | recommend | connect [--all] [--force] | doctor | allow');
			process.exit(3);
		}
	} catch (e) {
		console.error(`mcp: ${e.message}`);
		process.exit(1);
	}
}
