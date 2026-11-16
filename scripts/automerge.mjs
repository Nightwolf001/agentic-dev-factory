// Merge, or get ready to merge, one factory PR on the scheduler's behalf. It gathers the facts (gh for the PR and the bot's review
// threads, qa.mjs for the evidence), hands them to `decide` (scripts/automerge-lib.mjs) and performs at most ONE write:
// `gh pr ready` for a draft, or the merge pinned to the commit that was checked. Nothing is retried and nothing falls back: a
// merge that gh rejects (the branch moved) is a `failed`, and the next pass looks again.
//
//   automerge.mjs run --pr N --key KEY --worktree DIR --labels-file FILE [--dry-run]
//
// FILE holds the task's labels, one per line (an empty file is no labels). It is a file, not an argument, because the command runs
// outside the sandbox and a label is text anyone with access to the tracker can write. The head the script marked ready is its own
// record, <worktree>/.dev-factory/automerge.json, written right after a successful `gh pr ready`, never read from a comment.
//
// prints one JSON line {action, via, pr, head, lines, reasons, notes} (a dry run adds "dryRun": true and names the action it
// would take: ready or merge) and exits 0 for ready/merged, 10 wait, 11 refused, 12 off, 21 failed.
// It runs as the scheduler, outside the agents' sandbox, where `gh` and its credentials are reachable.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, changedLines, decide, mergeArgs, scope } from './automerge-lib.mjs';
import { load } from './config.mjs';
import { isMain } from './is-main.mjs';
import { PLUGIN_ROOT } from './plugin-root.mjs';

const VIEW_FIELDS = 'number,state,isDraft,headRefOid,headRefName,mergeStateStatus,reviewDecision,additions,deletions,body,statusCheckRollup';
const THREADS_QUERY =
	'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved comments(first:1){nodes{author{login}}}}}}}}';

