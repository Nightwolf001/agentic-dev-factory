// Cheap preflight for a scheduled pass. It asks the configured task source, from a script and without a model,
// whether a paid `claude -p` session has anything to do: a claimable task, an orphaned in-progress task, or an
// in-review task whose PR was approved, merged or has fresh requested changes, a fix comment or open Bugbot threads. When not, tick.sh logs one line and
// exits without spawning.
//
//   frontier.mjs check     exit 0 = run the session; 20 = nothing to do; anything else = could not tell, no session
//                          (it also looks for a person's answer to a question the factory asked, and for a fix request written on a ticket)
//   frontier.mjs commit    remember the frontier the session just looked at (tick.sh, after a clean session only)
//
// A source that needs a token the machine lacks (Jira, Notion) exits 21 (unknown); tick.sh then starts nothing
// unless DF_PREFLIGHT=off. The local and github sources need no token.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { findFixRequest, findReplies, isFixLine } from './comment-lib.mjs';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';
import { isStacked, planStack, parseStackNote, stackAction, stackSettings } from './stack-lib.mjs';
import { fingerprintOf, isBuildable, makeSource, missingCredentials } from './sources/index.mjs';
import { loadTrackerEnv } from './state-env.mjs';

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
		questionLabel: g('tasks.questionLabel') ?? null,
		ignoreAuthors: g('tasks.ignoreCommentAuthors') ?? [],
		bugbot: g('review.bugbot') === true,
		bugbotAuthor: g('review.bugbotAuthor'),
		...stackSettings(cfg),
	};
}

// A comment asks for a fix pass when a line starts with the fix phrase, with or without the leading slash
// ("dev-factory fix", "/dev-factory fix rename the helper"). One matcher, shared with the session's reading of the ticket.
export const isFixComment = isFixLine;

// What a task in review needs from the factory. pr: { state, reviewDecision, author, baseRefName, headCommittedAt,
// reviews: [{state, submittedAt, author}], comments: [{createdAt, author, body}], bugbotOpen, reachedDone }.
// Returns 'done' (merged into pr.doneOnMergeInto, or into something that has since reached it), 'advance' (merged
// into pr.reviewedOnMergeInto, or, when that is unset, merged or approved), 'fix' (a change request from someone
// other than the PR author after the latest commit, a comment with the fix phrase after it, or open Bugbot threads)
// or null. A PR stacked on a blocker's PR also answers 'retarget' (the blocker merged), 'restack' (the blocker has new
// commits) or 'abandoned' (the blocker was closed unmerged), all before a fix. A stacked PR merged into its blocker's
// branch is neither reviewed nor done: only a later merge that reached pr.doneOnMergeInto counts. Any other comment is never a fix request: the text goes into a builder prompt, and a bot, CI, a question
// or an LGTM would all start a paid pass.
export function prNeedsAction(pr, { reviewedOn = null, doneOn = null, fixComment = null, bugbot = false } = {}) {
	if (!pr) return null;
	const stackStep = stackAction(pr);
	if (stackStep) return stackStep;
	if (pr.state === 'MERGED' && isStacked(pr)) return doneOn && pr.reachedDone ? 'done' : null;
	if (pr.state === 'MERGED') {
		if (doneOn && (pr.baseRefName === doneOn || pr.reachedDone)) return 'done';
		if (!reviewedOn || pr.baseRefName === reviewedOn) return 'advance';
		return null;
	}
	if (!reviewedOn && pr.reviewDecision === 'APPROVED') return 'advance';
	const after = (at) => Date.parse(at) > Date.parse(pr.headCommittedAt);
	// each reviewer's latest decision stands: a change request the same person later approved, or that was dismissed, is over
	const latest = new Map();
	for (const r of pr.reviews ?? []) {
		if (r.author === pr.author || !['CHANGES_REQUESTED', 'APPROVED', 'DISMISSED'].includes(r.state)) continue;
		const prev = latest.get(r.author);
		if (!prev || Date.parse(r.submittedAt) >= Date.parse(prev.submittedAt)) latest.set(r.author, r);
	}
	const requested = [...latest.values()].some((r) => r.state === 'CHANGES_REQUESTED' && after(r.submittedAt));
	const asked = (pr.comments ?? []).some((c) => !/\[bot\]$/.test(c.author ?? '') && after(c.createdAt) && isFixComment(c.body, fixComment));
	return requested || asked || (bugbot && pr.bugbotOpen > 0) ? 'fix' : null;
}

