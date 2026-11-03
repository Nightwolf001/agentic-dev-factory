// A scheduled pass that cannot even start (the doctor fails, the task source cannot be read) used to leave one line in a log
// nobody reads. This records the last such failure and, when alerts.notify is on, shows one macOS notification per distinct
// reason, so a broken schedule is noticed once and not once per tick. A pass that gets past the preflight clears it.
//
//   preflight-alert.mjs record --reason TEXT    remember the failure; notify the first time this reason is seen
//   preflight-alert.mjs clear                   the preflight passed
//   preflight-alert.mjs show                    print the last failure, if any (doctor and `scheduler status` show it)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';

const file = (dir) => path.join(dir, 'preflight-alert.json');
export const stateDir = (env = process.env) => env.DF_STATE_DIR || path.join(os.homedir(), '.dev-factory');

export function read(dir) {
	try {
		return JSON.parse(fs.readFileSync(file(dir), 'utf8'));
	} catch {
		return null;
	}
}

// AppleScript string: backslash and quote escaped, control characters dropped
const asString = (t) =>
	`"${String(t)
		.replace(/[\u0000-\u001f]/g, ' ')
		.replace(/[\\"]/g, '\\$&')
		.slice(0, 200)}"`;

export function macNotify(reason) {
	execFileSync(
		'osascript',
		['-e', `display notification ${asString(reason)} with title "dev-factory" subtitle "a scheduled pass could not start"`],
		{ stdio: 'ignore' },
	);
}

// -> { recorded, notified }. A notification goes out the first time a reason appears and not again until the reason changes
// (or the preflight passed in between).
export function record({ dir, reason, enabled = false, notify = macNotify, now = new Date() }) {
	const text =
		String(reason ?? '')
			.replace(/\s+/g, ' ')
			.trim() || 'the preflight failed';
	const before = read(dir);
	const fresh = before?.notifiedFor !== text;
	let notified = false;
	if (enabled && fresh) {
		try {
			notify(text);
			notified = true;
		} catch {
			/* no notification centre here: the record is still kept */
		}
	}
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		file(dir),
		JSON.stringify(
			{
				reason: text,
				at: now.toISOString(),
				since: before?.reason === text ? before.since : now.toISOString(),
				notifiedFor: notified ? text : before?.notifiedFor ?? null,
			},
			null,
			2,
		) + '\n',
	);
	return { recorded: true, notified };
}

export const clear = (dir) => fs.rmSync(file(dir), { force: true });

export function describe(dir) {
	const r = read(dir);
	return r ? `last preflight failure: ${r.reason} (since ${r.since ?? r.at}, last seen ${r.at})` : null;
}

if (isMain(import.meta.url)) {
	const argv = process.argv.slice(2);
	const dir = stateDir();
	if (argv[0] === 'record') {
		let enabled = false;
		try {
			enabled = process.platform === 'darwin' && get('alerts.notify', { config: load() }) === true;
		} catch {
			/* no readable config: no notification */
		}
		const reason = argv.includes('--reason') ? argv[argv.indexOf('--reason') + 1] : '';
		console.log(JSON.stringify(record({ dir, reason, enabled })));
	} else if (argv[0] === 'clear') clear(dir);
	else if (argv[0] === 'show') {
		const d = describe(dir);
		if (d) console.log(d);
	} else {
		console.error('usage: preflight-alert.mjs record --reason TEXT | clear | show');
		process.exit(3);
	}
}
