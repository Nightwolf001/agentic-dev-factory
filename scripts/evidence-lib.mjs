// What a finished QA run leaves that a person should see on the ticket, and what is safe to attach to it. Pure where it can be,
// so it is unit-tested; scripts/evidence.mjs is the command and scripts/jira-mcp.mjs does the upload.
//
// The files come from the run's manifest (bin/qa.mjs wrote it and hashed every file), never from listing the folder: a file that
// is not in the manifest, that changed since, or that is a link to somewhere else is not attached. A file over
// evidence.maxAttachmentMb (9 MB by default, under Jira's 10 MB limit) is left out and named, not silently dropped.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { redactText } from './scrub-lib.mjs';

export const DEFAULT_MAX_MB = 9;

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);

export const runDir = (root, key, run) => path.join(root, '.dev-factory', 'evidence', key, `run-${run}`);

// -> { attach: [{ name, file, bytes, type, case }], skipped: [{ name, bytes, why }], problems: [] }
export function listEvidence({ root, run, maxMb = DEFAULT_MAX_MB }) {
	const manifestFile = path.join(root, '.dev-factory', 'qa', `run-${run}.json`);
	if (!fs.existsSync(manifestFile)) throw new Error(`no QA run ${run} in ${root}`);
	const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
	if (!m.verdict) throw new Error(`run ${run} is not finished: nothing to attach yet`);
	const dir = runDir(root, m.key, run);
	const realDir = fs.existsSync(dir) ? fs.realpathSync(dir) : null;
	const out = { key: m.key, run, verdict: m.verdict, attach: [], skipped: [], problems: [] };
	const names = new Set();
	for (const e of m.evidence ?? []) {
		const name = path.basename(e.file);
		const abs = path.join(root, e.file);
		let real;
		try {
			real = fs.realpathSync(abs);
		} catch {
			out.problems.push(`${name} is missing`);
			continue;
		}
		if (!realDir || !within(real, realDir)) {
			out.problems.push(`${name} resolves outside the run folder and is not attached`);
			continue;
		}
		if (e.sha256 && sha256(real) !== e.sha256) {
			out.problems.push(`${name} changed since it was recorded and is not attached`);
			continue;
		}
		if (names.has(name)) continue; // Jira would show two files of one name; the first stands
		names.add(name);
		const bytes = fs.statSync(real).size;
		if (bytes > maxMb * 1024 * 1024) {
			out.skipped.push({ name, bytes, why: `over ${maxMb} MB` });
			continue;
		}
		out.attach.push({ name, file: real, bytes, type: e.type ?? 'image', case: e.case });
	}
	return out;
}

const lines = (t) => String(t ?? '').split('\n');

// The changed files and the first hunks of the biggest ones, redacted. Not the whole diff: a person wants to see what the change is,
// the PR has the rest.
export function diffDigest({ root, base, head = 'HEAD', hunkFiles = 3, hunkLines = 30, secrets = [], patterns = [] }) {
	const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 128 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
	let stat = '';
	let patch = '';
	try {
		stat = git('diff', '--stat', '--no-color', `${base}...${head}`);
		patch = git('diff', '-U2', '--no-color', '--no-ext-diff', `${base}...${head}`);
	} catch {
		return { stat: '', hunks: '', note: `the diff against ${base} could not be read` };
	}
	const files = patch.split(/^diff --git /m).filter(Boolean);
	const biggest = files
		.map((f) => ({ f, n: lines(f).length }))
		.sort((a, b) => b.n - a.n)
		.slice(0, hunkFiles);
	const hunks = biggest.map(({ f }) => {
		const ls = lines(f);
		const header = ls[0].replace(/^a\/(\S+) b\/.*/, '$1');
		const body = ls.slice(ls.findIndex((l) => l.startsWith('@@'))).slice(0, hunkLines);
		return `--- ${header}\n${body.join('\n')}`;
	});
	const red = (t) => redactText(t, { secrets, extraPatterns: patterns }).text;
	return { stat: red(stat).trim(), hunks: red(hunks.join('\n\n')).trim(), note: null };
}

// The text of the summary a person reads on the ticket: the verdict, what each case showed, the diff, and short excerpts of the text
// evidence (probe answers, worker output, log tails; they were redacted when they were kept, and are again here).
export function summaryText({ root, run, listing, digest, secrets = [], patterns = [], excerptChars = 400 }) {
	const m = JSON.parse(fs.readFileSync(path.join(root, '.dev-factory', 'qa', `run-${run}.json`), 'utf8'));
	const out = [`QA run ${run} for ${m.key}: ${m.verdict}`, `head ${m.head}`];
	if (m.caseSummary)
		out.push(
			Object.entries(m.caseSummary)
				.map(([k, v]) => `${k}: ${v.passed}/${v.total} passed`)
				.join(', '),
		);
	out.push('', 'Cases');
	for (const c of m.cases ?? []) out.push(`- ${c.slug} (${c.kind ?? 'ui'}): ${c.status}${c.assertion ? ` - ${c.assertion}` : ''}`);
	if (digest?.stat) out.push('', 'Change', digest.stat);
	if (digest?.hunks) out.push('', 'Key hunks', digest.hunks);
	if (digest?.note) out.push('', digest.note);
	const texts = listing.attach.filter((a) => ['probe', 'worker', 'log'].includes(a.type));
	if (texts.length) {
		out.push('', 'Excerpts');
		for (const t of texts)
			out.push(
				`${t.name}:`,
				redactText(fs.readFileSync(t.file, 'utf8').slice(0, excerptChars), { secrets, extraPatterns: patterns }).text.trimEnd(),
				'',
			);
	}
	if (listing.skipped.length)
		out.push('', 'Left out (too large to attach)', ...listing.skipped.map((s) => `- ${s.name} (${(s.bytes / 1048576).toFixed(1)} MB, ${s.why})`));
	if (listing.problems.length) out.push('', 'Not attached', ...listing.problems.map((p) => `- ${p}`));
	return redactText(out.join('\n'), { secrets, extraPatterns: patterns }).text.trimEnd() + '\n';
}
