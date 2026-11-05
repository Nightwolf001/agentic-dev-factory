// Companion plugins (plugins.json): which are on, at which scope, and what the factory installed into Claude Code. A person turns
// one on for every project (their user settings file) or for one (its .devfactory/config.json) as `plugins.enabled.<id>: true`;
// `sync` makes Claude match, with `claude plugin install <id> --scope user|local` run in the main checkout for the local scope.
// <machine folder>/managed.json records what the factory installed, so only that is ever uninstalled; a plugin you installed yourself is
// used as it is, and a project-layer `false` on a plugin that is on for every project only disables it in that project
// (`claude plugin disable <id> --scope local`). Beside the `mcp` record, which this file leaves as it finds it.
//
//   plugins.mjs sync [--dry-run]   make Claude's user and local scopes match the settings
//   plugins.mjs list               every plugin of plugins.json and where it is on: user, proj or off
//
//   desiredPlugins(layers, cat)    the plugins the settings turn on: { id, scope: 'user' | 'project', required, off? }
//   planPlugins(...)               what to install, disable and uninstall
//   applyPlugins(plan, ...)        runs it, and records in managed.json only what a command really did
//
// A plugin the settings do not name is wanted at its defaultScope (the required one always; an optional one unless
// DF_INSTALL_OPTIONAL=0). DF_CLAUDE_BIN names the claude program to run (tests put a fake there).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layers } from './config.mjs';
import { isMain } from './is-main.mjs';
import { claudeBin, mainCheckout, readManaged, repoKey, writeManaged } from './mcp-scope.mjs';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins.json');

// -> { plugins: [{ id, required, why, defaultScope }], marketplaces }
export function pluginCatalog() {
	const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
	return {
		plugins: (j.plugins ?? []).map((p) => ({
			id: p.id,
			required: p.required === true,
			why: p.why ?? '',
			defaultScope: p.defaultScope === 'project' ? 'project' : 'user',
		})),
		marketplaces: j.marketplaces ?? {},
	};
}

// ---- what the settings say ----

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const toggles = (ls, name) => {
	const map = ls.find((l) => l.name === name)?.data?.plugins?.enabled;
	return isObject(map) ? map : {};
};

// The plugins to have on. A user-layer `true` is every project, else a project-layer `true` is this one. A plugin no layer names is
// wanted at its defaultScope for an optional one unless DF_INSTALL_OPTIONAL=0. The required one is always wanted at user scope. A project-layer
// `false` on a plugin that is on for every project gives { off: 'project' }: it stays installed, and sync disables it in this project.
export function desiredPlugins(ls = layers(), cat = pluginCatalog(), env = process.env) {
	const user = toggles(ls, 'user');
	const project = toggles(ls, 'project');
	const byDefault = env.DF_INSTALL_OPTIONAL !== '0';
	const out = [];
	for (const p of cat.plugins) {
		const { id, required } = p;
		const home = p.defaultScope === 'project' ? 'project' : 'user';
		let scope = null;
		// the required plugin is on for every project whatever a layer says: checked before anything else
		if (required) scope = 'user';
		else if (user[id] === true) scope = 'user';
		else if (project[id] === true) scope = 'project';
		else if (user[id] === undefined && byDefault && !(home === 'project' && project[id] === false)) scope = home;
		if (!scope) continue;
		const row = { id, scope, required };
		if (scope === 'user' && project[id] === false && !required) row.off = 'project';
		out.push(row);
	}
	return out;
}

// The ids that stay in Claude's user scope whatever one project says: everything the user layer has not turned off, the ones the
// factory recorded (a plugin that left plugins.json is not removed behind the user's back), and the required plugin, always.
export function userKept(ls = layers(), cat = pluginCatalog(), managedIds = []) {
	const user = toggles(ls, 'user');
	const required = cat.plugins.filter((p) => p.required).map((p) => p.id);
	return [...new Set([...cat.plugins.map((p) => p.id), ...managedIds])].filter((id) => required.includes(id) || user[id] !== false);
}

// ---- what Claude has: the parsed `claude plugin list --json` ----

// null when it cannot be read; every plan built on null is empty
export function installedPlugins({ repo, env = process.env } = {}) {
	try {
		const out = execFileSync(claudeBin(env), ['plugin', 'list', '--json'], {
			cwd: repo || undefined,
			env: { ...process.env, ...env },
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 60000,
		});
		const list = JSON.parse(out);
		return Array.isArray(list) ? list : null;
	} catch {
		return null;
	}
}

// The listing's entry for a plugin at a scope. An entry of a project-bound scope (local, project) counts only for this repository.
function entryAt(installed, id, scope, key) {
	return installed.find(
		(e) =>
			e?.id === id && e.scope === scope && (!['local', 'project'].includes(scope) || !e.projectPath || !key || repoKey(e.projectPath) === key),
	);
}

