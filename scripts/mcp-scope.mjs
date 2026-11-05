// Which MCP servers are on, at which scope, and what the factory has added to Claude Code. The pure planning behind
// scripts/mcp.mjs (that file is the command line), plus the small reads it shares: the catalog, the text of `claude mcp list`
// and the legacy .mcp.json.
//
//   desired(layers)         the servers the settings layers turn on: { id, scope: 'user' | 'project', required }
//   planSync(...)           what to add to and remove from Claude's user and local scopes to match it
//   applySync(plan, ...)    runs `claude mcp add-json` / `claude mcp remove`, and records in <state>/managed.json what it did
//   writePassConfig(...)    the generated .devfactory/mcp.json a scheduled pass is started with
//   secretsReport(...)      which variables the wanted servers read, set or empty (never a value)
//   planLegacyMigration     which entries of an old .mcp.json are the catalog's own
//
// Ownership: managed.json records the servers the factory added, per scope (and per repository for the local scope). Only
// those are ever removed. A server Claude has from elsewhere (a hand-made user entry, a claude.ai connector) is used as it is.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { layers, merge, requiredServers } from './config.mjs';
import { entry as legacyJiraEntry } from './jira-mcp-config.mjs';
import { ensureProjectDir, PROJECT_FILES, projectRoot } from './project-dir.mjs';
import { parseEnvText, stateDir } from './state-env.mjs';

const CATALOG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'catalog.json');

export const catalog = () => JSON.parse(fs.readFileSync(CATALOG, 'utf8')).servers;

export function readProject(file) {
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { mcpServers: {} };
}

// Every `claude` this plugin runs goes through here, so a test can put a fake in its place.
export const claudeBin = (env = process.env) => env.DF_CLAUDE_BIN || 'claude';

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
	// the line is "<command and arguments> - <status>": the status is what follows the last " - ", never a word in the command
	const text = String(rest ?? '');
	const status = text.includes(' - ') ? text.slice(text.lastIndexOf(' - ') + 3) : text;
	if (/pending approval/i.test(status)) return 'pending approval';
	if (/needs auth/i.test(status)) return 'needs login';
	if (/failed/i.test(status)) return 'failed';
	if (/connected/i.test(status)) return 'connected';
	return 'not started';
}

// ---- what the settings say ----

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const toggles = (layer) => (isObject(layer?.data?.mcp?.servers) ? layer.data.mcp.servers : {});

// The servers to have on. A user-layer `true` is every project, else a project-layer `true` is this one. A project-layer `false`
// takes a user-level server out of this result, which the generated pass config honours; Claude's own scopes cannot (a user-scope
// server is there for every project), which is why planSync is also told which ids the user layer has on. A required server (requiredServers(config): playwright, and maestro once a mobile app is set) is
// always present, at the layer that names it, else at its defaultScope.
export function desired(ls = layers(), cat = catalog()) {
	const user = toggles(ls.find((l) => l.name === 'user'));
	const project = toggles(ls.find((l) => l.name === 'project'));
	const required = requiredServers(
		ls.reduce((acc, l) => merge(acc, l.data), {}),
		cat,
	);
	const out = [];
	for (const [id, s] of Object.entries(cat)) {
		const must = required.includes(id);
		let scope = user[id] === true ? 'user' : project[id] === true ? 'project' : null;
		if (project[id] === false && !must) continue;
		if (!scope && must) scope = s.defaultScope === 'project' ? 'project' : 'user';
		if (scope) out.push({ id, scope, required: must });
	}
	return out;
}

// The ids the user layer turns on: what stays in Claude's user scope whatever one project says.
export function userEnabled(ls = layers()) {
	const user = toggles(ls.find((l) => l.name === 'user'));
	return Object.keys(user).filter((id) => user[id] === true);
}

// ---- what the factory added to Claude, kept in <state>/managed.json ----

export const managedFile = (env = process.env) => path.join(stateDir(env), 'managed.json');

