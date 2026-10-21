// Cheap preflight for a scheduled pass. With a Jira API token it answers over REST, in Node, whether a
// paid `claude -p` session has anything to do: a claimable ticket, an orphaned In Progress ticket, or an
// Peer review ticket whose PR was approved, merged or has fresh requested changes. When not, tick.sh logs one line and exits without spawning.
//
//   frontier.mjs check     exit 0 = run the session; 20 = nothing to do; anything else = could not tell, no session
//   frontier.mjs commit    remember the frontier the session just looked at (tick.sh, after a clean session only)
//
// Without JIRA_API_TOKEN and JIRA_EMAIL it exits 21 (unknown); tick.sh then starts nothing unless DF_PREFLIGHT=off.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';

export const SKIP = 20;
export const UNKNOWN = 21;

export function queries(cfg) {
	const q = (k) => get(k, { config: cfg });
	// quoted: MAX is a reserved JQL word and an unquoted key makes Jira reject the whole query
	const projects = q('jira.projects')
		.map((p) => `"${p}"`)
		.join(', ');
	const label = q('jira.label');
	const stall = q('caps.stallMinutes');
	const base = `project in (${projects}) AND assignee = currentUser() AND labels = "${label}"`;
	return {
		frontier: `${base} AND sprint in openSprints() AND status in ("${q('jira.statuses.readyForDev')}", "${q('jira.statuses.todo')}") AND labels != "${q('jira.blockedLabel')}" ORDER BY Rank ASC`,
		strays: `${base} AND status = "${q('jira.statuses.inProgress')}" AND updated <= -${stall}m`,
		peerReview: `${base} AND status = "${q('jira.statuses.peerReview')}"`,
	};
}

// An issue is buildable unless an "is blocked by" link points at an issue that is not done. Done means
// a name in jira.doneStatuses (UAT counts, although Jira files it under In Progress) or Jira's own done category.
export function isBuildable(issue, doneStatuses = []) {
	const done = (st) => doneStatuses.includes(st?.name) || st?.statusCategory?.key === 'done';
	return !(issue.fields?.issuelinks ?? []).some((l) => l.type?.inward === 'is blocked by' && l.inwardIssue && !done(l.inwardIssue.fields?.status));
}

// What a Peer review ticket's PR needs from the factory. pr: { state, reviewDecision, author, headCommittedAt,
// reviews: [{state, submittedAt, author}] }. Returns 'advance' (merged or approved), 'fix' (a change request from
// someone other than the PR author, after the latest commit) or null. A comment is never a fix request: the text
// goes into a builder prompt, and Bugbot, CI, a question or an LGTM would all start a paid pass.
export function prNeedsAction(pr) {
	if (!pr) return null;
	if (pr.state === 'MERGED' || pr.reviewDecision === 'APPROVED') return 'advance';
	const requested = (pr.reviews ?? []).some(
		(r) => r.state === 'CHANGES_REQUESTED' && r.author !== pr.author && Date.parse(r.submittedAt) > Date.parse(pr.headCommittedAt),
	);
	return requested ? 'fix' : null;
}

export function fingerprintOf(issues) {
	const rows = issues.map((i) => `${i.key}|${i.fields?.status?.name}|${i.fields?.updated}`).sort();
	return createHash('sha1').update(rows.join('\n')).digest('hex');
}

// deps: { search(jql) -> issues[], prState(key) -> pr data for prNeedsAction }, state: { fingerprint, at } | null
export async function decide({ cfg, deps, state, now = Date.now() }) {
	const qs = queries(cfg);
	const repeatMs = get('caps.frontierRepeatHours', { config: cfg }) * 3600_000;
	const strays = await deps.search(qs.strays);
	if (strays.length) return { run: true, reason: `${strays.length} orphaned In Progress ticket(s)` };
	for (const i of await deps.search(qs.peerReview)) {
		const action = prNeedsAction(await deps.prState(i.key));
		if (action) return { run: true, reason: `${i.key} PR ${action === 'advance' ? 'approved or merged' : 'has review feedback'}` };
	}
	const doneStatuses = get('jira.doneStatuses', { config: cfg });
	const frontier = (await deps.search(qs.frontier)).filter((i) => isBuildable(i, doneStatuses));
	if (!frontier.length) return { run: false, reason: 'frontier empty' };
	const fp = fingerprintOf(frontier);
	if (state?.fingerprint === fp && now - Date.parse(state.at) < repeatMs) {
		return { run: false, reason: `frontier unchanged since the last session looked at it (${frontier.map((i) => i.key).join(', ')})` };
	}
	return { run: true, reason: `${frontier.length} claimable ticket(s)`, fingerprint: fp };
}

export const stateDir = (env = process.env) => env.DF_STATE_DIR || path.join(os.homedir(), '.dev-factory');
const pendingFile = (dir) => path.join(dir, 'frontier.pending.json');
const committedFile = (dir) => path.join(dir, 'frontier.json');

// The fingerprint of a frontier a session is about to look at is only remembered once that session ended cleanly,
// so a crash or a budget stop never hides claimable tickets from the next pass.
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

function restDeps(cfg, env = process.env) {
	const site = get('jira.site', { config: cfg });
	const auth = 'Basic ' + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
	return {
		async search(jql) {
			const url = `https://${site}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=status,updated,issuelinks&maxResults=50`;
			const r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
			if (!r.ok) throw new Error(`jira search ${r.status}`);
			return (await r.json()).issues ?? [];
		},
		async prState(key) {
			const list = JSON.parse(
				execFileSync('gh', ['pr', 'list', '--state', 'all', '--search', `${key} in:title`, '--json', 'number', '--limit', '1'], {
					encoding: 'utf8',
				}),
			);
			if (!list.length) return null;
			const pr = JSON.parse(
				execFileSync('gh', ['pr', 'view', String(list[0].number), '--json', 'state,reviewDecision,author,commits,reviews'], {
					encoding: 'utf8',
				}),
			);
			const last = pr.commits?.[pr.commits.length - 1];
			return {
				state: pr.state,
				reviewDecision: pr.reviewDecision,
				author: pr.author?.login,
				headCommittedAt: last?.committedDate ?? last?.authoredDate,
				reviews: (pr.reviews ?? []).map((r) => ({ state: r.state, submittedAt: r.submittedAt, author: r.author?.login })),
			};
		},
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
	if (!process.env.JIRA_API_TOKEN || !process.env.JIRA_EMAIL) {
		console.log('frontier: no Jira API token, cannot preflight');
		process.exit(UNKNOWN);
	}
	const cfg = load();
	const file = committedFile(dir);
	let state = null;
	try {
		state = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		/* first pass */
	}
	const d = await decide({ cfg, deps: restDeps(cfg), state });
	if (d.run && d.fingerprint) {
		savePending(dir, d.fingerprint);
	}
	console.log(`frontier: ${d.run ? 'run' : 'skip'}: ${d.reason}`);
	process.exit(d.run ? 0 : SKIP);
}

if (isMain(import.meta.url)) main().catch((e) => (console.error(`frontier: ${e.message}`), process.exit(1)));
