// How many open PRs belong to the factory, for the cap on open PRs (caps.maxOpenPrs). `gh pr list --author @me` counts every
// PR the person has open, their own work included, so the factory would stop claiming whenever its owner was busy. A PR is
// the factory's when its title or branch carries, as a whole word, the key of a task that is in flight (in progress or in
// review): `X-390` is not in `X-3901`.
//
//   open-prs.mjs [--max N]    prints {"open": n, "keys": [...], "max": N}; exit 0 under the cap, 20 at or over it
//                             (do not claim), 21 when it could not be counted (do not claim either: unknown is not zero)
//
// It runs as the scheduler, outside the agents' sandbox, where `gh` and the task source are reachable.
import { execFileSync } from 'node:child_process';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';
import { makeSource } from './sources/index.mjs';
import { loadTrackerEnv } from './state-env.mjs';

export const AT_CAP = 20;
export const UNKNOWN = 21;

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The word-boundary test for a key. A key is not part of a longer one on either side: `-` before it would make `12` match `APP-12`.
export const mentionsKey = (text, key) => !!key && new RegExp(`(?<![A-Za-z0-9-])${escapeRe(key)}(?![A-Za-z0-9])`).test(String(text ?? ''));

// -> the open PRs (number, title, branch) that carry one of `keys`
export function factoryPrs(prs, keys) {
	return prs.filter((pr) => keys.some((k) => mentionsKey(pr.title, k) || mentionsKey(pr.headRefName, k)));
}

export async function countOpen({ cfg = load(), list, prs } = {}) {
	const tasks = [...(await list({ states: ['inProgress'] })), ...(await list({ states: ['inReview'] }))];
	const keys = [...new Set(tasks.map((t) => t.key).filter(Boolean))];
	const mine = factoryPrs(await prs(), keys);
	return { open: mine.length, keys: mine.map((p) => p.number), inFlight: keys.length };
}

const ghPrs = () =>
	JSON.parse(execFileSync('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,headRefName'], { encoding: 'utf8' }));

if (isMain(import.meta.url)) {
	// run by hand (the status command) nothing has loaded .env.local: without this a Notion count fails with a 401
	loadTrackerEnv();
	const argv = process.argv.slice(2);
	const cfg = load();
	const max = Number(argv.includes('--max') ? argv[argv.indexOf('--max') + 1] : get('caps.maxOpenPrs', { config: cfg }));
	try {
		const source = makeSource(cfg);
		const r = await countOpen({ cfg, list: (f) => source.list(f), prs: ghPrs });
		console.log(JSON.stringify({ ...r, max }));
		process.exit(r.open >= max ? AT_CAP : 0);
	} catch (e) {
		console.log(JSON.stringify({ open: 'unknown', error: String(e.message).split('\n')[0] }));
		process.exit(UNKNOWN);
	}
}
