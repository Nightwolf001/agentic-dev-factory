// The tick's tools for stacked PRs (see stack-lib.mjs for the rules).
//
//   stack.mjs plan --file TICKET --blockers KEY:state,KEY:state    print {action, base, pr, depth} or {action:'wait', reason}
//   stack.mjs note --pr N --branch B                               print the line a stacked PR's body carries
//   stack.mjs sync --worktree DIR --ref origin/BRANCH              merge the ref into the checked-out branch; exit 4 on a conflict (aborted)
//   stack.mjs retarget --pr N --worktree DIR --to BRANCH           point the PR at BRANCH (gh pr edit --base), then sync with origin/BRANCH
//
// plan is read-only. state is the blocker's logical task state (ready, inProgress, inReview, reviewed, done). The
// tick calls it only when tasks.unblockOnPr is on; the result is a decision, never a block: 'wait' leaves the task in ready.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { load } from './config.mjs';
import { prStateFor } from './frontier.mjs';
import { isMain } from './is-main.mjs';
import { planStack, stackNote, stackSettings, syncBranch } from './stack-lib.mjs';
import { validName } from './worktree.mjs';

export const CONFLICT = 4;

function args(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
		else out._.push(argv[i]);
	}
	return out;
}

const gh = (a) => execFileSync('gh', a, { encoding: 'utf8' });

export function livePlan({ cfg, text, blockers, run = gh }) {
	const { enabled, maxDepth } = stackSettings(cfg);
	const rows = blockers.map(({ key, state }) => {
		const done = state === 'done';
		if (done || !['inReview', 'reviewed'].includes(state)) return { key, done, taskState: state, pr: null };
		const pr = prStateFor(key, run);
		let files = [];
		if (pr?.state === 'OPEN')
			files = run(['pr', 'diff', String(pr.number), '--name-only'])
				.split('\n')
				.filter(Boolean);
		return { key, done, taskState: state, pr, files };
	});
	return planStack({ blockers: rows, text, enabled, maxDepth });
}

function main() {
	const a = args(process.argv.slice(2));
	const cmd = a._[0];
	if (cmd === 'plan' && a.file && typeof a.blockers === 'string') {
		const blockers = a.blockers
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
			.map((s) => {
				const [key, state] = s.split(':');
				return { key, state };
			});
		console.log(JSON.stringify(livePlan({ cfg: load(), text: fs.readFileSync(a.file, 'utf8'), blockers })));
	} else if (cmd === 'note' && a.pr && validName(a.branch)) {
		console.log(stackNote({ number: Number(a.pr), branch: a.branch }));
	} else if ((cmd === 'sync' && a.worktree && a.ref) || (cmd === 'retarget' && a.pr && a.worktree && a.to)) {
		const ref = cmd === 'sync' ? a.ref : `origin/${a.to}`;
		if (!validName(ref.replace(/^origin\//, ''))) throw new Error(`'${ref}' is not a usable ref`);
		if (cmd === 'retarget') gh(['pr', 'edit', String(a.pr), '--base', a.to]);
		const r = syncBranch({ repo: a.worktree, ref });
		console.log(JSON.stringify(r));
		if (r.status === 'conflict') process.exit(CONFLICT);
	} else {
		throw new Error('usage: stack.mjs plan|note|sync|retarget (see the header of this file)');
	}
}

if (isMain(import.meta.url)) {
	try {
		main();
	} catch (e) {
		console.error(`stack: ${e.message}`);
		process.exit(1);
	}
}
