// The settings page: every server, plugin, secret and setting in one grouped list, with its value and where the value comes from.
//
//   settings.mjs                       the page, when stdin and stdout are terminals; otherwise `list`
//   settings.mjs list [--json]         every row, as text or as a JSON array
//   settings.mjs set ID VALUE [--user|--project]   one row: a server or plugin (on, off, user, project, default), a setting by its key,
//                                      or a secret as `set secret:NAME` with the value on standard input (never on the command line)
//   settings.mjs reset ID [--user|--project]       remove a row's override, back to the default
//
// Saving writes the layer files (your own settings file for all projects, .devfactory/config.json for this project) and .env.local
// for a secret, then makes Claude match (`mcp sync`, `plugins sync`) and prints what they did. Settings are read and written in the
// main checkout, also from a linked worktree. `set` and `reset` exit 1 with the reason when nothing changed.
import fs from 'node:fs';
import readline from 'node:readline';
import { layers, setIn } from './config.mjs';
import { isMain } from './is-main.mjs';
import { catalog, desired, mainCheckout, secretsReport } from './mcp-scope.mjs';
import { runSync as syncMcp } from './mcp.mjs';
import { pluginCatalog, runSync as syncPlugins } from './plugins.mjs';
import { buildRows, changes, editCount, initialState, optionCatalog, publicRow, reduce, render, resetRow, setRow } from './settings-lib.mjs';
import { setEnvValue } from './state-env.mjs';

const dig = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// The page's state for the repository at `repo` (the main checkout) or, outside one, the folder we are in.
export function loadState({ repo = mainCheckout(), env = process.env } = {}) {
	const ls = layers({ from: repo ?? process.cwd(), env });
	const mcpCat = catalog();
	const secrets = secretsReport({ want: desired(ls, mcpCat), cat: mcpCat, env });
	const rows = buildRows({ layers: ls, mcpCat, pluginCat: pluginCatalog(), options: optionCatalog(), secrets, env });
	return initialState(rows, { repo });
}

// Writes the changes. A removal in a layer that has no such key writes nothing (so no empty file appears).
// -> the lines to tell the person, one per change, never a secret's value
export function writeChanges(list, { repo = mainCheckout(), env = process.env } = {}) {
	const from = repo ?? process.cwd();
	const told = [];
	for (const c of list) {
		if (c.layer === 'env') {
			setEnvValue(c.key, c.value, { env });
			told.push(`saved ${c.key} to .env.local`);
			continue;
		}
		const has = dig(layers({ from, env }).find((l) => l.name === c.layer)?.data, c.key) !== undefined;
		if (c.value === undefined && !has) continue;
		setIn(c.layer, c.key, c.value, { from, env });
		told.push(c.value === undefined ? `removed ${c.key} (${c.layer})` : `set ${c.key} = ${JSON.stringify(c.value)} (${c.layer})`);
	}
	return told;
}

const touches = (list, re) => list.some((c) => c.layer !== 'env' && re.test(c.key));

// Makes Claude match, for what changed: the servers when a server (or the mobile app that makes one required) changed, the plugins when a plugin did.
export function syncAfter(list, { repo = mainCheckout() } = {}) {
	for (const [what, re, run] of [
		['mcp', /^(mcp\.|mobile\.appDir$)/, syncMcp],
		['plugins', /^plugins\./, syncPlugins],
	]) {
		if (!touches(list, re)) continue;
		try {
			run({ root: repo ?? undefined });
		} catch (e) {
			console.error(`${what} sync: ${e.message}`);
			process.exitCode = 1;
		}
	}
}

function save(list, repo) {
	for (const line of writeChanges(list, { repo })) console.log(line);
	syncAfter(list, { repo });
}

// ---- the terminal page ----

const ALT_ON = '\x1b[?1049h\x1b[?25l';
const ALT_OFF = '\x1b[?25h\x1b[?1049l';

// A keypress -> the reducer's key (while typing: a character, enter, esc, backspace).
function toKey(state, str, key = {}) {
	if (key.ctrl || key.meta) return undefined;
	const name = key.name;
	if (name === 'return' || name === 'enter') return 'enter';
	if (name === 'escape') return 'esc';
	if (name === 'backspace') return 'backspace';
	if (state.editing || state.searching) return str && str >= ' ' && str !== '\x7f' ? { char: str } : undefined;
	if (['up', 'down', 'left', 'right'].includes(name)) return name;
	if (name === 'space' || str === ' ') return 'space';
	if (str === '/') return '/';
	return ['u', 'p', 'd', 'q', 's'].includes(str) ? str : undefined;
}