// One line for each plugin about to be installed at user scope that the listing shows at local scope for this repository (what an
// older installer left): the local copy stays as it is.
export function legacyLocalNotes({ plan, installed, repo } = {}) {
	if (!Array.isArray(installed)) return [];
	const key = repoKey(repo);
	return (plan?.install ?? [])
		.filter((s) => s.scope === 'user' && entryAt(installed, s.id, 'local', key))
		.map(
			(s) =>
				`note: ${s.id} is also installed for this project (an older install); that copy is left as it is, and can be removed with: claude plugin uninstall ${s.id} --scope local`,
		);
}

// What to do to Claude's user and local scopes so they match `want` (scope 'project' there is Claude's `local`).
//   install    wanted at a scope where Claude does not have it. A plugin that is enabled at user scope serves a project that asks
//              for it, so that project installs nothing
//   disable    a plugin on for every project that this project's layer turns off: disabled at local scope, and recorded per repository.
//              Not issued again while it is recorded and the listing shows it disabled locally
//   enable     recorded as disabled by us in this repository, and no longer turned off by its layer: enabled again at local scope.
//              A plugin the factory did not disable is never enabled
//   uninstall  recorded as ours at a scope where it is no longer wanted. A user-scope plugin is there for every project, so it is
//              removed only when `userIds` (userKept) is given and no longer holds it: a project's `false` never removes it, and
//              without `userIds` no user-scope plugin is removed at all
// The required plugin is never uninstalled or disabled by any path.
// `installed` is the parsed listing. Without one nothing is planned: installing over a plugin that was already there would record
// it as ours, and removing is never safe blind.
export function planPlugins({ want, managed = readManaged(), installed, repo, userIds } = {}) {
	const plan = { install: [], disable: [], enable: [], uninstall: [] };
	if (!Array.isArray(installed)) return plan;
	const key = repoKey(repo);
	const have = (id, scope) => entryAt(installed, id, scope, key);
	const required = new Set([
		...pluginCatalog()
			.plugins.filter((p) => p.required)
			.map((p) => p.id),
		...want.filter((w) => w.required).map((w) => w.id),
	]);
	const ours = { user: new Set(managed.plugins.user), local: new Set(key ? managed.plugins.local[key] ?? [] : []) };
	const disabledByUs = new Set(key ? managed.plugins.disabled?.[key] ?? [] : []);
	const wanted = { user: new Set(), project: new Set() };
	for (const w of want) wanted[w.scope].add(w.id);
	const userOn = userIds ? new Set(userIds) : null;
	for (const w of want) {
		if (w.scope === 'user') {
			if (!have(w.id, 'user')) plan.install.push({ id: w.id, scope: 'user' });
			if (w.off === 'project' && !required.has(w.id) && have(w.id, 'user')) {
				const inEffect = disabledByUs.has(w.id) && have(w.id, 'local')?.enabled === false;
				if (!inEffect) plan.disable.push({ id: w.id, scope: 'local' });
			}
		} else {
			const usable = have(w.id, 'local') ?? have(w.id, 'project') ?? (have(w.id, 'user')?.enabled !== false ? have(w.id, 'user') : null);
			if (!usable) plan.install.push({ id: w.id, scope: 'local' });
		}
	}
	const off = new Set(want.filter((w) => w.off === 'project').map((w) => w.id));
	for (const id of disabledByUs) if (!off.has(id) && !required.has(id)) plan.enable.push({ id, scope: 'local' });
	for (const id of ours.user)
		if (!required.has(id) && !wanted.user.has(id) && userOn && !userOn.has(id)) plan.uninstall.push({ id, scope: 'user' });
	for (const id of ours.local) if (!required.has(id) && !wanted.project.has(id)) plan.uninstall.push({ id, scope: 'local' });
	return plan;
}

const claudeScope = (scope) => (scope === 'user' ? 'user' : 'local');
const failureText = (e) => String(e?.stderr || e?.stdout || e?.message || e).trim() || 'failed';

// Runs the plan. managed.json is read once and written once, and gains and loses only what a command really did.
export function applyPlugins(plan, { repo, env = process.env } = {}) {
	const bin = claudeBin(env);
	const key = repoKey(repo);
	const managed = readManaged(env);
	const childEnv = { ...process.env, ...env };
	const done = [];
	const failed = [];
	const listOf = (scope) => (scope === 'user' ? managed.plugins.user : (managed.plugins.local[key] ??= []));
	const steps = [
		...(plan.uninstall ?? []).map((s) => ({ ...s, action: 'uninstall' })),
		...(plan.enable ?? []).map((s) => ({ ...s, action: 'enable' })),
		...(plan.install ?? []).map((s) => ({ ...s, action: 'install' })),
		...(plan.disable ?? []).map((s) => ({ ...s, action: 'disable' })),
	];
	let recorded = false;
	for (const step of steps) {
		const { id, action } = step;
		const scope = claudeScope(step.scope);
		if (scope === 'local' && !key) {
			failed.push({ id, scope, action, error: 'the local scope needs a repository' });
			continue;
		}
		try {
			execFileSync(bin, ['plugin', action, id, '--scope', scope], {
				cwd: repo || undefined,
				env: childEnv,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 120000,
			});
		} catch (e) {
			// removing, or turning back on, what is already gone is the state we wanted
			if (!(['uninstall', 'enable'].includes(action) && /not (found|installed)/i.test(failureText(e)))) {
				failed.push({ id, scope, action, error: failureText(e) });
				continue;
			}
		}
		if (action === 'install') {
			const list = listOf(scope);
			if (!list.includes(id)) list.push(id);
			recorded = true;
		}
		if (action === 'uninstall') {
			const list = listOf(scope);
			list.splice(0, list.length, ...list.filter((x) => x !== id));
			recorded = true;
		}
		if (action === 'disable') {
			const list = ((managed.plugins.disabled ??= {})[key] ??= []);
			if (!list.includes(id)) list.push(id);
			recorded = true;
		}
		if (action === 'enable') {
			const list = (managed.plugins.disabled?.[key] ?? []).filter((x) => x !== id);
			if (list.length) managed.plugins.disabled[key] = list;
			else if (managed.plugins.disabled) delete managed.plugins.disabled[key];
			if (managed.plugins.disabled && !Object.keys(managed.plugins.disabled).length) delete managed.plugins.disabled;
			recorded = true;
		}
		done.push({ id, scope, action });
	}
	if (recorded) writeManaged(env, managed);
	return { done, failed };
}

