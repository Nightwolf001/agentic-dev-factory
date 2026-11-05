// The task-source credentials for a command a person runs by hand. A scheduled pass loads the state folder's .env.local into its
// environment (scripts/runtime.sh); `dev-factory tasks list` typed in a terminal has no such step, so a Jira list there would fail
// or, worse, look empty. This reads the file as TEXT and takes only the tracker credential names (and the Jira host) from it, and only for names the
// environment does not already set. It never executes the file (no `source`, no substitution): whatever else the file holds, such as
// DF_TAKEOVER or a command in a value, stays where it is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TRACKER_NAMES = ['JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_SITE', 'NOTION_TOKEN'];

// NAME=value or export NAME=value, one per line. A value in matching quotes loses them; nothing is expanded, so $(...) and $VAR stay literal text.
export function parseEnvText(text) {
	const out = new Map();
	for (const raw of String(text ?? '').split(/\r?\n/)) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
		if (!m) continue;
		let v = m[2].trim();
		const q = /^(["'])([\s\S]*)\1\s*(?:#.*)?$/.exec(v);
		if (q) v = q[2];
		else v = v.replace(/\s+#.*$/, '');
		out.set(m[1], v);
	}
	return out;
}

export const stateDir = (env = process.env) => env.DF_STATE_DIR || path.join(os.homedir(), '.dev-factory');

// -> the names filled in
export function loadTrackerEnv({ env = process.env, dir = stateDir(env) } = {}) {
	let text;
	try {
		text = fs.readFileSync(path.join(dir, '.env.local'), 'utf8');
	} catch {
		return [];
	}
	const parsed = parseEnvText(text);
	const filled = [];
	for (const name of TRACKER_NAMES) {
		if (env[name]) continue;
		const v = parsed.get(name);
		if (v) {
			env[name] = v;
			filled.push(name);
		}
	}
	return filled;
}

// Why .env.local cannot keep `value`, or null. The file is sourced by a shell, and a single quote or a line break cannot be written
// into it safely. setEnvValue refuses by this test, and the settings page asks it before accepting a secret.
export function envValueProblem(value) {
	return /['\r\n\0]/.test(String(value)) ? 'the value holds a quote or a line break, which .env.local cannot keep safely' : null;
}

// Sets NAME in <state>/.env.local, mode 600. The line that holds NAME is replaced where it stands (an `export ` prefix is kept) and
// every other line, comment and blank is left as it is; a new name is appended. The file is sourced by the shell that starts a
// scheduled pass, so a value that is not plain text is single-quoted, and one that cannot be (a quote or a line break) is refused.
// Never prints the value. -> the file
export function setEnvValue(name, value, { env = process.env, dir = stateDir(env) } = {}) {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${name} is not a variable name`);
	const text = String(value);
	const problem = envValueProblem(text);
	if (problem) throw new Error(`${name}: ${problem}`);
	const file = path.join(dir, '.env.local');
	let lines = [];
	try {
		lines = fs.readFileSync(file, 'utf8').split('\n');
		if (lines.at(-1) === '') lines.pop();
	} catch {
		// no store yet
	}
	const own = new RegExp(`^(\\s*(?:export\\s+)?)${name}=`);
	const written = (prefix = '') => `${prefix}${name}=${/^[A-Za-z0-9_.\/:@+=,%-]*$/.test(text) ? text : `'${text}'`}`;
	let placed = false;
	const out = [];
	for (const line of lines) {
		const m = own.exec(line);
		if (!m) out.push(line);
		else if (!placed) {
			out.push(written(m[1]));
			placed = true;
		}
	}
	if (!placed) out.push(written());
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${out.join('\n')}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
	return file;
}