const VALUE_FLAGS = ['pr', 'key', 'labels-file', 'worktree'];
// the tick builds the command line from these, so a key is plain: no quote, space, `$`, `;` or leading dash
const KEY = /^[A-Za-z0-9][A-Za-z0-9._#-]*$/;
const RECORD = ['.dev-factory', 'automerge.json'];

// The head this script last marked ready for this PR, or null. A missing, unreadable or foreign record is null, which at worst
// readies once more a PR a person turned back into a draft.
function readiedHead(worktree, number) {
	try {
		const rec = JSON.parse(fs.readFileSync(path.join(worktree, ...RECORD), 'utf8'));
		return rec?.pr === number && typeof rec.readied === 'string' && rec.readied !== '' ? rec.readied : null;
	} catch {
		return null;
	}
}

function recordReadied(worktree, number, head) {
	const file = path.join(worktree, ...RECORD);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ readied: head, pr: number })}\n`);
}

// One label per line, trimmed, blank lines dropped. A comma is part of a label, as a tracker allows.
const readLabels = (file) =>
	fs
		.readFileSync(file, 'utf8')
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean);

export function parseArgs(argv) {
	const out = { dryRun: false };
	const list = [...argv];
	if (list[0] === 'run') list.shift();
	for (let i = 0; i < list.length; i++) {
		const a = list[i];
		if (a === '--dry-run') out.dryRun = true;
		else if (a.startsWith('--') && VALUE_FLAGS.includes(a.slice(2))) {
			const v = list[++i];
			if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
			out[a.slice(2)] = v;
		} else throw new Error(`unknown argument ${a}`);
	}
	return out;
}

const failed = (message, extra = {}) => ({
	code: EXIT.UNKNOWN,
	result: { action: 'failed', via: null, pr: null, head: null, lines: 0, reasons: [String(message).split('\n')[0]], notes: [], ...extra },
});

// GraphQL may name a bot with or without its `[bot]` suffix, and a person may configure either: compare on the bare, lower-case name.
const botName = (login) =>
	String(login ?? '')
		.trim()
		.replace(/\[bot\]$/i, '')
		.toLowerCase();

// Bugbot's open threads and whether its check is still running. Anything unexpected throws, so the caller reports "unknown"
// rather than a count that was never read.
function bugbotFacts(gh, pr, number, author) {
	const rollup = pr.statusCheckRollup;
	if (!Array.isArray(rollup)) throw new Error('no check rollup');
	const want = botName(author);
	if (want === '') throw new Error('no Bugbot author is configured');
	// A check run is pending until its status is COMPLETED; a status context until it is SUCCESS, FAILURE or ERROR. A Bugbot check
	// that reports neither is not known to be finished, so it counts as pending.
	const checks = rollup.filter((c) => /bugbot/i.test(String(c?.name ?? '')) || /bugbot/i.test(String(c?.context ?? '')));
	const pending = checks.some((c) => {
		if (c.status) return String(c.status).toLowerCase() !== 'completed';
		return !/^(success|failure|error)$/i.test(String(c.state ?? ''));
	});
	const repo = JSON.parse(gh(['repo', 'view', '--json', 'owner,name']));
	const reply = JSON.parse(
		gh(['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-f', `owner=${repo.owner.login}`, '-f', `name=${repo.name}`, '-F', `n=${number}`]),
	);
	const threads = reply?.data?.repository?.pullRequest?.reviewThreads;
	if (!Array.isArray(threads?.nodes) || threads.pageInfo?.hasNextPage !== false) throw new Error('unexpected review thread shape');
	return {
		unresolved: threads.nodes.filter((t) => !t.isResolved && botName(t.comments?.nodes?.[0]?.author?.login) === want).length,
		pending,
		// no Bugbot check at this commit at all: it has not run (the trigger failed, it has not started, its quota ran out), which waits
		notRun: checks.length === 0,
	};
}

export async function run(argv, deps = {}) {
	let number = null;
	try {
		const a = parseArgs(argv);
		// digits only: Number() would accept 1e1, 0x10 and the like
		number = /^\d+$/.test(String(a.pr ?? '')) ? Number(a.pr) : NaN;
		if (!Number.isSafeInteger(number) || number < 1) return failed('--pr must be a positive integer');
		if (!a.key) return failed('--key is required', { pr: number });
		if (!KEY.test(a.key)) return failed('--key must be a plain task key (letters, digits, . _ # -)', { pr: number });
		if (!a.worktree) return failed('--worktree is required', { pr: number });
		if (!fs.statSync(a.worktree, { throwIfNoEntry: false })?.isDirectory())
			return failed('--worktree must be an existing directory', { pr: number });
		// required, even when empty: a forgotten file would hide a parked label as surely as a missing one
		if (!a['labels-file']) return failed('--labels-file is required', { pr: number });
		const labels = readLabels(a['labels-file']); // a missing or unreadable file throws: a failed line
		const { gh, qa } = deps;
		const cfg = typeof deps.cfg === 'function' ? deps.cfg() : deps.cfg; // a loader runs here, inside the try: a broken config is a failed line

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
		if (scope({ cfg, labels, pr }) === null) {
			// off (the feature is off, or the PR is neither small nor labelled) needs no evidence: ask qa and GitHub nothing more, so a
			// hiccup there cannot turn a PR for a person into a failure
			decision = decide({ cfg, labels, pr });
		} else {
			const verified = qa(['verify', '--head', head, '--key', a.key, '--require-review', 'true', '--worktree', a.worktree]).status === 0;
			// at the PR's own head: without --head qa reads the worktree's HEAD, which may be another commit
			const status = qa(['review', 'status', '--head', head, '--worktree', a.worktree]);
			if (status.status !== 0) throw new Error(`qa review status exited ${status.status}`);
			const review = JSON.parse(status.stdout);
			if (String(review?.head ?? '').toLowerCase() !== String(head).toLowerCase()) throw new Error('qa review status describes another commit');
			let bugbot;
			if (cfg.review?.bugbot !== true) bugbot = { unresolved: 0, pending: false };
			else {
				try {
					bugbot = bugbotFacts(gh, pr, number, cfg.review.bugbotAuthor);
				} catch {
					bugbot = undefined; // unknown, which `decide` waits on; a failed read is never zero
				}
			}
			// a stacked PR waits for its blocker to merge: read the blocker's state; a failed read is unknown, which waits too
			let blocker;
			const stack = /stacked on PR #(\d+)/i.exec(String(pr.body ?? ''));
			if (stack) {
				try {
					blocker = { pr: Number(stack[1]), state: JSON.parse(gh(['pr', 'view', stack[1], '--json', 'state'])).state };
				} catch {
					blocker = undefined;
				}
			}
			decision = decide({ cfg, labels, pr, verified, review, bugbot, blocker, readiedHead: readiedHead(a.worktree, number) });
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
				// the PR is ready now, whatever happens to the record: a failed write is a note, never a retry and never a merge
				try {
					recordReadied(a.worktree, number, head);
				} catch (e) {
					const why = String(e?.message ?? e).split('\n')[0];
					return done('ready', { ...decision, notes: [...decision.notes, `could not record the readied head: ${why}`] }, EXIT.DONE);
				}
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
	const { code, result } = await run(process.argv.slice(2), { gh: defaultGh, qa: defaultQa, cfg: load });
	console.log(JSON.stringify(result));
	process.exit(code);
}
