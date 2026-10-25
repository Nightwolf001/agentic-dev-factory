// Cheap preflight for a scheduled pass. It asks the configured task source, from a script and without a model,
// whether a paid `claude -p` session has anything to do: a claimable task, an orphaned in-progress task, or an
// in-review task whose PR was approved, merged or has fresh requested changes, a fix comment or open Bugbot threads. When not, tick.sh logs one line and
// exits without spawning.
//
//   frontier.mjs check     exit 0 = run the session; 20 = nothing to do; anything else = could not tell, no session
//   frontier.mjs commit    remember the frontier the session just looked at (tick.sh, after a clean session only)
//
// A source that needs a token the machine lacks (Jira, Notion) exits 21 (unknown); tick.sh then starts nothing
// unless DF_PREFLIGHT=off. The local and github sources need no token.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';
import { fingerprintOf, isBuildable, makeSource, missingCredentials } from './sources/index.mjs';

export const SKIP = 20;
export const UNKNOWN = 21;

export { isBuildable, fingerprintOf };

// The settings prNeedsAction reads, from the merged config.
export function actionOptions(cfg) {
	const g = (k) => get(k, { config: cfg });
	return {
		reviewedOn: g('pr.reviewedOnMergeInto') ?? null,
		doneOn: g('pr.doneOnMergeInto') ?? null,
		fixComment: g('tasks.fixComment'),
		bugbot: g('review.bugbot') === true,
		bugbotAuthor: g('review.bugbotAuthor'),
	};
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A comment asks for a fix pass when a line starts with the fix phrase, with or without the leading slash
// ("dev-factory fix", "/dev-factory fix rename the helper").
export function isFixComment(body, fixComment) {
	const phrase = String(fixComment ?? '').replace(/^\//, '');
	return !!phrase && new RegExp(`^\\s*/?${escapeRe(phrase)}(?![\\w-])`, 'im').test(String(body ?? ''));
}

// What a task in review needs from the factory. pr: { state, reviewDecision, author, baseRefName, headCommittedAt,
// reviews: [{state, submittedAt, author}], comments: [{createdAt, author, body}], bugbotOpen, reachedDone }.
// Returns 'done' (merged into pr.doneOnMergeInto, or into something that has since reached it), 'advance' (merged
// into pr.reviewedOnMergeInto, or, when that is unset, merged or approved), 'fix' (a change request from someone
// other than the PR author after the latest commit, a comment with the fix phrase after it, or open Bugbot threads)
// or null. Any other comment is never a fix request: the text goes into a builder prompt, and a bot, CI, a question
// or an LGTM would all start a paid pass.
export function prNeedsAction(pr, { reviewedOn = null, doneOn = null, fixComment = null, bugbot = false } = {}) {
	if (!pr) return null;
	if (pr.state === 'MERGED') {
		if (doneOn && (pr.baseRefName === doneOn || pr.reachedDone)) return 'done';
		if (!reviewedOn || pr.baseRefName === reviewedOn) return 'advance';
		return null;
	}
	if (!reviewedOn && pr.reviewDecision === 'APPROVED') return 'advance';
	const after = (at) => Date.parse(at) > Date.parse(pr.headCommittedAt);
	const requested = (pr.reviews ?? []).some((r) => r.state === 'CHANGES_REQUESTED' && r.author !== pr.author && after(r.submittedAt));
	const asked = (pr.comments ?? []).some((c) => !/\[bot\]$/.test(c.author ?? '') && after(c.createdAt) && isFixComment(c.body, fixComment));
	return requested || asked || (bugbot && pr.bugbotOpen > 0) ? 'fix' : null;
}

// deps: { list({states, staleMinutes}) -> tasks[], prState(key) -> pr data for prNeedsAction }, state: { fingerprint, at } | null
export async function decide({ cfg, deps, state, now = Date.now() }) {
	const repeatMs = get('caps.frontierRepeatHours', { config: cfg }) * 3600_000;
	const stall = get('caps.stallMinutes', { config: cfg });
	const opts = actionOptions(cfg);
	const strays = await deps.list({ states: ['inProgress'], staleMinutes: stall });
	if (strays.length) return { run: true, reason: `${strays.length} orphaned in-progress task(s)` };
	for (const t of await deps.list({ states: ['inReview'] })) {
		const action = prNeedsAction(await deps.prState(t.key, opts), opts);
		if (action) return { run: true, reason: `${t.key} PR ${action === 'fix' ? 'has review feedback' : 'is merged or approved'}` };
	}
	// reviewed is the people's stage unless a merge into a later branch is what finishes a task
	if (opts.doneOn) {
		for (const t of await deps.list({ states: ['reviewed'] })) {
			if (prNeedsAction(await deps.prState(t.key, opts), opts) === 'done') return { run: true, reason: `${t.key} reached ${opts.doneOn}` };
		}
	}
	const frontier = (await deps.list({ states: ['ready'] })).filter(isBuildable);
	if (!frontier.length) return { run: false, reason: 'frontier empty' };
	const fp = fingerprintOf(frontier);
	if (state?.fingerprint === fp && now - Date.parse(state.at) < repeatMs) {
		return { run: false, reason: `frontier unchanged since the last session looked at it (${frontier.map((t) => t.key).join(', ')})` };
	}
	return { run: true, reason: `${frontier.length} claimable task(s)`, fingerprint: fp };
}

export const stateDir = (env = process.env) => env.DF_STATE_DIR || path.join(os.homedir(), '.dev-factory');
const pendingFile = (dir) => path.join(dir, 'frontier.pending.json');
const committedFile = (dir) => path.join(dir, 'frontier.json');

// The fingerprint of a frontier a session is about to look at is only remembered once that session ended cleanly,
// so a crash or a budget stop never hides claimable tasks from the next pass.
export function savePending(dir, fingerprint, now = new Date()) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(pendingFile(dir), JSON.stringify({ fingerprint, at: now.toISOString() }));
}

export function commitPending(dir) {
	if (!fs.existsSync(pendingFile(dir))) return false;
	fs.renameSync(pendingFile(dir), committedFile(dir));
	return true;
}

export function discardPending(dir) {
	fs.rmSync(pendingFile(dir), { force: true });
}

const THREADS_QUERY =
	'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login}}}}}}}}';

// The PR a task produced, found by its key in the title (every factory PR title ends in [KEY]). opts adds the reads the
// review settings need: Bugbot's unresolved threads (bugbotAuthor) and whether a merge reached the done branch (doneOn).
export function prStateFor(
	key,
	run = (args) => execFileSync('gh', args, { encoding: 'utf8' }),
	{ doneOn = null, bugbot = false, bugbotAuthor = null } = {},
) {
	const list = JSON.parse(run(['pr', 'list', '--state', 'all', '--search', `${key} in:title`, '--json', 'number', '--limit', '1']));
	if (!list.length) return null;
	const number = String(list[0].number);
	const pr = JSON.parse(run(['pr', 'view', number, '--json', 'state,reviewDecision,author,commits,reviews,comments,baseRefName,mergeCommit']));
	const last = pr.commits?.[pr.commits.length - 1];
	let bugbotOpen = 0;
	if (bugbot && bugbotAuthor && pr.state === 'OPEN') {
		const repo = JSON.parse(run(['repo', 'view', '--json', 'owner,name']));
		const threads = JSON.parse(
			run([
				'api',
				'graphql',
				'-f',
				`query=${THREADS_QUERY}`,
				'-F',
				`owner=${repo.owner.login}`,
				'-F',
				`name=${repo.name}`,
				'-F',
				`n=${number}`,
			]),
		).data.repository.pullRequest.reviewThreads.nodes;
		bugbotOpen = threads.filter((t) => !t.isResolved && t.comments.nodes[0]?.author?.login === bugbotAuthor).length;
	}
	let reachedDone = false;
	if (doneOn && pr.state === 'MERGED' && pr.mergeCommit?.oid && pr.baseRefName !== doneOn) {
		// the merge is on the done branch when that branch is ahead of it or level with it
		const status = run(['api', `repos/{owner}/{repo}/compare/${doneOn}...${pr.mergeCommit.oid}`, '--jq', '.status']).trim();
		reachedDone = status === 'behind' || status === 'identical';
	}
	return {
		state: pr.state,
		reviewDecision: pr.reviewDecision,
		author: pr.author?.login,
		baseRefName: pr.baseRefName,
		headCommittedAt: last?.committedDate ?? last?.authoredDate,
		reviews: (pr.reviews ?? []).map((r) => ({ state: r.state, submittedAt: r.submittedAt, author: r.author?.login })),
		comments: (pr.comments ?? []).map((c) => ({ createdAt: c.createdAt, author: c.author?.login, body: c.body })),
		bugbotOpen,
		reachedDone,
	};
}

async function main() {
	const dir = stateDir();
	if (process.argv[2] === 'commit') return console.log(`frontier: ${commitPending(dir) ? 'committed' : 'nothing pending'}`);
	if (process.argv[2] === 'discard') return discardPending(dir);
	if (process.argv[2] !== 'check') {
		console.error('usage: frontier.mjs check|commit|discard');
		process.exit(3);
	}
	discardPending(dir);
	const cfg = load();
	const missing = missingCredentials(cfg);
	if (missing) {
		console.log(`frontier: ${missing}, cannot preflight`);
		process.exit(UNKNOWN);
	}
	let state = null;
	try {
		state = JSON.parse(fs.readFileSync(committedFile(dir), 'utf8'));
	} catch {
		/* first pass */
	}
	const source = makeSource(cfg);
	const d = await decide({ cfg, deps: { list: (f) => source.list(f), prState: (k, o) => prStateFor(k, undefined, o) }, state });
	if (d.run && d.fingerprint) savePending(dir, d.fingerprint);
	console.log(`frontier: ${d.run ? 'run' : 'skip'}: ${d.reason}`);
	process.exit(d.run ? 0 : SKIP);
}

if (isMain(import.meta.url)) main().catch((e) => (console.error(`frontier: ${e.message}`), process.exit(1)));
