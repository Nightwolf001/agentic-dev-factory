// Optional MCP servers. The plugin ships none: every server is listed in mcp/catalog.json with what it is for and what
// happens without it, and a person turns on the ones they want: for every project (their user settings file) or for this
// project (its .devfactory/config.json), as `mcp.servers.<id>: true`. `sync` applies that to Claude Code (`claude mcp
// add-json -s user|local`) and records in <state>/managed.json what it added, so only that is ever removed. A scheduled
// pass is started from a generated .devfactory/mcp.json instead (`write-config`). The planning is in scripts/mcp-scope.mjs.
//
// A server you already have, at user scope or as a claude.ai connector, is used as it is: `sync` does not add a second copy
// of it (that makes Claude warn about duplicates and run two definitions) and never removes it.
//
//   mcp.mjs list                  every catalog server: where it is on (user, proj, repo = legacy .mcp.json, ext = from elsewhere, off)
//   mcp.mjs enable ID... [--user|--project]   turn servers on (default: each one's defaultScope), then sync
//   mcp.mjs disable ID... [--user|--project]  turn them off in that layer (both without a flag), then sync; a required server cannot be
//   mcp.mjs sync [--dry-run]      make Claude's user and local scopes match the settings
//   mcp.mjs write-config          write .devfactory/mcp.json and print the Claude arguments for a pass, one per line
//   mcp.mjs secrets               the variables the servers read, set or empty (never a value)
//   mcp.mjs migrate [--apply]     move the factory's own entries out of a legacy .mcp.json into the settings
//   mcp.mjs recommend             the ids worth enabling for tasks.source and this repository
//   mcp.mjs connect [--all]       enable the recommended servers (or all), then show which still need a login
//   mcp.mjs doctor [--lenient]    one line per server: connected, pending approval, needs login, or not isolated; a server the catalog
//                                 flags `required` is a FAIL while missing or down (a warning with --lenient)
//   mcp.mjs allow                 the permission rules for the servers in use (used by the scheduler's settings)
//
// DF_MCP_LISTING names a file holding the output of `claude mcp list`, used instead of running it (tests, offline).
// DF_CLAUDE_BIN names the claude program to run (tests put a fake there). DF_MCP_FILE names the legacy .mcp.json.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { get, layers, load, requiredServers, setIn } from './config.mjs';
import { isMain } from './is-main.mjs';
import {
	applySync,
	catalog,
	claudeBin,
	desired,
	findServer,
	mainCheckout,
	parseListing,
	planLegacyMigration,
	planSync,
	readManaged,
	readProject,
	secretsReport,
	serverConfig,
	stateOf,
	userEnabled,
	writePassConfig,
} from './mcp-scope.mjs';
import { loadTrackerEnv } from './state-env.mjs';

// What callers have always imported from here, and the planning they now also get from here.
export * from './mcp-scope.mjs';

