#!/usr/bin/env node
// QA manifest CLI. Zero dependencies. The model walks a case through MCP; this tool is the only
// thing that turns that walk into a verdict, and it refuses anything that is not fresh evidence
// for this run at this commit.
//
//   qa.mjs start   --key KEY --profile web|mobile
//   qa.mjs record  --run N --case SLUG --status pass|fail --assertion TEXT [--screenshot FILE] [--step N]
//   qa.mjs done    --run N
//   qa.mjs mark-na --key KEY --profile web|mobile --reason TEXT
//   qa.mjs verify  --head SHA (--key KEY | --run N) [--require-review true]   --key finds the run made at that head, or the not-applicable record
//   qa.mjs show    --run N
//   qa.mjs review record --axis spec|standards --head SHA --summary TEXT --findings JSON   only as the reviewer run.json names for that axis
//   qa.mjs review status [--head SHA]
//   qa.mjs debug open --trigger triage|unstick|validate --command CMD [--output-file F]
//   qa.mjs debug run --id N -- CMD...      run one command under the debugger shell rules
//   qa.mjs debug record --id N --loop CMD --root-cause TEXT --evidence JSON --fix-plan TEXT [--validation-plan TEXT]
//   qa.mjs debug status | debug block --reason TEXT
//   qa.mjs ticket lint --file F [--strict true]   exit 1 and list what the issue description lacks
//   qa.mjs ticket base --file F                   {"base": "<branch>"} from a "Base branch:" line, or null
//   qa.mjs learnings check --key KEY [--body-file F]   require and validate .dev-factory/learnings.md (short, scoped; it goes into the PR body)
//   qa.mjs promote check               only the Learned rules section of AGENTS.md files may differ from the base
//   qa.mjs scrub --file F     fail when F holds emails, phone numbers, tokens or long identifiers
//
//   every command also accepts --worktree DIR; without it the cwd's run.json, then the scheduler's active-run pointer, then the git root decides which tree is read
//
// Exit codes: 0 ok, 1 refused or failed, 2 needs_own_case (no case authored for the ticket).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as debugLib from '../scripts/debug-lib.mjs';
import { isMain } from '../scripts/is-main.mjs';
import { learningRequired, lintLearnings, parseLearnings } from '../scripts/learnings-lib.mjs';
import { checkPromotion } from '../scripts/promote-lib.mjs';
import { lintTicket } from '../scripts/ticket-lib.mjs';
import { parseBase, validName } from '../scripts/worktree.mjs';
import { scrubFindings } from '../scripts/scrub-lib.mjs';
import { workRoot } from '../scripts/run-context.mjs';

export const MIN_ASSERTION_CHARS = 8;
export const MIN_IMAGE_BYTES = 1024;
export const MTIME_TOLERANCE_MS = 2000;
// The ref a run's diff is measured against: DF_BASE_REF, else the base branch recorded in run.json, else origin/develop.
export function baseFor(root) {
	if (process.env.DF_BASE_REF) return process.env.DF_BASE_REF;
	try {
		const base = JSON.parse(fs.readFileSync(path.join(root, '.dev-factory', 'run.json'), 'utf8')).base;
		if (validName(base)) return `origin/${base}`;
	} catch {
		/* no run.json: not a factory run */
	}
	return 'origin/develop';
}

