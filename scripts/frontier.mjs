// Cheap preflight for a scheduled pass. It asks the configured task source, from a script and without a model,
// whether a paid `claude -p` session has anything to do: a claimable task, an orphaned in-progress task, or an
// in-review task whose PR was approved, merged or has fresh requested changes. When not, tick.sh logs one line and
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

// What a task in review needs from the factory. pr: { state, reviewDecision, author, headCommittedAt,
// reviews: [{state, submittedAt, author}] }. Returns 'advance' (merged or approved), 'fix' (a change request from
// someone other than the PR author, after the latest commit) or null. A comment is never a fix request: the text
// goes into a builder prompt, and a bot, CI, a question or an LGTM would all start a paid pass.
export function prNeedsAction(pr) {
	if (!pr) return null;
	if (pr.state === 'MERGED' || pr.reviewDecision === 'APPROVED') return 'advance';
	const requested = (pr.reviews ?? []).some(
		(r) => r.state === 'CHANGES_REQUESTED' && r.author !== pr.author && Date.parse(r.submittedAt) > Date.parse(pr.headCommittedAt),
	);
	return requested ? 'fix' : null;
}

// deps: { list({states, staleMinutes}) -> tasks[], prState(key) -> pr data for prNeedsAction }, state: { fingerprint, at } | null
export async function decide({ cfg, deps, state, now = Date.now() }) {
	const repeatMs = get('caps.frontierRepeatHours', { config: cfg }) * 3600_000;
	const stall = get('caps.stallMinutes', { config: cfg });
	const strays = await deps.list({ states: ['inProgress'], staleMinutes: stall });
	if (strays.length) return { run: true, reason: `${strays.length} orphaned in-progress task(s)` };
	for (const t of await deps.list({ states: ['inReview'] })) {
		const action = prNeedsAction(await deps.prState(t.key));
		if (action) return { run: true, reason: `${t.key} PR ${action === 'advance' ? 'approved or merged' : 'has review feedback'}` };
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

// The PR a task produced, found by its key in the title (every factory PR title ends in [KEY]).
export function prStateFor(key, run = (args) => execFileSync('gh', args, { encoding: 'utf8' })) {
	const list = JSON.parse(run(['pr', 'list', '--state', 'all', '--search', `${key} in:title`, '--json', 'number', '--limit', '1']));
	if (!list.length) return null;
	const pr = JSON.parse(run(['pr', 'view', String(list[0].number), '--json', 'state,reviewDecision,author,commits,reviews']));
	const last = pr.commits?.[pr.commits.length - 1];
	return {
		state: pr.state,
		reviewDecision: pr.reviewDecision,
		author: pr.author?.login,
		headCommittedAt: last?.committedDate ?? last?.authoredDate,
		reviews: (pr.reviews ?? []).map((r) => ({ state: r.state, submittedAt: r.submittedAt, author: r.author?.login })),
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
	const d = await decide({ cfg, deps: { list: (f) => source.list(f), prState: (k) => prStateFor(k) }, state });
	if (d.run && d.fingerprint) savePending(dir, d.fingerprint);
	console.log(`frontier: ${d.run ? 'run' : 'skip'}: ${d.reason}`);
	process.exit(d.run ? 0 : SKIP);
}

if (isMain(import.meta.url)) main().catch((e) => (console.error(`frontier: ${e.message}`), process.exit(1)));