// ---- the command line ----

const WHERE = { user: 'all projects', project: 'this project', local: 'this project' };

export function runSync({ dry = false, root } = {}) {
	const cat = pluginCatalog();
	const ls = layers({ from: root ?? process.cwd() });
	const want = desiredPlugins(ls, cat);
	if (!root && want.some((w) => w.scope === 'project')) throw new Error('the project scope needs a git repository: run this inside one');
	const managed = readManaged();
	const installed = installedPlugins({ repo: root });
	if (!installed) {
		console.error('plugins: cannot read the installed plugins (claude plugin list --json); nothing changed');
		if (!dry) process.exitCode = 1;
		return;
	}
	const plan = planPlugins({ want, managed, installed, repo: root, userIds: userKept(ls, cat, managed.plugins.user) });
	const named = new Set([
		...Object.keys(ls.find((l) => l.name === 'user')?.data?.plugins?.enabled ?? {}),
		...Object.keys(ls.find((l) => l.name === 'project')?.data?.plugins?.enabled ?? {}),
	]);
	const planned = new Set([...plan.install, ...plan.disable, ...plan.enable, ...plan.uninstall].map((s) => s.id));
	for (const s of plan.uninstall) console.log(`uninstall ${s.id.padEnd(44)} (${WHERE[s.scope]})`);
	for (const s of plan.enable) console.log(`enable    ${s.id.padEnd(44)} (${WHERE[s.scope]})`);
	for (const s of plan.install) console.log(`install   ${s.id.padEnd(44)} (${WHERE[s.scope]})`);
	for (const s of plan.disable) console.log(`disable   ${s.id.padEnd(44)} (${WHERE[s.scope]})`);
	for (const n of legacyLocalNotes({ plan, installed, repo: root })) console.log(n);
	for (const w of want) if (!planned.has(w.id)) console.log(`have      ${w.id.padEnd(44)} (${WHERE[w.scope]})`);
	for (const p of cat.plugins)
		if (!p.required && !named.has(p.id) && !want.some((w) => w.id === p.id) && process.env.DF_INSTALL_OPTIONAL === '0')
			console.log(`skip      ${p.id}  is optional, skipped (DF_INSTALL_OPTIONAL=0)`);
	if (dry) return;
	const { failed } = applyPlugins(plan, { repo: root, env: process.env });
	for (const f of failed) console.error(`FAILED: claude plugin ${f.action} ${f.id} --scope ${f.scope}: ${f.error}`);
	if (failed.length) process.exitCode = 1;
}

function runList(root) {
	const cat = pluginCatalog();
	const want = desiredPlugins(layers({ from: root ?? process.cwd() }), cat);
	const installed = installedPlugins({ repo: root });
	for (const p of cat.plugins) {
		const w = want.find((x) => x.id === p.id);
		const where = w ? (w.scope === 'project' ? 'proj' : 'user') : 'off';
		const state = !installed ? '' : installed.some((e) => e?.id === p.id) ? ' [installed]' : ' [not installed]';
		console.log(
			`${where.padEnd(5)} ${p.id.padEnd(44)} ${p.required ? '(required) ' : ''}${p.why}${state}${w?.off ? '\n      turned off in this project' : ''}`,
		);
	}
}

if (isMain(import.meta.url)) {
	const [cmd, ...rest] = process.argv.slice(2);
	try {
		// the main checkout, also from a linked worktree: Claude's local scope is keyed by it and its settings are the ones to read
		const root = mainCheckout();
		if (cmd === 'sync') runSync({ dry: rest.includes('--dry-run'), root });
		else if (cmd === 'list') runList(root);
		else {
			console.error('usage: plugins.mjs sync [--dry-run] | list');
			process.exit(3);
		}
	} catch (e) {
		console.error(`plugins: ${e.message}`);
		process.exit(1);
	}
}