export class QaError extends Error {
	constructor(message, code = 1) {
		super(message);
		this.code = code;
	}
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function repoRoot(cwd = process.cwd()) {
	return git(cwd, 'rev-parse', '--show-toplevel');
}

const stateDir = (root) => path.join(root, '.dev-factory', 'qa');
const manifestPath = (root, run) => path.join(stateDir(root), `run-${run}.json`);
const naPath = (root, key) => path.join(stateDir(root), `na-${key}.json`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
};

// Untracked and modified files count, except the factory's own run state.
export function dirtyFiles(root) {
	const out = git(root, 'status', '--porcelain', '--untracked-files=all');
	return out
		.split('\n')
		.filter(Boolean)
		.map((l) => l.slice(3))
		.filter((f) => !f.startsWith('.dev-factory/'));
}

function nextRun(root) {
	const dir = stateDir(root);
	if (!fs.existsSync(dir)) return 1;
	const nums = fs
		.readdirSync(dir)
		.map((f) => /^run-(\d+)\.json$/.exec(f))
		.filter(Boolean)
		.map((m) => Number(m[1]));
	return nums.length ? Math.max(...nums) + 1 : 1;
}

function loadRun(root, run) {
	const file = manifestPath(root, run);
	if (!fs.existsSync(file)) throw new QaError(`no run ${run}`);
	return readJson(file);
}

export function listCases(root, key) {
	const dir = path.join(root, 'dev-factory', 'qa', 'cases', key);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => /\.(ya?ml|spec\.ts)$/.test(f))
		.map((f) => f.replace(/\.(ya?ml|spec\.ts)$/, ''))
		.sort();
}

export function start({ root, key, profile }) {
	if (!key || !profile) throw new QaError('start needs --key and --profile');
	const dirty = dirtyFiles(root);
	if (dirty.length) throw new QaError(`working tree is not clean (commit first): ${dirty.slice(0, 5).join(', ')}`);
	const cases = listCases(root, key);
	if (!cases.length) throw new QaError(`needs_own_case: no case authored under dev-factory/qa/cases/${key}/`, 2);
	const run = nextRun(root);
	const envFile = path.join(root, '.dev-factory', 'env.json');
	const manifest = {
		run,
		key,
		profile,
		head: git(root, 'rev-parse', 'HEAD'),
		startedAt: new Date().toISOString(),
		env: fs.existsSync(envFile) ? readJson(envFile) : null,
		cases: cases.map((slug) => ({ slug, status: null })),
		evidence: [],
		verdict: null,
	};
	writeJson(manifestPath(root, run), manifest);
	return manifest;
}