// Runs the page until the person saves or quits. The terminal is put back on every way out. -> the final state
function runPage(first) {
	const { stdin, stdout } = process;
	readline.emitKeypressEvents(stdin);
	let restored = false;
	const restore = () => {
		if (restored) return;
		restored = true;
		try {
			stdin.setRawMode(false);
		} catch {
			// not a terminal any more
		}
		stdout.write(ALT_OFF);
		stdin.pause();
	};
	const onSignal = (signal) => () => {
		restore();
		process.exit(signal === 'SIGINT' ? 130 : 143);
	};
	const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => [s, onSignal(s)]);
	for (const [s, h] of handlers) process.on(s, h);
	process.on('exit', restore);
	process.on('uncaughtException', (e) => {
		restore();
		console.error(e?.stack ?? e);
		process.exit(1);
	});
	stdin.setRawMode(true);
	stdin.resume();
	stdout.write(ALT_ON);
	return new Promise((resolve) => {
		let state = first;
		const draw = () => {
			const text = render(state, { width: stdout.columns || 80, height: stdout.rows || 24 });
			stdout.write(`\x1b[H\x1b[2J${text.split('\n').join('\r\n')}`);
		};
		const done = (final) => {
			stdin.off('keypress', onKey);
			stdout.off('resize', draw);
			for (const [s, h] of handlers) process.off(s, h);
			restore();
			resolve(final);
		};
		const onKey = (str, key = {}) => {
			if (key.ctrl && key.name === 'c') return done({ ...state, exit: 'discard' });
			const k = toKey(state, str, key);
			if (k === undefined) return;
			state = reduce(state, k);
			if (state.exit) done(state);
			else draw();
		};
		stdin.on('keypress', onKey);
		stdout.on('resize', draw);
		draw();
	});
}

// ---- the plain list ----

function printList(state, json) {
	if (json) return console.log(JSON.stringify(state.rows.map(publicRow), null, 2));
	let group = null;
	for (const r of state.rows) {
		if (r.group !== group) console.log(`${group === null ? '' : '\n'}${(group = r.group)}`);
		const value = Array.isArray(r.value) || (r.value && typeof r.value === 'object') ? JSON.stringify(r.value) : r.value ?? 'unset';
		console.log(`  ${r.id.padEnd(40)} ${String(value).slice(0, 28).padEnd(28)} ${r.source.padEnd(12)}${r.locked ? ' (required)' : ''}`.trimEnd());
	}
}

function readSecret() {
	if (process.stdin.isTTY) throw new Error('pipe the value on standard input: printf %s "$VALUE" | dev-factory settings set secret:NAME');
	return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
}

if (isMain(import.meta.url)) {
	const [cmd = '', ...rest] = process.argv.slice(2);
	const flags = new Set(rest.filter((a) => a.startsWith('--')));
	const args = rest.filter((a) => !a.startsWith('--'));
	const layer = flags.has('--user') ? 'user' : flags.has('--project') ? 'project' : undefined;
	const repo = mainCheckout();
	try {
		if (cmd === '' && process.stdin.isTTY && process.stdout.isTTY) {
			const final = await runPage(loadState({ repo }));
			const list = changes(final);
			if (final.exit === 'save' && list.length) save(list, repo);
			else console.log(final.exit === 'save' ? 'nothing to save' : editCount(final) ? 'discarded: no changes saved' : 'no changes');
		} else if (cmd === '' || cmd === 'list') printList(loadState({ repo }), flags.has('--json'));
		else if (cmd === 'set' || cmd === 'reset') {
			const [ref, value] = args;
			const usage = () =>
				Object.assign(new Error(`usage: settings.mjs ${cmd} ID ${cmd === 'set' ? 'VALUE ' : ''}[--user|--project]`), { usage: true });
			if (!ref) throw usage();
			const state = loadState({ repo });
			const secret = ref.startsWith('secret:') || state.rows.some((r) => r.id === ref && r.kind === 'secret');
			if (cmd === 'set' && secret && value !== undefined)
				throw new Error('a secret value is read from standard input, not given on the command line');
			if (cmd === 'set' && !secret && value === undefined) throw usage();
			const name = secret && !ref.startsWith('secret:') ? `secret:${ref}` : ref;
			const next = cmd === 'reset' ? resetRow(state, name, { layer }) : setRow(state, name, secret ? readSecret() : value, { layer });
			const list = changes(next);
			if (!list.length) {
				console.error(`settings: ${next.message || 'nothing to change'}`);
				process.exit(1);
			}
			save(list, repo);
		} else {
			console.error(
				'usage: settings.mjs [list [--json] | set ID VALUE [--user|--project] | set secret:NAME (value on stdin) | reset ID [--user|--project]]',
			);
			process.exit(3);
		}
	} catch (e) {
		console.error(`settings: ${e.message}`);
		process.exit(e.usage ? 3 : 1);
	}
}
