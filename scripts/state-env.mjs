// The task-source credentials for a command a person runs by hand. A scheduled pass loads the state folder's .env.local into its
// environment (scripts/runtime.sh); `dev-factory tasks list` typed in a terminal has no such step, so a Jira list there would fail
// or, worse, look empty. This reads the file as TEXT and takes only the tracker credential names from it, and only for names the
// environment does not already set. It never executes the file (no `source`, no substitution): whatever else the file holds, such as
// DF_TAKEOVER or a command in a value, stays where it is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TRACKER_NAMES = ['JIRA_EMAIL', 'JIRA_API_TOKEN', 'NOTION_TOKEN'];

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