const isImage = (buf) =>
	(buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
	(buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff);

// A recorded assertion must describe this walk, never lean on another one.
const CITES_OTHER_RUN = /#\d+|\brun\s*\d+|previous(ly)?|same commit|already passed|as before/i;

export function record({ root, run, caseSlug, status, assertion, screenshot, step = 1 }) {
	const m = loadRun(root, run);
	if (m.verdict) throw new QaError(`run ${run} is already finished (${m.verdict})`);
	const c = m.cases.find((x) => x.slug === caseSlug);
	if (!c) throw new QaError(`case ${caseSlug} is not part of run ${run}`);
	if (!['pass', 'fail'].includes(status)) throw new QaError('--status must be pass or fail');
	if (!assertion || assertion.trim().length < MIN_ASSERTION_CHARS)
		throw new QaError(`assertion needs at least ${MIN_ASSERTION_CHARS} characters describing what was observed`);
	if (CITES_OTHER_RUN.test(assertion))
		throw new QaError('assertion must describe this walk; it may not cite another run, a run number or an earlier pass');
	if (git(root, 'rev-parse', 'HEAD') !== m.head) throw new QaError('HEAD moved since the run started; start a new run');

	let evidence = null;
	if (screenshot) {
		if (!fs.existsSync(screenshot)) throw new QaError(`screenshot not found: ${screenshot}`);
		const st = fs.statSync(screenshot);
		const buf = fs.readFileSync(screenshot);
		if (st.size < MIN_IMAGE_BYTES) throw new QaError(`screenshot is ${st.size} bytes; at least ${MIN_IMAGE_BYTES} required`);
		if (!isImage(buf)) throw new QaError('screenshot is not a PNG or JPEG');
		if (st.mtimeMs < Date.parse(m.startedAt) - MTIME_TOLERANCE_MS) throw new QaError('screenshot predates this run; take a fresh one');
		const hash = sha256(screenshot);
		const dup = m.evidence.find((e) => e.sha256 === hash);
		if (dup) throw new QaError(`screenshot bytes already registered for case ${dup.case}; capture the state this case asserts`);
		const ext = buf[0] === 0x89 ? 'png' : 'jpg';
		const rel = path.join('.dev-factory', 'evidence', m.key, `run-${run}`, `${caseSlug}-${step}.${ext}`);
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.copyFileSync(screenshot, path.join(root, rel));
		evidence = { case: caseSlug, step, file: rel, sha256: hash, bytes: st.size };
		m.evidence.push(evidence);
	}
	if (status === 'pass' && !m.evidence.some((e) => e.case === caseSlug)) {
		throw new QaError('a pass needs at least one screenshot registered for this case in this run');
	}
	c.status = status;
	c.assertion = assertion.trim();
	c.recordedAt = new Date().toISOString();
	writeJson(manifestPath(root, run), m);
	return { case: c, evidence };
}

export function done({ root, run }) {
	const m = loadRun(root, run);
	if (m.verdict) return m;
	const missing = m.cases.filter((c) => !c.status).map((c) => c.slug);
	if (missing.length) throw new QaError(`cases not recorded: ${missing.join(', ')}`);
	if (git(root, 'rev-parse', 'HEAD') !== m.head) throw new QaError('HEAD moved since the run started; the run closes as stale, start a new one');
	const dirty = dirtyFiles(root);
	if (dirty.length) throw new QaError(`working tree changed during the walk: ${dirty.slice(0, 5).join(', ')}`);
	m.verdict = m.cases.every((c) => c.status === 'pass') ? 'pass' : 'fail';
	m.finishedAt = new Date().toISOString();
	writeJson(manifestPath(root, run), m);
	return m;
}

// Minimal reader for a glob list (uiGlobs, nonUiGlobs) in profiles.yaml (no YAML dependency).
function globListFor(profile, key) {
	const text = fs.readFileSync(fileURLToPath(new URL('../qa/profiles.yaml', import.meta.url)), 'utf8').split('\n');
	const globs = [];
	let inProfile = false;
	let inGlobs = false;
	for (const line of text) {
		if (/^\S.*:\s*$/.test(line)) {
			inProfile = line.trim() === `${profile}:`;
			inGlobs = false;
			continue;
		}
		if (!inProfile) continue;
		if (new RegExp(`^\\s+${key}:\\s*$`).test(line)) {
			inGlobs = true;
			continue;
		}
		if (inGlobs) {
			const mm = /^\s+-\s+"?([^"#]+?)"?\s*$/.exec(line);
			if (mm) globs.push(mm[1]);
			else if (/^\s+\S/.test(line)) inGlobs = false;
		}
	}
	return globs;
}

export const uiGlobsFor = (root, profile) => globListFor(profile, 'uiGlobs');
// Files under a UI folder that are still not UI surface (documentation), so a docs-only diff does not need a walk.
export const nonUiGlobsFor = (root, profile) => globListFor(profile, 'nonUiGlobs');

export function globToRegExp(glob) {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === '*') {
			if (glob[i + 1] === '*') {
				re += '.*';
				i++;
				if (glob[i + 1] === '/') i++;
			} else re += '[^/]*';
		} else re += ch.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
	}
	return new RegExp(`^${re}$`);
}