const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// A missing file claims nothing. One that is not JSON claims nothing either, but it is kept as managed.json.bad and said so,
// because the next write would replace the record of what the factory added.
export function readManaged(env = process.env) {
	const file = managedFile(env);
	let raw = {};
	let text = null;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		// no file yet
	}
	if (text !== null) {
		try {
			raw = JSON.parse(text);
		} catch {
			try {
				fs.copyFileSync(file, `${file}.bad`);
			} catch {
				// the warning below still says it
			}
			process.stderr.write(
				`warning: ${file} is not valid JSON, so no server in it is treated as added by dev-factory; a copy is kept as ${file}.bad\n`,
			);
		}
	}
	const out = {};
	for (const kind of ['mcp', 'plugins']) {
		const part = isObject(raw?.[kind]) ? raw[kind] : {};
		const local = isObject(part.local) ? part.local : {};
		out[kind] = { user: names(part.user), local: Object.fromEntries(Object.entries(local).map(([repo, ids]) => [repo, names(ids)])) };
	}
	// plugins the factory disabled at a repository's local scope: { [repoRealPath]: [ids] }. Present only when something is recorded.
	const disabled = isObject(raw?.plugins?.disabled) ? raw.plugins.disabled : {};
	const kept = Object.entries(disabled)
		.map(([repo, ids]) => [repo, names(ids)])
		.filter(([, ids]) => ids.length);
	if (kept.length) out.plugins.disabled = Object.fromEntries(kept);
	return out;
}

