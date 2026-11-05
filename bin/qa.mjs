#!/usr/bin/env node
// QA manifest CLI. Zero dependencies. The model walks a case through MCP; this tool is the only
// thing that turns that walk into a verdict, and it refuses anything that is not fresh evidence
// for this run at this commit.
//
//   qa.mjs start   --key KEY --profile web|mobile|service
//   qa.mjs record  --run N --case SLUG --status pass|fail --assertion TEXT [--screenshot FILE] [--video FILE] [--log FILE] [--kind worker --evidence-file FILE] [--step N]
//   qa.mjs probe   --run N --case SLUG --url URL [--method GET] [--header 'Name: value']... [--body-file F | --body TEXT] [--expect-status 200] [--step N]   send an API request, keep the answer as evidence
//   qa.mjs done    --run N
//   qa.mjs mark-na --key KEY --profile web|mobile|service --reason TEXT   only when every changed file is documentation, a test or a formatting rule (noBehaviourGlobs)
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
//   qa.mjs ticket blocked-by --file F             {"blockedBy": ["KEY", ...]} from a "Blocked by" line or section
//   qa.mjs ticket remote --file F                 {"remote": {"env", "account"}} from a "Remote-QA:" line, or null
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
import { load as loadConfig } from '../scripts/config.mjs';
import { globToRegExp, readSealed, stillSealed } from '../scripts/env-build-files.mjs';
import { isMain } from '../scripts/is-main.mjs';
import { LEGACY_FILES, PROJECT_FILES } from '../scripts/project-dir.mjs';
import { ProbeError, probe as sendProbe } from '../scripts/probe-lib.mjs';
import { redactText } from '../scripts/scrub-lib.mjs';
import { learningRequired, lintLearnings, parseLearnings } from '../scripts/learnings-lib.mjs';
import { checkPromotion } from '../scripts/promote-lib.mjs';
import { lintTicket, parseRemoteQa } from '../scripts/ticket-lib.mjs';
import { normaliseRef, parseBlockedBy } from '../scripts/sources/common.mjs';
import { parseBase, validName } from '../scripts/worktree.mjs';
import { scrubFindings } from '../scripts/scrub-lib.mjs';
import { workRoot } from '../scripts/run-context.mjs';

export const MIN_ASSERTION_CHARS = 8;
export const MIN_IMAGE_BYTES = 1024;
export const MIN_VIDEO_BYTES = 1024;
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

// What a walk or a review judged is the ticket's own change against its base. When the base is merged into the branch the
// head moves but that change does not, so a verdict made before the merge still holds. The change is hashed as hunks with one line of
// context, without line numbers or blob ids, which are what a merge of unrelated base work shifts. The context line keeps a hunk's
// place: the same lines moved elsewhere in a file are a different change.
export function diffHash(root, head, base) {
	try {
		const raw = execFileSync('git', ['diff', '--no-ext-diff', '--binary', '--no-renames', '-U1', `${base}...${head}`], {
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			maxBuffer: 512 << 20,
		});
		const text = raw
			.split('\n')
			.filter((l) => !l.startsWith('index '))
			.map((l) => (l.startsWith('@@') ? '@@' : l))
			.join('\n');
		return createHash('sha256').update(text).digest('hex');
	} catch {
		return null;
	}
}

// Whether a record made at `fromHead` (with the change hash it recorded) still stands at `head`: the head is a descendant of
// it and the change is the same.
export function carried(root, { head: fromHead, diffHash: fromHash }, head, base) {
	if (!fromHash || !fromHead || !head) return false;
	try {
		execFileSync('git', ['merge-base', '--is-ancestor', fromHead, head], { cwd: root, stdio: 'ignore' });
	} catch {
		return false;
	}
	return diffHash(root, head, base) === fromHash;
}

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