export function markNa({ root, key, profile, reason, base = baseFor(root) }) {
	if (!key || !profile || !reason) throw new QaError('mark-na needs --key, --profile and --reason');
	const globs = uiGlobsFor(root, profile).map(globToRegExp);
	if (!globs.length) throw new QaError(`profile ${profile} has no uiGlobs`);
	const files = git(root, 'diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
	const docs = nonUiGlobsFor(root, profile).map(globToRegExp);
	const ui = files.filter((f) => globs.some((g) => g.test(f)) && !docs.some((g) => g.test(f)));
	if (ui.length) throw new QaError(`diff touches UI surface, a walk is required: ${ui.slice(0, 5).join(', ')}`);
	const out = {
		key,
		profile,
		reason,
		head: git(root, 'rev-parse', 'HEAD'),
		files: files.length,
		at: new Date().toISOString(),
		verdict: 'not_applicable',
	};
	writeJson(naPath(root, key), out);
	return out;
}

// ---- Two-step review -------------------------------------------------------------------------
// Step 1 (spec): does the diff do what the ticket asks, nothing more? Step 2 (standards): is it
// built the way this repository requires? Step 2 can only be recorded once step 1 is clean at the
// same commit. Counts are derived from the findings, never reported separately.
export const AXES = ['spec', 'standards'];
// Extra steps that run after standards when the diff touches matching paths (config review.specialistAxes).
export const SPECIALIST_AXES = ['data', 'infra', 'security'];
const ALL_AXES = [...AXES, ...SPECIALIST_AXES];

export function triggeredAxes({ root, head, specialistAxes = {}, base = baseFor(root) }) {
	let files;
	try {
		files = git(root, 'diff', '--name-only', `${base}...${head ?? 'HEAD'}`)
			.split('\n')
			.filter(Boolean);
	} catch {
		return [];
	}
	return SPECIALIST_AXES.filter((axis) => (specialistAxes[axis] ?? []).map(globToRegExp).some((re) => files.some((f) => re.test(f))));
}
export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const reviewDir = (root) => path.join(root, '.dev-factory', 'review');
const reviewFile = (root, head, axis) => path.join(reviewDir(root), `${head}-${axis}.json`);

export function parseFindings(raw) {
	let list;
	try {
		list = typeof raw === 'string' ? JSON.parse(raw) : raw;
	} catch {
		throw new QaError('--findings must be a JSON array (use [] for none)');
	}
	if (!Array.isArray(list)) throw new QaError('--findings must be a JSON array (use [] for none)');
	list.forEach((f, i) => {
		if (!SEVERITIES.includes(f.severity)) throw new QaError(`finding ${i}: severity must be one of ${SEVERITIES.join(', ')}`);
		if (typeof f.file !== 'string' || !f.file) throw new QaError(`finding ${i}: file is required`);
		if (!Number.isInteger(f.line) || f.line < 1) throw new QaError(`finding ${i}: line must be a positive integer`);
		if (typeof f.note !== 'string' || f.note.trim().length < 10) throw new QaError(`finding ${i}: note needs at least 10 characters`);
	});
	return list;
}

const countBy = (findings) => Object.fromEntries(SEVERITIES.map((sv) => [sv.toLowerCase(), findings.filter((f) => f.severity === sv).length]));
const blocking = (c) => c.critical + c.high;

export function reviewRecord({ root, axis, head, summary, findings, by = null }) {
	if (!ALL_AXES.includes(axis)) throw new QaError(`--axis must be one of ${ALL_AXES.join(', ')}`);
	const full = git(root, 'rev-parse', 'HEAD');
	if (!head || !(full.startsWith(head) || head.startsWith(full)))
		throw new QaError(`review head ${head ?? '(none)'} is not the current HEAD ${full.slice(0, 9)}`);
	if (!summary || summary.trim().length < 20) throw new QaError('summary needs at least 20 characters describing what was checked');
	const dirty = dirtyFiles(root);
	if (dirty.length) throw new QaError(`working tree is not clean, review reads committed code: ${dirty.slice(0, 5).join(', ')}`);
	const list = parseFindings(findings);
	if (SPECIALIST_AXES.includes(axis)) {
		const std = reviewFile(root, full, 'standards');
		if (!fs.existsSync(std)) throw new QaError(`the standards step has not been recorded at this commit; run it before ${axis}`);
		if (blocking(readJson(std).counts) > 0)
			throw new QaError(`the standards step has open Critical or High findings at this commit; fix them before ${axis}`);
	}
	if (axis === 'standards') {
		const spec = reviewFile(root, full, 'spec');
		if (!fs.existsSync(spec)) throw new QaError('step 1 (spec) has not been recorded at this commit; run it first');
		const c = readJson(spec).counts;
		if (blocking(c) > 0) throw new QaError('step 1 (spec) has open Critical or High findings at this commit; fix them before step 2');
	}
	const heads = new Set(
		fs.existsSync(reviewDir(root))
			? fs
					.readdirSync(reviewDir(root))
					.filter((f) => f.endsWith('-spec.json'))
					.map((f) => f.split('-')[0])
			: [],
	);
	heads.add(full);
	const record = {
		axis,
		head: full,
		round: heads.size,
		by,
		summary: summary.trim(),
		counts: countBy(list),
		findings: list,
		at: new Date().toISOString(),
	};
	writeJson(reviewFile(root, full, axis), record);
	return record;
}

export function reviewStatus({ root, head, specialistAxes = {}, base = baseFor(root) }) {
	const full = head ?? git(root, 'rev-parse', 'HEAD');
	const triggered = triggeredAxes({ root, head: full, specialistAxes, base });
	const out = { head: full, rounds: 0, triggered, axes: {} };
	const dir = reviewDir(root);
	if (fs.existsSync(dir))
		out.rounds = new Set(
			fs
				.readdirSync(dir)
				.filter((f) => f.endsWith('-spec.json'))
				.map((f) => f.split('-')[0]),
		).size;
	const required = [...AXES, ...triggered];
	for (const axis of ALL_AXES) {
		if (!required.includes(axis) && !fs.existsSync(reviewFile(root, full, axis))) continue;
		const f = reviewFile(root, full, axis);
		if (!fs.existsSync(f)) {
			out.axes[axis] = null;
			continue;
		}
		const r = readJson(f);
		out.axes[axis] = { counts: r.counts, blocking: blocking(r.counts), by: r.by ?? null, at: r.at };
	}
	out.clean = required.every((a) => out.axes[a] && out.axes[a].blocking === 0);
	return out;
}

// The newest finished run of this ticket made at the given head, so a caller never has to know the run number.
export function runForKey(root, key, head) {
	const dir = stateDir(root);
	if (!fs.existsSync(dir)) return null;
	const runs = fs
		.readdirSync(dir)
		.map((f) => /^run-(\d+)\.json$/.exec(f))
		.filter(Boolean)
		.map((m) => ({ n: Number(m[1]), m: readJson(path.join(dir, m[0])) }))
		.filter(({ m }) => m.key === key && m.verdict && (m.head.startsWith(head) || head.startsWith(m.head)))
		.sort((a, b) => b.n - a.n);
	return runs.length ? runs[0].m : null;
}

export function verify({ root, head, run, key, requireReview = false, specialistAxes = {}, base = baseFor(root) }) {
	if (!head) throw new QaError('verify needs --head');
	if (run == null && !key) throw new QaError('verify needs --run or --key');
	const problems = [];
	let manifest;
	if (run != null) {
		manifest = loadRun(root, run);
	} else {
		manifest = runForKey(root, key, head);
		if (!manifest) {
			const na = naPath(root, key);
			if (!fs.existsSync(na)) throw new QaError(`no QA run at ${head.slice(0, 9)} and no not-applicable record for ${key}`);
			manifest = readJson(na);
		}
	}
	if (!manifest.head.startsWith(head) && !head.startsWith(manifest.head))
		problems.push(`manifest head ${manifest.head.slice(0, 9)} is not the PR head ${head.slice(0, 9)}`);
	if (manifest.verdict !== 'pass' && manifest.verdict !== 'not_applicable') problems.push(`verdict is ${manifest.verdict ?? 'open'}`);
	for (const e of manifest.evidence ?? []) {
		const f = path.join(root, e.file);
		if (!fs.existsSync(f)) problems.push(`evidence missing: ${e.file}`);
		else if (sha256(f) !== e.sha256) problems.push(`evidence changed since recorded: ${e.file}`);
	}
	if (requireReview) {
		const st = reviewStatus({ root, head: manifest.head, specialistAxes, base });
		for (const axis of [...AXES, ...st.triggered]) {
			if (!st.axes[axis]) problems.push(`review step ${axis} is not recorded at ${manifest.head.slice(0, 9)}`);
			else if (st.axes[axis].by !== 'reviewer') problems.push(`review step ${axis} was not recorded by a reviewer agent`);
			else if (st.axes[axis].blocking > 0) problems.push(`review step ${axis} has ${st.axes[axis].blocking} open Critical or High finding(s)`);
		}
	}
	if (problems.length) throw new QaError(`verify failed: ${problems.join('; ')}`);
	return { ok: true, verdict: manifest.verdict, head: manifest.head };
}

export function learningsCheck({ root, key, bodyFile }) {
	if (!key) throw new QaError('learnings check needs --key');
	const dir = path.join(root, '.dev-factory');
	const reviewDir = path.join(dir, 'review');
	const counts = fs.existsSync(reviewDir)
		? fs
				.readdirSync(reviewDir)
				.filter((f) => f.endsWith('.json'))
				.map((f) => readJson(path.join(reviewDir, f)).counts)
		: [];
	const required = learningRequired({ debugRounds: debugLib.listRecords(root).length, reviewCounts: counts });
	const file = path.join(dir, 'learnings.md');
	if (!fs.existsSync(file)) {
		if (required) throw new QaError(`learnings check failed: .dev-factory/learnings.md is required because ${required}`);
		return { ok: true, required: false };
	}
	const text = fs.readFileSync(file, 'utf8');
	const problems = lintLearnings(text);
	const leaks = scrubFindings(text);
	if (leaks.length) problems.push(`holds raw data (${leaks[0].rule}); keep ids and aggregates only`);
	if (bodyFile) {
		const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : '';
		const want = parseLearnings(text).map((e) => e.text);
		const have = parseLearnings(body).map((e) => e.text);
		if (!want.every((t) => have.includes(t)))
			problems.push('the PR body does not carry the "## Learnings" section from .dev-factory/learnings.md');
	}
	if (problems.length) throw new QaError(`learnings check failed: ${problems.join('; ')}`);
	return { ok: true, required: !!required };
}

export function promoteCheck({ root, base = baseFor(root), cap = 15 }) {
	const names = git(root, 'diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
	const files = names.map((p) => {
		let before = '';
		try {
			before = git(root, 'show', `${base}:${p}`);
		} catch {
			/* a new file */
		}
		return { path: p, before, after: fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p), 'utf8') : '' };
	});
	const problems = checkPromotion(files, { cap });
	if (problems.length) throw new QaError(`promote check failed: ${problems.join('; ')}`);
	return { ok: true, files: names.length };
}