// Written beside the file and renamed over it, so a reader never sees half of it.
export function writeManaged(env, data) {
	const file = managedFile(env);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, '\t')}\n`);
	fs.renameSync(tmp, file);
}

// The checkout the git folder belongs to: from a linked worktree, the main checkout. Claude's local scope is keyed by a path, and
// every session starts in the main checkout, so that is the path to use. Falls back to the folder that holds .git.
export function mainCheckout(from = process.cwd()) {
	const root = projectRoot(from);
	if (!root) return null;
	try {
		// no --path-format=absolute (git 2.31): the answer is relative to the folder asked from
		const common = path.resolve(
			root,
			execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
		);
		if (path.basename(common) === '.git') return path.dirname(common);
	} catch {
		// not a git folder git can read: the folder with .git is the best answer
	}
	return root;
}

// The local scope is keyed by the repository's real path.
export function repoKey(repo) {
	if (!repo) return null;
	try {
		return fs.realpathSync(repo);
	} catch {
		return path.resolve(repo);
	}
}

// What to do to Claude's user and local scopes so they match `want`. `scope: 'project'` here is Claude's `local`.
//   add     wanted, and not recorded as ours at that scope (a scope change is one remove plus one add)
//   remove  recorded as ours at a scope where it is no longer wanted. A user-scope server is there for every project, so it is
//           removed only when `userIds` (userEnabled(layers)) is given and no longer holds it: a project's `false` never removes it,
//           and without `userIds` no user-scope server is removed at all
//   skip    wanted, not ours, and Claude has it from somewhere else: it is used as it is
export function planSync({ want, managed = readManaged(), listing = '', repo, userIds }) {
	const key = repoKey(repo);
	const ours = { user: new Set(managed.mcp.user), project: new Set(key ? managed.mcp.local[key] ?? [] : []) };
	const wanted = { user: new Set(), project: new Set() };
	for (const w of want) wanted[w.scope].add(w.id);
	const userOn = userIds ? new Set(userIds) : null;
	const entries = parseListing(listing);
	const plan = { add: [], remove: [], skip: [] };
	for (const { id, scope } of want) {
		if (ours[scope].has(id)) continue;
		const found = ours.user.has(id) || ours.project.has(id) ? null : findServer(id, entries);
		if (found) plan.skip.push({ id, name: found.name, reason: `already available as "${found.name}"` });
		else plan.add.push({ id, scope });
	}
	for (const scope of ['user', 'project'])
		for (const id of ours[scope]) {
			if (wanted[scope].has(id)) continue;
			if (scope === 'user' && (!userOn || userOn.has(id))) continue;
			plan.remove.push({ id, scope });
		}
	return plan;
}

// The launcher `dev-factory install` writes: it always runs the newest installed copy, so a user-scope entry survives updates.
export const launcherPath = (env = process.env) => path.join(stateDir(env), 'bin', 'dev-factory');

const LAUNCHER_REF = /^\$\{DF_LAUNCHER:-[^}]*\}$/;

// The catalog's config as Claude should hold it: variable references intact, except that a launcher reference becomes the
// absolute launcher path, because Claude does not expand `~` in a command.
export function serverConfig(id, cat = catalog(), env = process.env) {
	if (!cat[id]) throw new Error(`unknown MCP server '${id}' (see: mcp.mjs list)`);
	const config = structuredClone(cat[id].config);
	if (typeof config.command === 'string' && LAUNCHER_REF.test(config.command)) config.command = launcherPath(env);
	return config;
}

const claudeScope = (scope) => (scope === 'user' ? 'user' : 'local');
const failureText = (e) => String(e?.stderr || e?.stdout || e?.message || e).trim() || 'failed';

// Runs the plan. managed.json gains and loses only what a command really did.
export function applySync(plan, { repo, env = process.env, cat = catalog() } = {}) {
	const bin = claudeBin(env);
	const key = repoKey(repo);
	const managed = readManaged(env);
	const childEnv = { ...process.env, ...env };
	const done = [];
	const failed = [];
	const listOf = (scope) => (scope === 'user' ? managed.mcp.user : (managed.mcp.local[key] ??= []));
	const steps = [...plan.remove.map((s) => ({ ...s, action: 'remove' })), ...plan.add.map((s) => ({ ...s, action: 'add' }))];
	for (const step of steps) {
		const { id, scope, action } = step;
		const fail = (error) => failed.push({ id, scope, action, error });
		if (scope === 'project' && !key) {
			fail('the project scope needs a repository');
			continue;
		}
		if (action === 'add' && cat[id]?.config && LAUNCHER_REF.test(String(cat[id].config.command)) && !fs.existsSync(launcherPath(env))) {
			fail(`dev-factory install --apply first: the ${id} server runs through the launcher`);
			continue;
		}
		try {
			const args =
				action === 'add'
					? ['mcp', 'add-json', '-s', claudeScope(scope), id, JSON.stringify(serverConfig(id, cat, env))]
					: ['mcp', 'remove', '-s', claudeScope(scope), id];
			execFileSync(bin, args, {
				cwd: scope === 'project' ? repo : undefined,
				env: childEnv,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 60000,
			});
		} catch (e) {
			// removing what is already gone is the state we wanted
			if (!(action === 'remove' && /no mcp server found/i.test(failureText(e)))) {
				fail(failureText(e));
				continue;
			}
		}
		const list = listOf(scope);
		if (action === 'add' && !list.includes(id)) list.push(id);
		if (action === 'remove') list.splice(0, list.length, ...list.filter((x) => x !== id));
		done.push({ id, scope, action });
	}
	if (done.length) writeManaged(env, managed);
	return { done, failed };
}

// ---- the scheduled pass ----

// Writes { mcpServers } for the wanted servers, variable references intact. The entries of a legacy .mcp.json are never copied:
// without --strict-mcp-config Claude loads that file's servers itself, and a copy is a second place for a literal secret to land.
// So a legacy entry the wanted set does not write makes the pass non-strict, and the reason names it. A wanted server Claude has
// only from elsewhere (a claude.ai connector, a hand-made user entry: listed, not ours, not in the legacy file) is not written
// either, so it is used as it is; the pass then cannot be strict, or it would lose it.
// Returns { file, strict, reason }: strict says whether `--strict-mcp-config` is safe to pass.
export function writePassConfig({ want, cat = catalog(), env = process.env, file, listing = '', legacyFile, managed = readManaged(env), repo } = {}) {
	const root = repo ?? projectRoot();
	if (!file) {
		if (!root) throw new Error('not inside a git repository: the pass config lives in <repository>/.devfactory/mcp.json');
		ensureProjectDir(root);
		file = path.join(root, PROJECT_FILES.mcp);
	}
	const key = repoKey(root);
	const legacy = Object.keys(legacyFile ? readProject(legacyFile).mcpServers ?? {} : {});
	const mine = new Set([...managed.mcp.user, ...(key ? managed.mcp.local[key] ?? [] : [])]);
	const entries = parseListing(listing);
	const mcpServers = {};
	const external = [];
	for (const { id } of want) {
		if (!mine.has(id) && !legacy.includes(id) && findServer(id, entries)) {
			external.push(id);
			continue;
		}
		mcpServers[id] = serverConfig(id, cat, env);
	}
	const fromLegacy = legacy.filter((id) => !(id in mcpServers));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ mcpServers }, null, '\t')}\n`);
	const reasons = [
		...(external.length
			? [
					`${external.join(', ')} ${external.length > 1 ? 'are' : 'is'} available only from outside the generated file (a user-scope entry or a claude.ai connector), so the pass also loads Claude's other servers`,
				]
			: []),
		...(fromLegacy.length
			? [
					`${fromLegacy.join(', ')} ${fromLegacy.length > 1 ? 'come' : 'comes'} from .mcp.json; Claude loads them itself (run dev-factory mcp migrate)`,
				]
			: []),
	];
	return { file, strict: reasons.length === 0, reason: reasons.join('; ') };
}