// The legacy writer for an unmigrated repository's .mcp.json. The command line no longer calls it.
export function enable(ids, file, cat = catalog(), env = process.env) {
	if (!ids.length) return [];
	const doc = readProject(file);
	doc.mcpServers ??= {};
	const added = [];
	for (const id of ids) {
		if (!cat[id]) throw new Error(`unknown MCP server '${id}' (see: mcp.mjs list)`);
		if (doc.mcpServers[id]) continue;
		doc.mcpServers[id] = serverConfig(id, cat, env);
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

// What this setup would use: the tracker's server for the chosen source, the ones flagged recommended, and the ones flagged
// required. A required server is part of what the factory needs on this machine, so setup always enables it and the doctor fails
// while it is missing or down. The catalog flags playwright (every UI change needs a browser walk); maestro is required by requiredServers(config) once mobile.appDir is set.
//
// Two servers serve Jira with the same tool names (`jira` on an API token, `atlassian` on OAuth), so exactly one is recommended: the one
// already in use (turned on in the settings, in the repository's .mcp.json, or found in `listing`, the text of `claude mcp list`, which
// includes a claude.ai connector), else `jira` when JIRA_EMAIL and JIRA_API_TOKEN are available (the environment, or the state
// folder's .env.local read as text), else `atlassian`, whose login at least works by hand. `file`, `env`, `dir` and `listing` are for tests.
export function recommend(cfg, cat = catalog(), { file, env = process.env, dir, listing = '' } = {}) {
	const source = get('tasks.source', { config: cfg });
	const tracker = source === 'jira' ? 'jira' : source === 'notion' ? 'notion' : null;
	const ids = Object.entries(cat)
		.filter(([, s]) => s.required === true || s.recommended || s.tracker === tracker)
		.map(([id]) => id);
	const jira = ids.filter((id) => tracker === 'jira' && cat[id].tracker === 'jira');
	if (jira.length < 2) return ids;
	const entries = parseListing(listing);
	const have = new Set([
		...(file ? Object.keys(readProject(file).mcpServers ?? {}) : []),
		...Object.entries(cfg?.mcp?.servers ?? {})
			.filter(([, on]) => on === true)
			.map(([id]) => id),
		...jira.filter((id) => findServer(id, entries)),
	]);
	let pick = jira.find((id) => have.has(id));
	if (!pick) {
		const scratch = { ...env };
		loadTrackerEnv({ env: scratch, ...(dir ? { dir } : {}) });
		pick = scratch.JIRA_EMAIL && scratch.JIRA_API_TOKEN && jira.includes('jira') ? 'jira' : jira.includes('atlassian') ? 'atlassian' : jira[0];
	}
	return ids.filter((id) => !jira.includes(id) || id === pick);
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
		return execFileSync(claudeBin(env), ['mcp', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
	} catch {
		return '';
	}
}

// Catalog servers Claude has from somewhere other than this repository's .mcp.json (or the `also` ids, such as the ones the settings turn on).
export function externalServers(file, listing, cat = catalog(), also = []) {
	const mine = new Set([...Object.keys(readProject(file).mcpServers ?? {}), ...also]);
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

// `want` is desired(): with it, each row also says where the server is on (user, project, repo = the legacy .mcp.json, ext, off).
export function status(file, cat = catalog(), listing = '', want = []) {
	const legacy = new Set(Object.keys(readProject(file).mcpServers ?? {}));
	const at = new Map(want.map((w) => [w.id, w.scope]));
	const elsewhere = new Map(externalServers(file, listing, cat, [...at.keys()]).map((s) => [s.id, s]));
	return Object.entries(cat).map(([id, s]) => ({
		id,
		enabled: legacy.has(id) || at.has(id),
		scope: at.get(id) ?? (legacy.has(id) ? 'repo' : elsewhere.has(id) ? 'ext' : 'off'),
		elsewhere: elsewhere.get(id)?.name ?? null,
		title: s.title,
		category: s.category,
		purpose: s.purpose,
		without: s.without,
	}));
}

// Where each of `ids` stands, from the text of `claude mcp list`: connected, waiting for approval, needs a login (run /mcp), or not
// started yet (not applied, or restart claude so it reads its servers).
export function reportFor(ids, listOutput = '', cat = catalog()) {
	const entries = parseListing(listOutput);
	return ids.map((id) => {
		const e = findServer(id, entries);
		return { id, state: e ? stateOf(e.rest) : 'not started', login: Boolean(cat[id]?.requires?.some((r) => /oauth/i.test(r))) };
	});
}

export const connectReport = (file, listOutput = '', cat = catalog()) => reportFor(Object.keys(readProject(file).mcpServers ?? {}), listOutput, cat);

// One line per server in use, for the doctor: { level: 'ok' | 'warn', text }. `want` is desired(): those servers are in use as well as
// the ones in the legacy .mcp.json.
export function doctorLines(file, listing, cat = catalog(), { lenient = false, want = [] } = {}) {
	const entries = parseListing(listing);
	const lines = [];
	const legacy = Object.keys(readProject(file).mcpServers ?? {});
	const at = new Map(want.map((w) => [w.id, w.scope]));
	const mine = [...new Set([...legacy, ...at.keys()])];
	const report = reportFor(mine, listing, cat);
	const where = (id) => (legacy.includes(id) ? '.mcp.json' : at.get(id) === 'user' ? 'all projects' : 'this project');
	// a required server fails the doctor while it is missing or not connected (a warning under --lenient or --ci)
	const level = lenient ? 'warn' : 'fail';
	const external = externalServers(file, listing, cat, [...at.keys()]);
	for (const [id, s] of Object.entries(cat)) {
		if (s.required !== true) continue;
		const own = report.find((r) => r.id === id);
		const ext = external.find((e) => e.id === id);
		const state = own?.state ?? ext?.state ?? null;
		if (state === 'connected') lines.push({ level: 'ok', text: `required MCP ${id} connected` });
		else if (state === null) lines.push({ level, text: `required MCP ${id} is not enabled: dev-factory mcp enable ${id}` });
		else
			lines.push({
				level,
				text: `required MCP ${id} is ${state}: it must be connected before the factory can work (dev-factory mcp connect, then /mcp if it asks for a login)`,
			});
	}
	for (const r of report) {
		if (cat[r.id]?.required === true) continue; // reported above
		if (r.state === 'connected') lines.push({ level: 'ok', text: `MCP ${r.id} connected (${where(r.id)})` });
		else if (r.state === 'pending approval')
			lines.push({ level: 'warn', text: `MCP ${r.id} is waiting for your approval: run claude in this repository and approve it` });
		else if (r.state === 'needs login') lines.push({ level: 'warn', text: `MCP ${r.id} needs a login: in claude run /mcp and authenticate it` });
		else if (legacy.includes(r.id))
			lines.push({
				level: 'warn',
				text: `MCP ${r.id} is in .mcp.json but ${r.state} (restart claude, or remove it: dev-factory mcp disable ${r.id})`,
			});
		else
			lines.push({
				level: 'warn',
				text: `MCP ${r.id} is on (${where(r.id)}) but ${r.state} (run dev-factory mcp sync, then restart claude)`,
			});
	}
	for (const s of external) {
		if (cat[s.id]?.required === true) continue;
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
	if (!mine.length && !external.length) lines.push({ level: 'ok', text: 'no MCP servers in use (all are optional: dev-factory mcp list)' });
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

// ---- the command line ----

const WHERE = { user: 'all projects', project: 'this project' };

function layerHas(layer, id) {
	return layers().find((l) => l.name === layer)?.data.mcp?.servers?.[id] !== undefined;
}

// Writes `mcp.servers.<id> = true` in the layer of `scope` and deletes the key from the other layer.
function turnOn(id, scope, cat) {
	if (!cat[id]) throw new Error(`unknown MCP server '${id}' (see: mcp.mjs list)`);
	setIn(scope, `mcp.servers.${id}`, true);
	const other = scope === 'user' ? 'project' : 'user';
	if (layerHas(other, id)) setIn(other, `mcp.servers.${id}`, undefined);
	console.log(`on    ${id.padEnd(20)} (${WHERE[scope]})`);
}

// Makes Claude's user and local scopes match the settings and prints what it did.
function runSync({ dry = false } = {}) {
	const repo = mainCheckout();
	const cat = catalog();
	const ls = layers({ from: repo ?? process.cwd() });
	const want = desired(ls, cat);
	if (!repo && want.some((w) => w.scope === 'project')) throw new Error('the project scope needs a git repository: run this inside one');
	const listing = claudeListing();
	const plan = planSync({ want, managed: readManaged(), listing, repo, userIds: userEnabled(ls) });
	for (const s of plan.remove) console.log(`remove  ${s.id.padEnd(20)} (${WHERE[s.scope]})`);
	for (const s of plan.add) console.log(`add     ${s.id.padEnd(20)} (${WHERE[s.scope]})`);
	for (const s of plan.skip) console.log(`skip    ${s.id.padEnd(20)} ${s.reason}`);
	if (dry) return;
	const { failed } = applySync(plan, { repo, env: process.env, cat });
	for (const f of failed) console.error(`FAILED ${f.action} ${f.id} (${WHERE[f.scope]}): ${f.error}`);
	if (failed.length) process.exitCode = 1;
}

function runMigrate(file, cat, apply) {
	const plan = planLegacyMigration(file, cat);
	if (!plan.length) return console.log('nothing to migrate: no servers in the legacy .mcp.json');
	for (const p of plan) console.log(p.action === 'adopt' ? `adopt  ${p.id}` : `keep   ${p.id}  (not the catalog's entry: left in the file)`);
	if (!apply) return console.log('run again with --apply to move the adopted entries into the settings');
	const doc = readProject(file);
	for (const p of plan.filter((x) => x.action === 'adopt')) {
		setIn('project', `mcp.servers.${p.id}`, true);
		delete doc.mcpServers[p.id];
	}
	if (Object.keys(doc.mcpServers).length === 0 && Object.keys(doc).every((k) => k === 'mcpServers')) fs.rmSync(file);
	else fs.writeFileSync(file, `${JSON.stringify(doc, null, '\t')}\n`);
	if (plan.some((p) => p.action === 'adopt')) console.log('done: dev-factory mcp sync turns them on in Claude');
}

if (isMain(import.meta.url)) {
	const [cmd, ...rest] = process.argv.slice(2);
	const ids = rest.filter((a) => !a.startsWith('--'));
	const flagScope = rest.includes('--user') ? 'user' : rest.includes('--project') ? 'project' : null;
	const file = path.resolve(process.env.DF_MCP_FILE || '.mcp.json');
	try {
		const cat = catalog();
		if (cmd === 'list') {
			for (const s of status(file, cat, claudeListing(), desired(layers(), cat)))
				console.log(
					`${(s.scope === 'project' ? 'proj' : s.scope).padEnd(5)} ${s.id.padEnd(20)} ${s.purpose}${s.elsewhere ? `\n      already available as "${s.elsewhere}"` : ''}\n      without it: ${s.without}`,
				);
		} else if (cmd === 'enable') {
			for (const id of ids) if (!cat[id]) throw new Error(`unknown MCP server '${id}' (see: mcp.mjs list)`);
			for (const id of ids) turnOn(id, flagScope ?? cat[id].defaultScope ?? 'user', cat);
			runSync();
		} else if (cmd === 'disable') {
			const required = requiredServers(load(), cat);
			for (const id of ids) {
				if (!cat[id]) throw new Error(`unknown MCP server '${id}' (see: mcp.mjs list)`);
				if (required.includes(id)) throw new Error(`${id} is required; change its scope with enable --user or --project`);
			}
			for (const id of ids) {
				for (const layer of flagScope ? [flagScope] : ['user', 'project'])
					if (layerHas(layer, id)) setIn(layer, `mcp.servers.${id}`, undefined);
				if (readProject(file).mcpServers?.[id]) console.log(`note: ${id} is still in the legacy .mcp.json: dev-factory mcp migrate`);
			}
			runSync();
		} else if (cmd === 'sync') runSync({ dry: rest.includes('--dry-run') });
		else if (cmd === 'write-config') {
			const root = mainCheckout();
			if (!root) throw new Error('not inside a git repository');
			const out = writePassConfig({
				want: desired(layers({ from: root }), cat),
				cat,
				env: process.env,
				listing: claudeListing(),
				legacyFile: file,
				repo: root,
			});
			if (out.strict) console.log('--strict-mcp-config');
			else console.error(`note: ${out.reason}`);
			console.log('--mcp-config');
			console.log(out.file);
		} else if (cmd === 'secrets') {
			for (const r of secretsReport({ want: desired(layers(), cat), cat, env: process.env }))
				console.log(`${r.name.padEnd(28)} ${r.state.padEnd(6)} ${r.neededBy.join(', ')}${r.optional ? ' (optional)' : ''}`);
		} else if (cmd === 'migrate') runMigrate(file, cat, rest.includes('--apply'));
		else if (cmd === 'connect') {
			const chosen = rest.includes('--all') ? Object.keys(cat) : recommend(load(), cat, { file, listing: claudeListing() });
			for (const id of chosen)
				if (!layerHas('user', id) && !layerHas('project', id)) turnOn(id, cat[id].defaultScope === 'project' ? 'project' : 'user', cat);
			runSync();
			const hint = {
				'needs login': 'in claude run /mcp and log in',
				failed: 'see: claude mcp list',
				'pending approval': 'run claude in this repository and approve it',
				'not started': 'restart claude so it reads its servers',
			};
			const listing = claudeListing();
			const inUse = [...new Set([...desired(layers(), cat).map((w) => w.id), ...Object.keys(readProject(file).mcpServers ?? {})])];
			for (const r of reportFor(inUse, listing, cat)) {
				const next = r.state === 'connected' ? '' : `  -> ${hint[r.state]}`;
				console.log(`${r.state === 'connected' ? 'ok  ' : 'todo'}  ${r.id.padEnd(20)} ${r.state}${next}`);
			}
		} else if (cmd === 'recommend') console.log(recommend(load(), cat, { file, listing: claudeListing() }).join(' '));
		else if (cmd === 'doctor')
			for (const l of doctorLines(file, claudeListing(), cat, { lenient: process.argv.includes('--lenient'), want: desired(layers(), cat) }))
				console.log(`${{ ok: 'ok   ', warn: 'warn ', fail: 'FAIL ' }[l.level]} ${l.text}`);
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
			console.error(
				'usage: mcp.mjs list | enable ID... [--user|--project] | disable ID... [--user|--project] | sync [--dry-run] | write-config | secrets | migrate [--apply] | recommend | connect [--all] | doctor | allow',
			);
			process.exit(3);
		}
	} catch (e) {
		console.error(`mcp: ${e.message}`);
		process.exit(1);
	}
}