const ACTION_TEXT = {
	fix: 'has review feedback',
	retarget: 'is stacked on a PR that merged: retarget it',
	restack: 'is stacked on a PR that has new commits',
	abandoned: 'is stacked on a PR that was closed unmerged',
};

// Whether a ready task whose blockers are not all done can be built on a blocker's open PR (tasks.unblockOnPr). The
// preflight skips the scope check, which needs the ticket text: the session applies it and may still leave the task.
async function stackable(t, deps, opts, reviewing) {
	const blockers = [];
	for (const b of t.blockedBy ?? []) {
		const taskState = b.done ? 'done' : reviewing.get(b.key) ?? 'other';
		blockers.push({
			key: b.key,
			done: b.done,
			taskState,
			pr: b.done || !['inReview', 'reviewed'].includes(taskState) ? null : await deps.prState(b.key, opts),
		});
	}
	return planStack({ blockers, enabled: opts.enabled, maxDepth: opts.maxDepth, checkScope: false }).action === 'stack';
}

// Answers to the factory's questions, fix requests written on the ticket, and the ready queue are one decision: the pass looks at
// them together and remembers the fingerprint of all three, so a pass that ended without acting on them (a fix pass that posted no
// marker, an answer that needed a person's second look) is not started again for the same thing within caps.frontierRepeatHours.
// With no answers and no fix requests the fingerprint is the ready queue's alone, which is what older versions stored, so a
// fingerprint written before this existed is still read.
export function decisionFingerprint({ queue, answers = [], fixes = [] }) {
	if (!answers.length && !fixes.length) return queue;
	const rows = [`q|${queue}`, ...answers.map((a) => `a|${a.key}|${a.ids.join(',')}`), ...fixes.map((f) => `f|${f.key}|${f.id}`)].sort();
	return `v2:${createHash('sha1').update(rows.join('\n')).digest('hex')}`;
}