export function scrubFile({ file, patterns = [] }) {
	if (!file) throw new QaError('scrub needs --file');
	if (!fs.existsSync(file)) throw new QaError(`no such file: ${file}`);
	const findings = scrubFindings(fs.readFileSync(file, 'utf8'), patterns);
	if (findings.length) {
		const list = findings.slice(0, 10).map((f) => `line ${f.line}: ${f.rule} (${f.sample})`);
		throw new QaError(`scrub failed, ${findings.length} finding(s): ${list.join('; ')}`);
	}
	return { ok: true, file };
}

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--') break;
		if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
		else out._.push(argv[i]);
	}
	return out;
}

function cfg() {
	try {
		return JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
	} catch {
		return {};
	}
}
const scrubPatterns = () => cfg().telemetry?.scrubPatterns ?? [];

// The run.json the scheduler wrote for the agent now running in this worktree, or null.
function runJson(root) {
	try {
		return readJson(path.join(root, '.dev-factory', 'run.json'));
	} catch {
		return null;
	}
}

// Records are what the scheduler and the stop gate trust, so only the role dispatched for the job may write them.
function requireRole(root, role, what) {
	const run = runJson(root);
	if (run?.role !== role) throw new QaError(`only the ${role} the scheduler dispatched ${what} (run.json role ${run?.role ?? 'none'})`);
	return run;
}

