// Which platform a mobile ticket runs on, and small pieces of the device lane that are easier to get right in JavaScript than
// in shell.
//
//   mobile-platform.mjs resolve [--worktree DIR] [--text-file F] [--record]
//        prints ios or android. Explicit settings win, in this order: DF_MOBILE_PLATFORM, mobile.platform, the `platform` in the
//        worktree's .dev-factory/run.json. Without one, the ticket text decides (--text-file): android only when it names
//        Android and names no iOS term. Otherwise ios. --record writes the answer into run.json so the rest of the run agrees.
//   mobile-platform.mjs metro-command CMD [--client-logs true|false]
//        prints the dev-server command with --client-logs added where it belongs
//
// mobile.platform must not be set in config.json's defaults: a default would always win and the inference below would never run.
import fs from 'node:fs';
import path from 'node:path';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';

export const PLATFORMS = ['ios', 'android'];

const ANDROID = /\bandroid\b|\bkotlin\b|\bgradle\b|\bplay store\b/i;
const IOS = /\bios\b|\biphone\b|\bipad\b|\bxcode\b|\bswift(ui)?\b|\bcocoapods?\b|\btestflight\b|\bapp store\b|\bsimulator\b/i;

// Android only when the text names Android and no iOS term: a ticket that mentions both is not for one platform, and the
// platform the factory has always used is the safe default.
export function inferPlatform(text) {
	const t = String(text ?? '');
	return ANDROID.test(t) && !IOS.test(t) ? 'android' : 'ios';
}

const validPlatform = (p) => (PLATFORMS.includes(String(p ?? '').toLowerCase()) ? String(p).toLowerCase() : null);

export function resolvePlatform({ env = process.env, cfg = null, run = null, text = null } = {}) {
	const explicit =
		validPlatform(env.DF_MOBILE_PLATFORM) ?? validPlatform(cfg ? get('mobile.platform', { config: cfg }) : null) ?? validPlatform(run?.platform);
	if (explicit) return { platform: explicit, source: 'explicit' };
	if (text != null) return { platform: inferPlatform(text), source: 'ticket' };
	return { platform: 'ios', source: 'default' };
}

// A Metro command with --client-logs. The flag goes on the last command of an `&&` chain (the one that starts the server), and
// behind `--` when that command is an npm script, since npm would otherwise keep the flag for itself.
export function withClientLogs(cmd, enabled = true) {
	const c = String(cmd ?? '');
	if (!enabled || !c.trim() || /--client-logs\b/.test(c)) return c;
	const at = c.lastIndexOf('&&');
	const last = at < 0 ? c : c.slice(at + 2);
	const npm = /^\s*npm\s+(run|start|run-script)\b/.test(last);
	if (npm && !/\s--(\s|$)/.test(last)) return `${c.trimEnd()} -- --client-logs`;
	return `${c.trimEnd()} --client-logs`;
}

const readRun = (worktree) => {
	try {
		return JSON.parse(fs.readFileSync(path.join(worktree, '.dev-factory', 'run.json'), 'utf8'));
	} catch {
		return null;
	}
};

if (isMain(import.meta.url)) {
	const argv = process.argv.slice(2);
	const val = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
	try {
		if (argv[0] === 'resolve') {
			const worktree = val('worktree') ? path.resolve(val('worktree')) : null;
			const run = worktree ? readRun(worktree) : null;
			const text = val('text-file') ? fs.readFileSync(val('text-file'), 'utf8') : null;
			let cfg = null;
			try {
				cfg = load();
			} catch {
				/* no readable config: the environment and the ticket still decide */
			}
			const r = resolvePlatform({ cfg, run, text });
			if (argv.includes('--record') && run && worktree && r.source !== 'explicit') {
				// written beside and renamed over: a hook reading run.json meanwhile sees the old file or the new one, never half of it
				const file = path.join(worktree, '.dev-factory', 'run.json');
				const tmp = `${file}.${process.pid}.tmp`;
				fs.writeFileSync(tmp, JSON.stringify({ ...run, platform: r.platform }, null, 2) + '\n');
				fs.renameSync(tmp, file);
			}
			console.log(r.platform);
		} else if (argv[0] === 'metro-command') {
			let cfg = null;
			try {
				cfg = load();
			} catch {
				/* defaults below */
			}
			const flag = val('client-logs');
			const enabled = flag !== undefined ? flag !== 'false' : cfg ? get('mobile.clientLogs', { config: cfg }) !== false : true;
			console.log(withClientLogs(argv[1], enabled));
		} else throw new Error('usage: mobile-platform.mjs resolve [--worktree DIR] [--text-file F] [--record] | metro-command CMD');
	} catch (e) {
		console.error(`mobile-platform: ${e.message}`);
		process.exit(1);
	}
}