// Untracked and modified files count, except the factory's own run state, the per-repository `.devfactory/` folder (a builder's
// scratch QA cases are never uncommitted work; the legacy `.factory/qa/cases/` is committed, so it is not exempt) and the build
// files the environment step rewrote (sealed by content hash: a ticket's own edit to one still counts).
export function dirtyFiles(root) {
	// not trimmed: the first line of a porcelain listing starts with a space when the file is modified and unstaged
	const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const sealed = readSealed(root);
	return out
		.split('\n')
		.filter(Boolean)
		.map((l) => l.slice(3))
		.filter((f) => !f.startsWith('.dev-factory/') && !f.startsWith('.devfactory/') && !stillSealed(root, f, sealed));
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

// QA cases are scratch work in the repository under test, not in the plugin and not in git: a run is bound to their content by
// sha256 digests (see caseDigests), not by a commit. A repository that still keeps them committed under `.factory/qa/cases/` is
// read as before.
export const CASES_DIR = path.normalize(PROJECT_FILES.cases);
export const LEGACY_CASES_DIR = path.normalize(LEGACY_FILES.cases);

// What kind of case a file is: a screen walked in a browser or on a device (ui), a request and its answer (api), or a job and
// what it did (worker). A pass needs evidence of its own kind: an image, a probe or the worker's output.
export const CASE_KINDS = ['ui', 'api', 'worker'];
const CASE_FILE = [
	['api', /\.api\.md$/],
	['worker', /\.worker\.md$/],
	['ui', /\.(ya?ml|spec\.ts)$/],
];

// The case files directly inside one folder: [{ file, slug, kind }], sorted by slug.
function caseFilesIn(dir) {
	let names;
	try {
		names = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return names
		.filter((d) => !d.isDirectory())
		.map((d) => {
			const f = d.name;
			const hit = CASE_FILE.find(([, re]) => re.test(f));
			return hit ? { file: f, slug: f.replace(hit[0] === 'ui' ? /\.(ya?ml|spec\.ts)$/ : /\.md$/, ''), kind: hit[0] } : null;
		})
		.filter(Boolean)
		.sort((x, y) => x.slug.localeCompare(y.slug));
}

// Where the cases of a ticket are, relative to the root: the new folder when it holds any case file for the key, else the legacy
// folder when that does, else the new folder (where the builder is about to write them).
export function casesDirFor(root, key) {
	if (caseFilesIn(path.join(root, CASES_DIR, key)).length) return CASES_DIR;
	if (caseFilesIn(path.join(root, LEGACY_CASES_DIR, key)).length) return LEGACY_CASES_DIR;
	return CASES_DIR;
}

export function listCaseFiles(root, key) {
	return caseFilesIn(path.join(root, casesDirFor(root, key), key)).map(({ slug, kind }) => ({ slug, kind }));
}

// sha256 of every case file of the key in one folder: { "<path relative to the root, with />": "<hex>" }
export function caseDigests(root, key, casesDir = casesDirFor(root, key)) {
	const out = {};
	for (const { file } of caseFilesIn(path.join(root, casesDir, key))) {
		const rel = path.join(casesDir, key, file);
		out[rel.split(path.sep).join('/')] = sha256(path.join(root, rel));
	}
	return out;
}

// The paths whose content differs between the digests a run recorded and the folder now: changed, added or missing.
function casesChanged(root, key, recorded, casesDir) {
	const now = caseDigests(root, key, casesDir);
	return [...new Set([...Object.keys(recorded), ...Object.keys(now)])].filter((p) => recorded[p] !== now[p]).sort();
}

// A run cannot outlive its cases. A manifest written before digests were recorded has none and is accepted as it always was.
function checkCases(root, m) {
	if (!m.caseDigests) return;
	const changed = casesChanged(root, m.key, m.caseDigests, m.casesDir ?? casesDirFor(root, m.key));
	if (changed.length)
		throw new QaError(
			`cases_changed: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? `, and ${changed.length - 5} more` : ''} (the cases are not what this run walked; start a new run)`,
		);
}

export const listCases = (root, key) => listCaseFiles(root, key).map((c) => c.slug);

// { ui: { total, passed, failed }, api: ..., worker: ... } for the kinds that are present
export function caseSummary(cases) {
	const out = {};
	for (const c of cases) {
		const k = (out[c.kind ?? 'ui'] ??= { total: 0, passed: 0, failed: 0 });
		k.total++;
		if (c.status === 'pass') k.passed++;
		if (c.status === 'fail') k.failed++;
	}
	return out;
}

export function start({ root, key, profile }) {
	if (!key || !profile) throw new QaError('start needs --key and --profile');
	const dirty = dirtyFiles(root);
	if (dirty.length) throw new QaError(`working tree is not clean (commit first): ${dirty.slice(0, 5).join(', ')}`);
	const casesDir = casesDirFor(root, key);
	const cases = listCaseFiles(root, key);
	if (!cases.length) throw new QaError(`needs_own_case: no case authored under ${PROJECT_FILES.cases}/${key}/`, 2);
	const run = nextRun(root);
	const envFile = path.join(root, '.dev-factory', 'env.json');
	const manifest = {
		run,
		key,
		profile,
		head: git(root, 'rev-parse', 'HEAD'),
		diffHash: diffHash(root, 'HEAD', baseFor(root)),
		startedAt: new Date().toISOString(),
		env: fs.existsSync(envFile) ? readJson(envFile) : null,
		cases: cases.map(({ slug, kind }) => ({ slug, kind, status: null })),
		casesDir: casesDir.split(path.sep).join('/'),
		caseDigests: caseDigests(root, key, casesDir),
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
// (`#3b82f6` is a colour and `previous page` a button; what is refused is a pointer to another run, walk or result)
const CITES_OTHER_RUN =
	/\b(run|walk|case|attempt)\s*#?\d+|(^|[\s(])#\d{1,3}(?![0-9a-f])|\bprevious(ly)?\s+(run|walk|pass|attempt|result|screenshot|evidence|verdict)|\bpreviously\b|same commit|already passed|as before/i;

// A video is recognised by what the file starts with, not by its name: an MP4 or QuickTime file has `ftyp` at byte 4, a WebM
// or Matroska file starts with the EBML header.
const isVideo = (buf) =>
	buf.length > 12 && (buf.subarray(4, 8).toString('latin1') === 'ftyp' || buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));

export const MAX_LOG_BYTES = 8 * 1024;
export const MIN_WORKER_EVIDENCE_CHARS = 32;
// evidence a pass can rest on, by type; a video or a log only supports one
export const PASSING_EVIDENCE = ['image', 'probe', 'worker'];
// ...and which of them a case of each kind can rest on: a screen is shown by a picture, a request by its answer, a job by its output
const PROOF_FOR = { ui: ['image'], api: ['image', 'probe'], worker: ['image', 'worker'] };

// The newest part of a log, whole lines only, with personal data and secrets replaced. Redacted first (over the newest 64 KB,
// which is bounded work) and cut after, so the file kept is never longer than the cap whatever the replacements did to the length.
function logTail(text, patterns, secrets) {
	const bytes = (t) => Buffer.byteLength(t);
	let t =
		bytes(text) > 64 * 1024
			? Buffer.from(text)
					.subarray(-64 * 1024)
					.toString('utf8')
			: text;
	t = t.slice(t === text ? 0 : t.indexOf('\n') + 1);
	const red = redactText(t, { extraPatterns: patterns, secrets });
	let out = red.text;
	if (bytes(out) > MAX_LOG_BYTES) {
		out = Buffer.from(out).subarray(-MAX_LOG_BYTES).toString('utf8');
		out = out.slice(out.indexOf('\n') + 1); // the first line is cut in the middle
	}
	return { text: out, redactions: red.redactions };
}

const evidenceDir = (root, m) => path.join('.dev-factory', 'evidence', m.key, `run-${m.run}`);

function openRun(root, run) {
	const m = loadRun(root, run);
	if (m.verdict) throw new QaError(`run ${run} is already finished (${m.verdict})`);
	if (git(root, 'rev-parse', 'HEAD') !== m.head) throw new QaError('HEAD moved since the run started; start a new run');
	return m;
}

// Copies a file the walk produced into the evidence folder after the checks every kind of capture shares: it exists, is big
// enough, is fresh (made during this run) and is not byte-identical to something already registered.
// A piece of evidence has a file named by its case and step. Writing a second one to the same name would replace the first on disk
// while the manifest kept both hashes, and the run could never be verified.
function claim(m, rel, caseSlug, step) {
	if (m.evidence.some((e) => e.file === rel))
		throw new QaError(
			`step ${step} of case ${caseSlug} already holds evidence of this kind; record the next one with --step ${Number(step) + 1}`,
		);
}

function registerFile({ root, m, caseSlug, step, file, what, minBytes = MIN_IMAGE_BYTES, ext, check }) {
	if (!fs.existsSync(file)) throw new QaError(`${what} not found: ${file}`);
	const st = fs.statSync(file);
	const buf = fs.readFileSync(file);
	if (st.size < minBytes) throw new QaError(`${what} is ${st.size} bytes; at least ${minBytes} required`);
	if (check && !check(buf)) throw new QaError(`${what} is not ${what === 'video' ? 'an MP4, MOV or WebM file' : 'a PNG or JPEG'}`);
	if (st.mtimeMs < Date.parse(m.startedAt) - MTIME_TOLERANCE_MS) throw new QaError(`${what} predates this run; take a fresh one`);
	const hash = sha256(file);
	const dup = m.evidence.find((e) => e.sha256 === hash);
	if (dup) throw new QaError(`${what} bytes already registered for case ${dup.case}; capture the state this case asserts`);
	const rel = path.join(evidenceDir(root, m), `${caseSlug}-${step}.${ext(buf)}`);
	claim(m, rel, caseSlug, step);
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.copyFileSync(file, path.join(root, rel));
	return { case: caseSlug, step, file: rel, sha256: hash, bytes: st.size };
}

// Text kept as evidence (a log tail, a worker's output, a probe): redacted first, so the file on disk is what may be shown.
function registerText({ root, m, caseSlug, step, type, name, text, extra = {} }) {
	const rel = path.join(evidenceDir(root, m), name);
	claim(m, rel, caseSlug, step);
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), text);
	const bytes = Buffer.byteLength(text);
	return { case: caseSlug, step, type, file: rel, sha256: createHash('sha256').update(text).digest('hex'), bytes, ...extra };
}

export function record({
	root,
	run,
	caseSlug,
	status,
	assertion,
	screenshot,
	video,
	log,
	kind,
	evidenceFile,
	step = 1,
	secrets = [],
	patterns = [],
}) {
	const m = openRun(root, run);
	const c = m.cases.find((x) => x.slug === caseSlug);
	if (!c) throw new QaError(`case ${caseSlug} is not part of run ${run}`);
	if (!['pass', 'fail'].includes(status)) throw new QaError('--status must be pass or fail');
	if (!assertion || assertion.trim().length < MIN_ASSERTION_CHARS)
		throw new QaError(`assertion needs at least ${MIN_ASSERTION_CHARS} characters describing what was observed`);
	if (CITES_OTHER_RUN.test(assertion))
		throw new QaError('assertion must describe this walk; it may not cite another run, a run number or an earlier pass');
	if (kind != null && kind !== 'worker')
		throw new QaError('--kind is worker (with --evidence-file); images, videos and logs are told apart by their option');
	if ((kind === 'worker') !== !!evidenceFile) throw new QaError('worker evidence is --kind worker together with --evidence-file FILE');
	if (evidenceFile && (c.kind ?? 'ui') !== 'worker')
		throw new QaError(`case ${caseSlug} is a ${c.kind ?? 'ui'} case; worker evidence belongs to a .worker.md case`);

	const added = [];
	if (screenshot)
		added.push({
			type: 'image',
			...registerFile({
				root,
				m,
				caseSlug,
				step,
				file: screenshot,
				what: 'screenshot',
				check: isImage,
				ext: (b) => (b[0] === 0x89 ? 'png' : 'jpg'),
			}),
		});
	if (video)
		added.push({
			type: 'video',
			...registerFile({
				root,
				m,
				caseSlug,
				step,
				file: video,
				what: 'video',
				minBytes: MIN_VIDEO_BYTES,
				check: isVideo,
				ext: (b) => (b[0] === 0x1a ? 'webm' : 'mp4'),
			}),
		});
	if (log) {
		if (!fs.existsSync(log)) throw new QaError(`log not found: ${log}`);
		const t = logTail(fs.readFileSync(log, 'utf8'), patterns, secrets);
		added.push(
			registerText({
				root,
				m,
				caseSlug,
				step,
				type: 'log',
				name: `${caseSlug}-${step}.log.txt`,
				text: t.text,
				extra: { redactions: t.redactions },
			}),
		);
	}
	if (evidenceFile) {
		if (!fs.existsSync(evidenceFile)) throw new QaError(`evidence file not found: ${evidenceFile}`);
		const raw = fs.readFileSync(evidenceFile, 'utf8').slice(0, 64 * 1024);
		const t = redactText(raw, { extraPatterns: patterns, secrets });
		// what is left once the redaction markers are taken out: a file that is nothing but `[redacted:...]` shows nothing
		if (t.text.replace(/\[redacted:[^\]]*\]/g, '').replace(/\s+/g, '').length < MIN_WORKER_EVIDENCE_CHARS)
			throw new QaError(
				`worker evidence needs at least ${MIN_WORKER_EVIDENCE_CHARS} characters of what the worker did (its output, the rows it wrote, the message it sent)`,
			);
		const hash = createHash('sha256').update(t.text).digest('hex');
		const dup = m.evidence.find((e) => e.sha256 === hash);
		if (dup) throw new QaError(`worker evidence already registered for case ${dup.case}; keep what this case's job did`);
		added.push(
			registerText({
				root,
				m,
				caseSlug,
				step,
				type: 'worker',
				name: `${caseSlug}-${step}.worker.txt`,
				text: t.text,
				extra: { redactions: t.redactions },
			}),
		);
	}
	m.evidence.push(...added);
	if (status === 'pass') {
		// an image, a probe or the worker's output; a video or a log alone shows that something ran, not what it did
		const proof = m.evidence.filter((e) => e.case === caseSlug && PROOF_FOR[c.kind ?? 'ui'].includes(e.type ?? 'image'));
		if (!proof.length) {
			const need = {
				ui: 'screenshot',
				api: 'screenshot or probe (qa.mjs probe)',
				worker: 'screenshot or piece of worker evidence (--kind worker --evidence-file)',
			}[c.kind ?? 'ui'];
			throw new QaError(
				`a pass needs at least one ${need} registered for this case in this run${added.some((e) => ['video', 'log'].includes(e.type)) ? '; a video or a log alone does not pass a case' : ''}`,
			);
		}
		if (!proof.some((e) => e.type !== 'probe' || e.ok))
			throw new QaError('the probes for this case did not get the expected answer; a pass needs one that did');
	}
	c.status = status;
	c.assertion = assertion.trim();
	c.recordedAt = new Date().toISOString();
	writeJson(manifestPath(root, run), m);
	return { case: c, evidence: added[0] ?? null, evidenceAdded: added.map((e) => ({ type: e.type, file: e.file })) };
}