function debugCommand({ root, args, a }) {
	const [sub] = a._;
	const caps = cfg().debug ?? {};
	if (['open', 'run', 'record', 'block'].includes(sub))
		requireRole(root, 'debugger', `opens, runs, records or blocks a debug round (debug ${sub})`);
	switch (sub) {
		case 'open':
			return debugLib.open({
				root,
				trigger: a.trigger,
				command: a.command,
				output: a['output-file'] && fs.existsSync(a['output-file']) ? fs.readFileSync(a['output-file'], 'utf8') : '',
				caps,
			});
		case 'run': {
			const dash = args.indexOf('--');
			if (dash < 0) throw new QaError('debug run needs -- before the command');
			return debugLib.runLoop({ root, id: Number(a.id), command: args.slice(dash + 1).join(' '), branch: runJson(root)?.branch });
		}
		case 'record':
			return debugLib.record({
				root,
				id: Number(a.id),
				loop: a.loop,
				rootCause: a['root-cause'],
				evidence: a.evidence,
				fixPlan: a['fix-plan'],
				validationPlan: a['validation-plan'],
				caps,
				scrubPatterns: scrubPatterns(),
			});
		case 'status':
			return debugLib.status(root, caps);
		case 'block':
			return debugLib.block({ root, reason: a.reason });
		default:
			throw new QaError('usage: qa.mjs debug open|run|record|status|block');
	}
}