// Every variable the wanted servers read, plus the one an unattended run needs. A variable counts as set when the environment
// or the state folder's .env.local (read as text, never run) holds a value. No value is returned.
export function secretsReport({ want, cat = catalog(), env = process.env } = {}) {
	let stored = new Map();
	try {
		stored = parseEnvText(fs.readFileSync(path.join(stateDir(env), '.env.local'), 'utf8'));
	} catch {
		// no store yet
	}
	const rows = new Map();
	const note = (name, by, optional) => {
		const row = rows.get(name) ?? { name, state: env[name] || stored.get(name) ? 'set' : 'empty', neededBy: [], optional: true };
		if (!row.neededBy.includes(by)) row.neededBy.push(by);
		row.optional = row.optional && optional;
		rows.set(name, row);
	};
	for (const { id } of want) for (const name of cat[id]?.secrets ?? []) note(name, id, cat[id].secretsOptional === true);
	note('CLAUDE_CODE_OAUTH_TOKEN', 'unattended runs', true);
	return [...rows.values()];
}

// ---- the legacy .mcp.json ----

// `${NAME:-default}` and `${NAME}` are the same reference; only the default differs between a file and the catalog.
const normalise = (v) =>
	typeof v === 'string'
		? v.replace(/\$\{([A-Za-z0-9_]+)(?::-[^}]*)?\}/g, '${$1}')
		: Array.isArray(v)
			? v.map(normalise)
			: isObject(v)
				? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalise(x)]))
				: v;

// The entry scripts/jira-mcp-config.mjs wrote: a shell that runs the server, with at most the Jira host in its environment.
const isLegacyJiraEntry = (id, config) =>
	id === 'jira' &&
	config?.command === 'bash' &&
	isDeepStrictEqual(config.args, legacyJiraEntry().args) &&
	Object.keys(config.env ?? {}).every((k) => k === 'JIRA_SITE');

// An entry the factory wrote moves to the settings (`adopt`): one equal to the catalog's (ignoring a variable's default), to what
// serverConfig writes (the jira server with its absolute launcher path), or jira-mcp-config.mjs's own. Anything else is the person's own (`keep`).
export function planLegacyMigration(file, cat = catalog(), env = process.env) {
	return Object.entries(readProject(file).mcpServers ?? {}).map(([id, config]) => ({
		id,
		action:
			cat[id] &&
			(isDeepStrictEqual(normalise(config), normalise(cat[id].config)) ||
				isDeepStrictEqual(config, serverConfig(id, cat, env)) ||
				isLegacyJiraEntry(id, config))
				? 'adopt'
				: 'keep',
	}));
}
