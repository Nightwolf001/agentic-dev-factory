// Prepares a finished QA run's evidence for the task tracker, for trackers that take file attachments (Jira).
//
//   evidence.mjs plan --worktree DIR --run N [--base REF] [--max-mb N]
//        prints { key, run, verdict, attach: [{name, bytes, type, case}], skipped, problems, summary } and writes the summary a
//        person reads (the verdict, each case, the diff and key hunks, short excerpts, what was left out) to
//        .dev-factory/evidence/<KEY>/run-N/summary.md, which is attached like any other file
//
// The upload itself is the tracker server's: for Jira, uploadAttachmentToJiraIssue in scripts/jira-mcp.mjs, one call per file name.
import fs from 'node:fs';
import path from 'node:path';
import { baseFor, repoRoot } from '../bin/qa.mjs';
import { get, load } from './config.mjs';
import { DEFAULT_MAX_MB, diffDigest, listEvidence, runDir, summaryText } from './evidence-lib.mjs';
import { isMain } from './is-main.mjs';

export function plan({ root, run, base, maxMb, cfg = load(), env = process.env }) {
	const limit = maxMb ?? get('evidence.maxAttachmentMb', { config: cfg }) ?? DEFAULT_MAX_MB;
	const patterns = cfg.telemetry?.scrubPatterns ?? [];
	// the account's password, when env.json names the variable: removed wherever it appears, whatever it looks like
	let secrets = [];
	try {
		const names = JSON.parse(fs.readFileSync(path.join(root, '.dev-factory', 'env.json'), 'utf8')).secretEnv;
		secrets = (Array.isArray(names) ? names : []).map((n) => env[n]).filter(Boolean);
	} catch {
		/* no environment record */
	}
	const listing = listEvidence({ root, run, maxMb: limit });
	const digest = diffDigest({ root, base, secrets, patterns });
	const text = summaryText({ root, run, listing, digest, secrets, patterns });
	const file = path.join(runDir(root, listing.key, run), 'summary.md');
	fs.writeFileSync(file, text);
	return {
		...listing,
		attach: [
			...listing.attach.map(({ file: _f, ...a }) => a),
			{ name: 'summary.md', bytes: Buffer.byteLength(text), type: 'summary', case: null },
		],
		summary: path.relative(root, file),
	};
}

if (isMain(import.meta.url)) {
	const argv = process.argv.slice(2);
	const val = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
	try {
		if (argv[0] !== 'plan') throw new Error('usage: evidence.mjs plan --worktree DIR --run N [--base REF] [--max-mb N]');
		const root = repoRoot(path.resolve(val('worktree') ?? process.cwd()));
		console.log(
			JSON.stringify(
				plan({ root, run: Number(val('run')), base: val('base') ?? baseFor(root), maxMb: val('max-mb') ? Number(val('max-mb')) : undefined }),
				null,
				2,
			),
		);
	} catch (e) {
		console.error(`evidence: ${e.message}`);
		process.exit(1);
	}
}
