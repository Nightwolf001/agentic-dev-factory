// Reads the Learnings sections of merged PR bodies and prints promotion candidates for /dev-factory:improve.
//   learnings-scan.mjs candidates [--since ISO] [--min N]
import { execFileSync } from 'node:child_process';
import { entriesFromPrs, promotionCandidates } from './learnings-lib.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);

if (argv[0] !== 'candidates') {
	console.error('usage: learnings-scan.mjs candidates [--since ISO] [--min N]');
	process.exit(3);
}
const since = opt('since', '');
// gh holds the whole list before printing it, and a few long PR bodies pass Node's 1 MiB default, so the buffer is
// raised. A --since that starts with a date also asks gh only for PRs merged from that day on; the search is
// day-granular, so the exact filter below stays.
const day = /^\d{4}-\d{2}-\d{2}/.exec(since)?.[0];
const search = day ? ['--search', `merged:>=${day}`] : [];
const ghArgs = ['pr', 'list', '--state', 'merged', '--limit', '200', ...search, '--json', 'title,body,mergedAt,comments'];
const prs = JSON.parse(execFileSync('gh', ghArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
const entries = entriesFromPrs(prs.filter((p) => !since || p.mergedAt > since));
console.log(JSON.stringify({ entries: entries.length, candidates: promotionCandidates(entries, Number(opt('min', 2))) }, null, 2));
