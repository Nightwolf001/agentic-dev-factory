// Merge, or get ready to merge, one factory PR on the scheduler's behalf. It gathers the facts (gh for the PR and the bot's review
// threads, qa.mjs for the evidence), hands them to `decide` (scripts/automerge-lib.mjs) and performs at most ONE write:
// `gh pr ready` for a draft, or the merge pinned to the commit that was checked. Nothing is retried and nothing falls back: a
// merge that gh rejects (the branch moved) is a `failed`, and the next pass looks again.
//
//   automerge.mjs run --pr N --key KEY --worktree DIR [--labels a,b] [--readied-head SHA] [--dry-run]
//
// prints one JSON line {action, via, pr, head, lines, reasons, notes} (a dry run adds "dryRun": true and names the action it
// would take: ready or merge) and exits 0 for ready/merged, 10 wait, 11 refused, 12 off, 21 failed.
// It runs as the scheduler, outside the agents' sandbox, where `gh` and its credentials are reachable.
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { EXIT, changedLines, decide, mergeArgs } from './automerge-lib.mjs';
import { load } from './config.mjs';
import { isMain } from './is-main.mjs';
import { PLUGIN_ROOT } from './plugin-root.mjs';

const VIEW_FIELDS = 'number,state,isDraft,headRefOid,headRefName,mergeStateStatus,reviewDecision,additions,deletions,body,statusCheckRollup';
const THREADS_QUERY =
	'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved comments(first:1){nodes{author{login}}}}}}}}';

const VALUE_FLAGS = ['pr', 'key', 'labels', 'worktree', 'readied-head'];

export function parseArgs(argv) {
	const out = { dryRun: false };
	const list = [...argv];
	if (list[0] === 'run') list.shift();
	for (let i = 0; i < list.length; i++) {
		const a = list[i];
		if (a === '--dry-run') out.dryRun = true;
		else if (a.startsWith('--') && VALUE_FLAGS.includes(a.slice(2))) out[a.slice(2)] = list[++i];
		else throw new Error(`unknown argument ${a}`);
	}
	return out;
}

const failed = (message, extra = {}) => ({
	code: EXIT.UNKNOWN,
	result: { action: 'failed', via: null, pr: null, head: null, lines: 0, reasons: [String(message).split('\n')[0]], notes: [], ...extra },
});

// Bugbot's open threads and whether its check is still running. Anything unexpected throws, so the caller reports "unknown"
// rather than a count that was never read.
function bugbotFacts(gh, pr, number, author) {
	const rollup = pr.statusCheckRollup;
	if (!Array.isArray(rollup)) throw new Error('no check rollup');
	const pending = rollup.some((c) => {
		if (!/bugbot/i.test(String(c?.name ?? c?.context ?? ''))) return false;
		return c.status ? String(c.status).toLowerCase() !== 'completed' : /^(pending|expected)$/i.test(String(c.state ?? ''));
	});
	const repo = JSON.parse(gh(['repo', 'view', '--json', 'owner,name']));
	const reply = JSON.parse(
		gh(['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-F', `owner=${repo.owner.login}`, '-F', `name=${repo.name}`, '-F', `n=${number}`]),
	);
	const threads = reply?.data?.repository?.pullRequest?.reviewThreads;
	if (!Array.isArray(threads?.nodes) || threads.pageInfo?.hasNextPage !== false) throw new Error('unexpected review thread shape');
	return { unresolved: threads.nodes.filter((t) => !t.isResolved && t.comments?.nodes?.[0]?.author?.login === author).length, pending };
}

export async function run(argv, deps = {}) {
	let number = null;
	try {
		const a = parseArgs(argv);
		number = Number(a.pr);
		if (!Number.isInteger(number) || number < 1) return failed('--pr must be a positive integer');
		if (!a.key) return failed('--key is required', { pr: number });
		if (!a.worktree) return failed('--worktree is required', { pr: number });
		const { gh, qa, cfg } = deps;
		const labels = String(a.labels ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);

		const pr = JSON.parse(gh(['pr', 'view', String(number), '--json', VIEW_FIELDS]));
		const head = pr.headRefOid;
		const shown = (d, extra = {}) => ({
			action: d.action,
			via: d.via,
			pr: number,
			head: head ?? null,
			lines: changedLines(pr),
			reasons: d.reasons,
			notes: d.notes,
			...extra,
		});
		const done = (action, d, code, extra) => ({ code, result: shown({ ...d, action }, extra) });

		let decision;
		if (cfg?.autoMerge?.enabled !== true) {
			// off needs no evidence: do not run qa for a feature that is not on
			decision = decide({ cfg, labels, pr });
		} else {
			const verified = qa(['verify', '--head', head, '--key', a.key, '--require-review', 'true', '--worktree', a.worktree]).status === 0;
			const status = qa(['review', 'status', '--worktree', a.worktree]);
			if (status.status !== 0) throw new Error(`qa review status exited ${status.status}`);
			const review = JSON.parse(status.stdout);
			let bugbot;
			if (cfg.review?.bugbot !== true) bugbot = { unresolved: 0, pending: false };
			else {
				try {
					bugbot = bugbotFacts(gh, pr, number, cfg.review.bugbotAuthor);
				} catch {
					bugbot = undefined; // unknown, which `decide` waits on; a failed read is never zero
				}
			}
			decision = decide({ cfg, labels, pr, verified, review, bugbot, readiedHead: a['readied-head'] || null });
		}

		switch (decision.action) {
			case 'off':
				return done('off', decision, EXIT.OFF);
			case 'refused':
				return done('refused', decision, EXIT.REFUSED);
			case 'wait':
				return done('wait', decision, EXIT.WAIT);
			case 'ready':
				if (a.dryRun) return done('ready', decision, EXIT.DONE, { dryRun: true });
				gh(['pr', 'ready', String(number)]);
				return done('ready', decision, EXIT.DONE);
			case 'merge': {
				const argvMerge = mergeArgs({ pr: number, head, method: cfg.autoMerge.method });
				if (a.dryRun) return done('merge', decision, EXIT.DONE, { dryRun: true });
				gh(argvMerge);
				return done('merged', decision, EXIT.DONE);
			}
			default:
				return failed(`unexpected decision ${decision.action}`, { pr: number });
		}
	} catch (e) {
		// gh's own explanation (the branch moved, not logged in) is on stderr; the first line of it is the reason
		const why = [e?.stderr, e?.message, e].map((x) => String(x ?? '').trim()).find(Boolean);
		return failed(why, { pr: number });
	}
}

const defaultGh = (argv) => execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const defaultQa = (argv) => {
	const r = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'qa.mjs'), ...argv], { encoding: 'utf8' });
	return { status: r.status ?? 1, stdout: r.stdout ?? '' };
};

if (isMain(import.meta.url)) {
	const { code, result } = await run(process.argv.slice(2), { gh: defaultGh, qa: defaultQa, cfg: load() });
	console.log(JSON.stringify(result));
	process.exit(code);
}