// deps: { list({states, staleMinutes, label}) -> tasks[], prState(key) -> pr data for prNeedsAction, comments?(key) -> [{id, body}] }
// state: { fingerprint, at } | null
export async function decide({ cfg, deps, state, now = Date.now() }) {
	const repeatMs = get('caps.frontierRepeatHours', { config: cfg }) * 3600_000;
	const stall = get('caps.stallMinutes', { config: cfg });
	const opts = actionOptions(cfg);
	const readComments = async (key) => {
		try {
			return deps.comments ? await deps.comments(key) : [];
		} catch {
			return []; // comments that cannot be read are no evidence of anything: the pass does not start on a guess
		}
	};
	const strays = await deps.list({ states: ['inProgress'], staleMinutes: stall });
	if (strays.length) return { run: true, reason: `${strays.length} orphaned in-progress task(s)` };
	const fixes = [];
	for (const t of await deps.list({ states: ['inReview'] })) {
		const pr = await deps.prState(t.key, opts);
		const action = prNeedsAction(pr, opts);
		if (action) return { run: true, reason: `${t.key} PR ${ACTION_TEXT[action] ?? 'is merged or approved'}` };
		// a fix request written on the ticket itself, while its PR is open and until the factory has answered it
		const ask = pr?.state === 'OPEN' ? findFixRequest(await readComments(t.key), { fixComment: opts.fixComment, prOpen: true }) : null;
		if (ask) fixes.push({ key: t.key, id: String(ask.id ?? ask.created ?? ask.body) });
	}
	// reviewed is the people's stage unless a merge into a later branch is what finishes a task
	if (opts.doneOn) {
		for (const t of await deps.list({ states: ['reviewed'] })) {
			if (prNeedsAction(await deps.prState(t.key, opts), opts) === 'done') return { run: true, reason: `${t.key} reached ${opts.doneOn}` };
		}
	}
	// a person answered a question the factory asked
	const answers = [];
	if (opts.questionLabel && deps.comments) {
		for (const t of await deps.list({ label: opts.questionLabel, notStates: ['done'] })) {
			const { replies } = findReplies(await readComments(t.key), { ignoreAuthors: opts.ignoreAuthors });
			if (replies.length) answers.push({ key: t.key, ids: replies.map((r) => String(r.id ?? r.created ?? r.body)) });
		}
	}
	const ready = await deps.list({ states: ['ready'] });
	const reviewing = new Map();
	if (opts.enabled && ready.some((t) => !isBuildable(t)))
		for (const state of ['inReview', 'reviewed']) for (const t of await deps.list({ states: [state] })) reviewing.set(t.key, state);
	const frontier = [];
	for (const t of ready) if (isBuildable(t) || (opts.enabled && (await stackable(t, deps, opts, reviewing)))) frontier.push(t);
	if (!frontier.length && !answers.length && !fixes.length) return { run: false, reason: 'frontier empty' };
	const fp = decisionFingerprint({ queue: fingerprintOf(frontier), answers, fixes });
	const parts = [
		answers.length && `${answers.length} answered question(s) (${answers.map((a) => a.key).join(', ')})`,
		fixes.length && `${fixes.length} fix request(s) on the ticket (${fixes.map((f) => f.key).join(', ')})`,
		frontier.length && `${frontier.length} claimable task(s)`,
	].filter(Boolean);
	if (state?.fingerprint === fp && now - Date.parse(state.at) < repeatMs) {
		return {
			run: false,
			reason: `nothing new since the last session looked (${parts.join('; ')}; ${[...frontier.map((t) => t.key), ...answers.map((a) => a.key), ...fixes.map((f) => f.key)].join(', ')})`,
		};
	}
	return { run: true, reason: parts.join('; '), fingerprint: fp };
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

const cmp = (run, base, head) => run(['api', `repos/{owner}/{repo}/compare/${base}...${head}`, '--jq', '.status']).trim();

// The PR this one is stacked on (from its note) and the branches below it. containsHead and containsMerge come from
// GitHub's compare: the dependent contains a commit when it is ahead of it or level with it.
function readStack(pr, run) {
	const chain = pr.headRefName ? [pr.headRefName] : [];
	const note = parseStackNote(pr.body);
	if (!note) return { stack: undefined, chain };
	const view = (n) => JSON.parse(run(['pr', 'view', String(n), '--json', 'number,state,headRefName,headRefOid,baseRefName,mergeCommit,body']));
	const parent = view(note.number);
	const contains = (oid) => !!oid && ['ahead', 'identical'].includes(cmp(run, oid, pr.headRefOid));
	const stack = {
		number: note.number,
		branch: note.branch,
		state: parent.state,
		baseRefName: parent.baseRefName,
		containsHead: parent.state === 'OPEN' ? contains(parent.headRefOid) : true,
		containsMerge: parent.state === 'MERGED' ? contains(parent.mergeCommit?.oid) : false,
	};
	for (let p = parent, i = 0; p && p.state === 'OPEN' && i < 10; i++) {
		chain.push(p.headRefName);
		const up = parseStackNote(p.body);
		p = up ? view(up.number) : null;
	}
	return { stack, chain };
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
	// every factory PR title ends in [KEY]: the search is loose (KEY-1 also finds KEY-12), so the title is checked, and an open PR is
	// preferred when a task has had more than one
	const found = JSON.parse(run(['pr', 'list', '--state', 'all', '--search', `${key} in:title`, '--json', 'number,title,state', '--limit', '20']));
	const own = found.filter((p) =>
		String(p.title ?? '')
			.trimEnd()
			.endsWith(`[${key}]`),
	);
	const list = [...own.filter((p) => p.state === 'OPEN'), ...own.filter((p) => p.state !== 'OPEN')];
	if (!list.length) return null;
	const number = String(list[0].number);
	const pr = JSON.parse(
		run([
			'pr',
			'view',
			number,
			'--json',
			'number,state,reviewDecision,author,commits,reviews,comments,baseRefName,headRefName,headRefOid,isCrossRepository,mergeCommit,body',
		]),
	);
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
	const { stack, chain } = readStack(pr, run);
	return {
		number: pr.number ?? Number(number),
		headRefName: pr.headRefName,
		onOrigin: pr.state === 'OPEN' && pr.isCrossRepository !== true,
		stack,
		chain,
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
	// a scheduled pass has loaded .env.local already; a check run by hand has not
	loadTrackerEnv();
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
	const d = await decide({
		cfg,
		deps: {
			list: (f) => source.list(f),
			prState: (k, o) => prStateFor(k, undefined, o),
			comments: typeof source.comments === 'function' ? (k) => source.comments(k) : undefined,
		},
		state,
	});
	if (d.run && d.fingerprint) savePending(dir, d.fingerprint);
	console.log(`frontier: ${d.run ? 'run' : 'skip'}: ${d.reason}`);
	process.exit(d.run ? 0 : SKIP);
}

if (isMain(import.meta.url)) main().catch((e) => (console.error(`frontier: ${e.message}`), process.exit(1)));