function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	const a = parseArgs(rest);
	const root = a.worktree ? repoRoot(a.worktree) : workRoot({ cwd: process.cwd() });
	const num = (v) => (v == null ? null : Number(v));
	try {
		let result;
		switch (cmd) {
			case 'start':
				result = start({ root, key: a.key, profile: a.profile });
				break;
			case 'record':
				result = record({
					root,
					run: num(a.run),
					caseSlug: a.case,
					status: a.status,
					assertion: a.assertion,
					screenshot: a.screenshot,
					step: num(a.step) ?? 1,
				});
				break;
			case 'done':
				result = done({ root, run: num(a.run) });
				break;
			case 'mark-na':
				result = markNa({ root, key: a.key, profile: a.profile, reason: a.reason });
				break;
			case 'verify':
				result = verify({
					root,
					head: a.head,
					run: num(a.run),
					key: a.key,
					requireReview: a['require-review'] === 'true',
					specialistAxes: cfg().review?.specialistAxes,
				});
				break;
			case 'learnings':
				if (a._[0] !== 'check') throw new QaError('usage: qa.mjs learnings check --key KEY');
				result = learningsCheck({ root, key: a.key, bodyFile: a['body-file'] });
				break;
			case 'promote':
				if (a._[0] !== 'check') throw new QaError('usage: qa.mjs promote check');
				result = promoteCheck({ root, cap: cfg().improvement?.agentsRuleCap ?? 15 });
				break;
			case 'review': {
				const specialistAxes = cfg().review?.specialistAxes;
				if (a._[0] === 'record') {
					const run = requireRole(root, 'reviewer', `for the ${a.axis} axis records a review`);
					if (run.axis !== a.axis)
						throw new QaError(`only the ${a.axis} reviewer records a ${a.axis} review (run.json axis ${run.axis ?? 'none'})`);
					result = reviewRecord({ root, axis: a.axis, head: a.head, summary: a.summary, findings: a.findings, by: run.role });
				} else if (a._[0] === 'status') result = reviewStatus({ root, head: a.head, specialistAxes });
				else throw new QaError('usage: qa.mjs review record|status');
				break;
			}
			case 'ticket': {
				if (a._[0] === 'base' && a.file) {
					result = { base: parseBase(fs.readFileSync(a.file, 'utf8')) };
					break;
				}
				if (a._[0] !== 'lint' || !a.file) throw new QaError('usage: qa.mjs ticket lint --file F [--strict true] | ticket base --file F');
				const problems = lintTicket(fs.readFileSync(a.file, 'utf8'), { strict: a.strict === 'true' });
				if (problems.length) throw new QaError(`ticket lint failed: ${problems.join('; ')}`);
				result = { ok: true };
				break;
			}
			case 'debug':
				result = debugCommand({ root, args: rest, a });
				break;
			case 'scrub':
				result = scrubFile({ file: a.file, patterns: scrubPatterns() });
				break;
			case 'show':
				result = loadRun(root, num(a.run));
				break;
			default:
				console.error(
					'usage: qa.mjs start|record|done|mark-na|verify|show|review|learnings|promote|scrub|debug|ticket (see header of this file)',
				);
				process.exit(3);
		}
		console.log(JSON.stringify(result, null, 2));
	} catch (err) {
		console.error(`qa: ${err.message}`);
		process.exit(err instanceof QaError ? err.code : 1);
	}
}

if (isMain(import.meta.url)) main();