// Sends the request of an API case and registers the answer as evidence for it. See scripts/probe-lib.mjs for the rules.
export async function probe({
	root,
	run,
	caseSlug,
	url,
	method,
	headers = [],
	body = null,
	bodyFile = null,
	expectStatus = null,
	step = null,
	fetchImpl,
	patterns = [],
	secrets = [],
}) {
	const m = openRun(root, run);
	if (!m.cases.some((x) => x.slug === caseSlug)) throw new QaError(`case ${caseSlug} is not part of run ${run}`);
	let payload = body;
	if (bodyFile) {
		if (!fs.existsSync(bodyFile)) throw new QaError(`body file not found: ${bodyFile}`);
		payload = fs.readFileSync(bodyFile, 'utf8');
	}
	let rec;
	try {
		rec = await sendProbe({ url, method, headers, body: payload, expectStatus, env: m.env ?? {}, fetchImpl, secrets, extraPatterns: patterns });
	} catch (e) {
		if (e instanceof ProbeError) throw new QaError(`probe refused or failed: ${e.message}`);
		throw e;
	}
	const text = JSON.stringify(rec, null, 2) + '\n';
	// a case is often probed again after a fix: without --step, the next free one is taken, so the earlier answer stays on record
	let n = step ?? 1;
	if (step == null) while (m.evidence.some((e) => e.file === path.join(evidenceDir(root, m), `${caseSlug}-probe-${n}.json`))) n++;
	const entry = registerText({
		root,
		m,
		caseSlug,
		step: n,
		type: 'probe',
		name: `${caseSlug}-probe-${n}.json`,
		text,
		extra: { status: rec.status, ok: rec.ok },
	});
	m.evidence.push(entry);
	writeJson(manifestPath(root, run), m);
	return { ...entry, probe: { method: rec.method, path: rec.path, status: rec.status, expectStatus: rec.expectStatus, ok: rec.ok, ms: rec.ms } };
}

