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
const prs = JSON.parse(
	execFileSync('gh', ['pr', 'list', '--state', 'merged', '--limit', '200', '--json', 'title,body,mergedAt,comments'], { encoding: 'utf8' }),
);
const since = opt('since', '');
const entries = entriesFromPrs(prs.filter((p) => !since || p.mergedAt > since));
console.log(JSON.stringify({ entries: entries.length, candidates: promotionCandidates(entries, Number(opt('min', 2))) }, null, 2));
