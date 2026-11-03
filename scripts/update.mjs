// Brings every installed copy of the dev-factory plugin up to date, and tidies what that leaves behind.
//
//   update.mjs [--check]     --check changes nothing: it says what would be updated and removed
//
//   1. refresh the marketplaces (`claude plugin marketplace update`)
//   2. update each installed copy of dev-factory (`claude plugin update <id>`): there is one per scope it was installed in
//   3. read ~/.claude/plugins/installed_plugins.json again and check each copy on disk: the folder is there, its
//      .claude-plugin/plugin.json says the version the record says, and the files the launcher and the hooks run are present
//   4. remove cached versions nothing refers to any more, across marketplaces and plugins. A version stays when an install
//      record points at it, when it is the newest cached version of its plugin, or when it changed in the last
//      DF_PRUNE_KEEP_HOURS (default 24): a session that started before the update may still be running from it.
//
// A running Claude Code session keeps the version it started with; the update applies to the next one.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain } from './is-main.mjs';

export const REQUIRED_FILES = ['.claude-plugin/plugin.json', 'bin/dev-factory', 'scripts/cli.mjs', 'hooks/hooks.json', 'config.json'];

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const pluginsDir = (env = process.env) => env.DF_PLUGINS_DIR || path.join(os.homedir(), '.claude', 'plugins');

export function defaultRun(cmd, args) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 300000 });
	return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// -> [{ id, scope, installPath, version }] for the plugin's installed copies
export function installedCopies(dir, name = 'dev-factory') {
	const j = readJson(path.join(dir, 'installed_plugins.json'));
	return Object.entries(j.plugins ?? {})
		.filter(([id]) => id.split('@')[0] === name)
		.flatMap(([id, copies]) =>
			(Array.isArray(copies) ? copies : [copies]).map((c) => ({
				id,
				scope: c.scope ?? 'user',
				installPath: c.installPath,
				version: c.version,
			})),
		);
}

// Every installPath of every plugin, so a version of any plugin that is installed is never pruned.
function allInstallPaths(dir) {
	const j = readJson(path.join(dir, 'installed_plugins.json'));
	return new Set(
		Object.values(j.plugins ?? {})
			.flat()
			.map((c) => c?.installPath)
			.filter(Boolean)
			.map((p) => safeReal(p)),
	);
}

const safeReal = (p) => {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
};

// -> { ok, problems } for one copy on disk
export function checkCopy(copy) {
	const problems = [];
	if (!copy.installPath || !fs.existsSync(copy.installPath)) return { ok: false, problems: [`${copy.installPath ?? '(no path)'} is missing`] };
	for (const f of REQUIRED_FILES) if (!fs.existsSync(path.join(copy.installPath, f))) problems.push(`missing ${f}`);
	try {
		const v = readJson(path.join(copy.installPath, '.claude-plugin', 'plugin.json')).version;
		if (copy.version && v !== copy.version) problems.push(`the record says ${copy.version} but the folder holds ${v}`);
	} catch {
		problems.push('.claude-plugin/plugin.json cannot be read');
	}
	return { ok: problems.length === 0, problems };
}

// Cached version folders: cache/<marketplace>/<plugin>/<version>
function cachedVersions(cache) {
	const out = [];
	const dirs = (p) => (fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()) : []);
	for (const m of dirs(cache))
		for (const p of dirs(path.join(cache, m.name)))
			for (const v of dirs(path.join(cache, m.name, p.name)))
				out.push({ marketplace: m.name, plugin: p.name, version: v.name, dir: path.join(cache, m.name, p.name, v.name) });
	return out;
}

const compareVersions = (a, b) => a.localeCompare(b, undefined, { numeric: true });

// -> the cached versions that nothing refers to and that are safe to remove
export function pruneCandidates({ dir, now = Date.now(), keepHours = 24 }) {
	const cache = path.join(dir, 'cache');
	const root = safeReal(cache);
	const installed = allInstallPaths(dir);
	const all = cachedVersions(cache);
	const newest = new Map();
	for (const c of all) {
		const k = `${c.marketplace}/${c.plugin}`;
		if (!newest.has(k) || compareVersions(c.version, newest.get(k)) > 0) newest.set(k, c.version);
	}
	return all.filter((c) => {
		const real = safeReal(c.dir);
		if (!real.startsWith(root + path.sep) || real === root) return false; // never outside the cache
		if (installed.has(real)) return false;
		if (newest.get(`${c.marketplace}/${c.plugin}`) === c.version) return false;
		if (now - fs.statSync(c.dir).mtimeMs < keepHours * 3600_000) return false;
		return true;
	});
}

// The version the marketplace now offers for the plugin, read from its local copy (null when it cannot be told).
export function latestOffered(dir, id) {
	const [name, marketplace] = id.split('@');
	try {
		const j = readJson(path.join(dir, 'marketplaces', marketplace, '.claude-plugin', 'marketplace.json'));
		return j.plugins?.find((p) => p.name === name)?.version ?? null;
	} catch {
		return null;
	}
}

export function update({
	check = false,
	dir = pluginsDir(),
	run = defaultRun,
	now = Date.now(),
	keepHours = Number(process.env.DF_PRUNE_KEEP_HOURS ?? 24),
} = {}) {
	const report = { check, refreshed: null, updated: [], copies: [], removed: [], problems: [] };
	let before;
	try {
		before = installedCopies(dir);
	} catch (e) {
		throw new Error(`cannot read ${path.join(dir, 'installed_plugins.json')}: ${e.message}`);
	}
	if (!before.length) throw new Error('no installed copy of dev-factory was found (claude plugin install dev-factory@<marketplace>)');
	if (!check) {
		const r = run('claude', ['plugin', 'marketplace', 'update']);
		report.refreshed = r.status === 0;
		if (!report.refreshed) report.problems.push(`marketplace refresh failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
		for (const id of [...new Set(before.map((c) => c.id))]) {
			const u = run('claude', ['plugin', 'update', id]);
			report.updated.push({ id, ok: u.status === 0, output: (u.stdout || u.stderr).trim().split('\n').pop() });
			if (u.status !== 0) report.problems.push(`update of ${id} failed: ${(u.stderr || u.stdout).trim().split('\n')[0]}`);
		}
	}
	const after = check ? before : installedCopies(dir);
	for (const c of after) {
		const v = checkCopy(c);
		const offered = latestOffered(dir, c.id);
		report.copies.push({
			...c,
			ok: v.ok,
			problems: v.problems,
			offered,
			behind: !!offered && !!c.version && compareVersions(offered, c.version) > 0,
		});
		for (const p of v.problems) report.problems.push(`${c.id} (${c.scope}): ${p}`);
	}
	// nothing is pruned after a failed update: the version a failure left behind may be the one still in use
	const candidates = report.problems.length && !check ? [] : pruneCandidates({ dir, now, keepHours });
	for (const c of candidates) {
		if (!check) fs.rmSync(c.dir, { recursive: true, force: true });
		report.removed.push(`${c.marketplace}/${c.plugin}/${c.version}`);
	}
	return report;
}

if (isMain(import.meta.url)) {
	const check = process.argv.includes('--check');
	try {
		const r = update({ check });
		console.log(JSON.stringify(r, null, 2));
		process.exit(r.problems.length ? 1 : 0);
	} catch (e) {
		console.error(`update: ${e.message}`);
		process.exit(1);
	}
}