export function done({ root, run }) {
	const m = loadRun(root, run);
	if (m.verdict) return m;
	const missing = m.cases.filter((c) => !c.status).map((c) => c.slug);
	if (missing.length) throw new QaError(`cases not recorded: ${missing.join(', ')}`);
	if (git(root, 'rev-parse', 'HEAD') !== m.head) throw new QaError('HEAD moved since the run started; the run closes as stale, start a new one');
	const dirty = dirtyFiles(root);
	if (dirty.length) throw new QaError(`working tree changed during the walk: ${dirty.slice(0, 5).join(', ')}`);
	checkCases(root, m);
	m.verdict = m.cases.every((c) => c.status === 'pass') ? 'pass' : 'fail';
	m.caseSummary = caseSummary(m.cases);
	m.finishedAt = new Date().toISOString();
	writeJson(manifestPath(root, run), m);
	return m;
}

// Minimal reader for a glob list (uiGlobs, nonUiGlobs) in profiles.yaml (no YAML dependency).
// A repository's own QA profiles replace the plugin's default ones: `.devfactory/qa.yaml`, else the legacy `dev-factory.qa.yaml`.
function profilesFile(root) {
	const own = root ? [PROJECT_FILES.qa, LEGACY_FILES.qa].map((f) => path.join(root, f)).find((f) => fs.existsSync(f)) : null;
	return own ?? fileURLToPath(new URL('../qa/profiles.yaml', import.meta.url));
}

function globListFor(profile, key, root) {
	const text = fs.readFileSync(profilesFile(root), 'utf8').split('\n');
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

export const uiGlobsFor = (root, profile) => globListFor(profile, 'uiGlobs', root);
// Files under a UI folder that are still not UI surface (documentation), so a docs-only diff does not need a walk.
export const nonUiGlobsFor = (root, profile) => globListFor(profile, 'nonUiGlobs', root);
// Files whose change cannot alter what the software does. A profile that does not list any uses its nonUiGlobs.
export const noBehaviourGlobsFor = (root, profile) => {
	const own = globListFor(profile, 'noBehaviourGlobs', root);
	return own.length ? own : nonUiGlobsFor(root, profile);
};
export const MIN_NA_REASON_CHARS = 8;

export { globToRegExp };

// "Not applicable" is a claim that nothing here can change behaviour: it is accepted only when EVERY changed file is one the
// profile lists in noBehaviourGlobs (documentation, tests, formatting rules). A change to code that runs, a UI file or not,
// needs its cases walked: a walk for a screen, api or worker cases for a service.
export function markNa({ root, key, profile, reason, base = baseFor(root) }) {
	if (!key || !profile || !reason) throw new QaError('mark-na needs --key, --profile and --reason');
	if (reason.trim().length < MIN_NA_REASON_CHARS)
		throw new QaError(`the reason needs at least ${MIN_NA_REASON_CHARS} characters saying why nothing here changes behaviour`);
	const globs = noBehaviourGlobsFor(root, profile).map(globToRegExp);
	if (!globs.length) throw new QaError(`profile ${profile} has no noBehaviourGlobs (or nonUiGlobs), so nothing can be declared not applicable`);
	const files = git(root, 'diff', '--name-only', '--no-renames', `${base}...HEAD`).split('\n').filter(Boolean);
	const behaviour = files.filter((f) => !globs.some((g) => g.test(f)));
	if (behaviour.length)
		throw new QaError(
			`the diff changes files that can alter behaviour, so QA is required (a walk for a screen, api or worker cases for a service): ${behaviour.slice(0, 5).join(', ')}${behaviour.length > 5 ? `, and ${behaviour.length - 5} more` : ''}`,
		);
	const out = {
		key,
		profile,
		reason: reason.trim(),
		head: git(root, 'rev-parse', 'HEAD'),
		diffHash: diffHash(root, 'HEAD', base),
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
		files = git(root, 'diff', '--name-only', '--no-renames', `${base}...${head ?? 'HEAD'}`)
			.split('\n')
			.filter(Boolean);
	} catch {
		// the diff cannot be read (the base is not resolvable): every configured axis is required rather than none
		return SPECIALIST_AXES.filter((axis) => (specialistAxes[axis] ?? []).length > 0);
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

export function reviewRecord({ root, axis, head, summary, findings, by = null, base = baseFor(root) }) {
	if (!ALL_AXES.includes(axis)) throw new QaError(`--axis must be one of ${ALL_AXES.join(', ')}`);
	const full = git(root, 'rev-parse', 'HEAD');
	if (!head || !(full.startsWith(head) || head.startsWith(full)))
		throw new QaError(`review head ${head ?? '(none)'} is not the current HEAD ${full.slice(0, 9)}`);
	if (!summary || summary.trim().length < 20) throw new QaError('summary needs at least 20 characters describing what was checked');
	const dirty = dirtyFiles(root);
	if (dirty.length) throw new QaError(`working tree is not clean, review reads committed code: ${dirty.slice(0, 5).join(', ')}`);
	const list = parseFindings(findings);
	if (SPECIALIST_AXES.includes(axis)) {
		// a record made before a merge of the base stands for the same change (see diffHash), so it counts here too
		const std = reviewAt(root, full, 'standards', base);
		if (!std) throw new QaError(`the standards step has not been recorded at this commit; run it before ${axis}`);
		if (blocking(std.record.counts) > 0)
			throw new QaError(`the standards step has open Critical or High findings at this commit; fix them before ${axis}`);
	}
	if (axis === 'standards') {
		const spec = reviewAt(root, full, 'spec', base);
		if (!spec) throw new QaError('step 1 (spec) has not been recorded at this commit; run it first');
		const c = spec.record.counts;
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
		diffHash: diffHash(root, full, base),
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

// The record of one axis valid at `head`: the one made at exactly that commit, else the newest made earlier on this branch
// for the same change (see diffHash). -> { record, carriedFrom } or null
function reviewAt(root, head, axis, base) {
	const exact = reviewFile(root, head, axis);
	if (fs.existsSync(exact)) return { record: readJson(exact), carriedFrom: null };
	const dir = reviewDir(root);
	if (!fs.existsSync(dir)) return null;
	const older = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(`-${axis}.json`))
		.map((f) => readJson(path.join(dir, f)))
		.filter((r) => r.head !== head && carried(root, r, head, base))
		.sort((x, y) => String(y.at).localeCompare(String(x.at)));
	return older.length ? { record: older[0], carriedFrom: older[0].head } : null;
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
		const found = reviewAt(root, full, axis, base);
		if (!required.includes(axis) && !found) continue;
		if (!found) {
			out.axes[axis] = null;
			continue;
		}
		const r = found.record;
		out.axes[axis] = {
			counts: r.counts,
			blocking: blocking(r.counts),
			by: r.by ?? null,
			at: r.at,
			...(found.carriedFrom ? { carriedFrom: found.carriedFrom } : {}),
		};
	}
	out.clean = required.every((a) => out.axes[a] && out.axes[a].blocking === 0);
	return out;
}

// The newest finished run of this ticket made at the given head, so a caller never has to know the run number. With a base,
// a run made earlier on the branch for the same change also counts (reported as carriedFrom).
export function runForKey(root, key, head, base = null) {
	const dir = stateDir(root);
	if (!fs.existsSync(dir)) return null;
	const runs = fs
		.readdirSync(dir)
		.map((f) => /^run-(\d+)\.json$/.exec(f))
		.filter(Boolean)
		.map((m) => ({ n: Number(m[1]), m: readJson(path.join(dir, m[0])) }))
		.filter(({ m }) => m.key === key && m.verdict)
		.sort((a, b) => b.n - a.n);
	const exact = runs.find(({ m }) => m.head.startsWith(head) || head.startsWith(m.head));
	if (exact) return exact.m;
	const older = base && runs.find(({ m }) => m.verdict === 'pass' && carried(root, m, head, base));
	return older ? { ...older.m, carriedFrom: older.m.head } : null;
}

// Commits of a run belong to the person who ran it: an author, committer or trailer naming an agent is refused.
export function attributionProblems(root, head, base) {
	let log = '';
	try {
		log = git(root, 'log', `${base}..${head}`, '--format=%h%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e');
	} catch {
		return [`the commits of ${head} could not be read against ${base}, so their authorship was not checked`];
	}
	const out = [];
	for (const entry of log
		.split('\x1e')
		.map((e) => e.trim())
		.filter(Boolean)) {
		const [sha, an, ae, cn, ce, body] = entry.split('\x1f');
		if (/claude|anthropic/i.test(`${an} ${ae} ${cn} ${ce}`))
			out.push(`commit ${sha} is authored or committed by an agent identity (${an} <${ae}>)`);
		else if (/co-authored-by[^\n]*(claude|anthropic)|noreply@anthropic\.com|generated with[^\n]{0,40}claude/i.test(body ?? ''))
			out.push(`commit ${sha} carries an agent attribution line`);
	}
	return out;
}

export function verify({ root, head, run, key, requireReview = false, specialistAxes = {}, base = baseFor(root), noAttribution = false }) {
	if (!head) throw new QaError('verify needs --head');
	if (run == null && !key) throw new QaError('verify needs --run or --key');
	const problems = [];
	let full = head;
	try {
		full = git(root, 'rev-parse', '--verify', `${head}^{commit}`);
	} catch {
		/* not a commit here: the prefix comparisons below report it */
	}
	let manifest;
	if (run != null) {
		manifest = loadRun(root, run);
	} else {
		manifest = runForKey(root, key, head, base);
		if (!manifest) {
			const na = naPath(root, key);
			if (!fs.existsSync(na)) throw new QaError(`no QA run at ${head.slice(0, 9)} and no not-applicable record for ${key}`);
			manifest = readJson(na);
		}
	}
	let carriedFrom = manifest.carriedFrom ?? null;
	if (!manifest.head.startsWith(head) && !head.startsWith(manifest.head)) {
		if (!carriedFrom && carried(root, manifest, full, base)) carriedFrom = manifest.head;
		if (!carriedFrom) problems.push(`manifest head ${manifest.head.slice(0, 9)} is not the PR head ${head.slice(0, 9)}`);
	}
	if (manifest.verdict !== 'pass' && manifest.verdict !== 'not_applicable') problems.push(`verdict is ${manifest.verdict ?? 'open'}`);
	try {
		checkCases(root, manifest);
	} catch (e) {
		if (!(e instanceof QaError)) throw e;
		problems.push(e.message);
	}
	for (const e of manifest.evidence ?? []) {
		const f = path.join(root, e.file);
		if (!fs.existsSync(f)) problems.push(`evidence missing: ${e.file}`);
		else if (sha256(f) !== e.sha256) problems.push(`evidence changed since recorded: ${e.file}`);
	}
	if (requireReview) {
		const st = reviewStatus({ root, head: carriedFrom ? full : manifest.head, specialistAxes, base });
		for (const axis of [...AXES, ...st.triggered]) {
			if (!st.axes[axis]) problems.push(`review step ${axis} is not recorded at ${st.head.slice(0, 9)}`);
			else if (st.axes[axis].by !== 'reviewer') problems.push(`review step ${axis} was not recorded by a reviewer agent`);
			else if (st.axes[axis].blocking > 0) problems.push(`review step ${axis} has ${st.axes[axis].blocking} open Critical or High finding(s)`);
		}
	}
	if (noAttribution) problems.push(...attributionProblems(root, carriedFrom ? full : manifest.head, base));
	if (problems.length) throw new QaError(`verify failed: ${problems.join('; ')}`);
	return {
		ok: true,
		verdict: manifest.verdict,
		head: manifest.head,
		...(manifest.cases ? { caseSummary: manifest.caseSummary ?? caseSummary(manifest.cases) } : {}),
		...(carriedFrom ? { carriedFrom, prHead: full } : {}),
	};
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
	const names = git(root, 'diff', '--name-only', '--no-renames', `${base}...HEAD`).split('\n').filter(Boolean);
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
		return loadConfig(); // the defaults with the repository's dev-factory.config.json merged over them
	} catch {
		return {};
	}
}
const scrubPatterns = () => cfg().telemetry?.scrubPatterns ?? [];
// every value of an option that may repeat (--header A --header B)
const multi = (argv, name) => argv.flatMap((x, i) => (x === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
// Literal secrets to keep out of kept evidence: the values of the environment variables env.json names in `secretEnv`
// (the test account's password, a token the case sends). Their names are recorded, their values never.
function qaSecrets(root) {
	try {
		const names = readJson(path.join(root, '.dev-factory', 'env.json')).secretEnv;
		return (Array.isArray(names) ? names : []).map((n) => process.env[n]).filter(Boolean);
	} catch {
		return [];
	}
}

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

async function main() {
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
					video: a.video,
					log: a.log,
					kind: a.kind,
					evidenceFile: a['evidence-file'],
					step: num(a.step) ?? 1,
					patterns: scrubPatterns(),
					secrets: qaSecrets(root),
				});
				break;
			case 'probe':
				result = await probe({
					root,
					run: num(a.run),
					caseSlug: a.case,
					url: a.url,
					method: a.method,
					headers: [].concat(multi(rest, 'header')),
					body: a.body ?? null,
					bodyFile: a['body-file'],
					expectStatus: a['expect-status'],
					step: num(a.step),
					patterns: scrubPatterns(),
					secrets: qaSecrets(root),
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
					noAttribution: cfg().git?.agentAttribution !== true,
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
				if (a._[0] === 'remote' && a.file) {
					result = { remote: parseRemoteQa(fs.readFileSync(a.file, 'utf8')) };
					break;
				}
				if (a._[0] === 'blocked-by' && a.file) {
					result = {
						blockedBy: parseBlockedBy(fs.readFileSync(a.file, 'utf8'))
							.map((r) => normaliseRef(r))
							.filter(Boolean),
					};
					break;
				}
				if (a._[0] !== 'lint' || !a.file)
					throw new QaError(
						'usage: qa.mjs ticket lint --file F [--strict true] | ticket base --file F | ticket remote --file F | ticket blocked-by --file F',
					);
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
