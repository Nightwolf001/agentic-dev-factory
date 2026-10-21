// Debug records and budgets for one ticket worktree. No database: records live in
// .dev-factory/debug/NNN.json and are written only through qa.mjs debug. Pure of process state
// except for the explicit `runLoop`, which executes one command under the debugger's shell rules.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { evaluate } from './guard-lib.mjs';
import { scrubFindings } from './scrub-lib.mjs';

export const TRIGGERS = ['triage', 'unstick', 'validate'];
export const EVIDENCE_KINDS = ['sentry', 'axiom', 'log', 'test'];
export const MIN_ROOT_CAUSE_CHARS = 40;

export class DebugError extends Error {}

const dirOf = (root) => path.join(root, '.dev-factory', 'debug');
const fileOf = (root, id) => path.join(dirOf(root), `${String(id).padStart(3, '0')}.json`);
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

export function listRecords(root) {
	const d = dirOf(root);
	if (!fs.existsSync(d)) return [];
	return fs
		.readdirSync(d)
		.filter((f) => /^\d+\.json$/.test(f))
		.sort()
		.map((f) => read(path.join(d, f)));
}

// First lines that look like errors, with numbers, hex and quoted values normalised so the same
// failure fingerprints the same across runs.
export function fingerprint(command, output) {
	const lines = output
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => /error|fail|exception|timeout|refused|cannot|not found|denied|expected/i.test(l))
		.slice(0, 5)
		.map((l) =>
			l
				.toLowerCase()
				.replace(/0x[0-9a-f]+|\b[0-9a-f]{8,}\b/g, 'H')
				.replace(/\d+/g, 'N')
				.replace(/(["'`]).*?\1/g, 'Q')
				.replace(/\s+/g, ' '),
		);
	return createHash('sha1')
		.update(command.trim() + '\n' + lines.join('\n'))
		.digest('hex');
}

export function status(root, { maxDebugRounds = 2 } = {}) {
	const recs = listRecords(root).filter((r) => r.trigger !== 'validate');
	const open = recs.filter((r) => r.status === 'open');
	return {
		rounds: recs.length,
		budgetLeft: Math.max(0, maxDebugRounds - recs.length),
		open: open.map((r) => r.id),
		recorded: recs.filter((r) => r.status === 'recorded').length,
		recordedAll: listRecords(root).filter((r) => r.status === 'recorded').length,
		openAll: listRecords(root)
			.filter((r) => r.status === 'open')
			.map((r) => r.id),
		hasRootCause: recs.some((r) => r.status === 'recorded' && r.trigger !== 'validate'),
		fingerprints: recs.map((r) => r.fingerprint),
	};
}

export function open({ root, trigger, command, output = '', caps = {}, now = Date.now() }) {
	if (!TRIGGERS.includes(trigger)) throw new DebugError(`--trigger must be one of ${TRIGGERS.join(', ')}`);
	if (!command || !command.trim()) throw new DebugError('open needs --command, the command that fails');
	const max = caps.maxDebugRounds ?? 2;
	const all = listRecords(root);
	const counted = all.filter((r) => r.trigger !== 'validate');
	if (trigger !== 'validate' && counted.length >= max)
		throw new DebugError(`debug budget spent: ${counted.length} of ${max} rounds used; block the ticket for a person`);
	const fp = fingerprint(command, output);
	const same = all.find((r) => r.fingerprint === fp && r.trigger !== 'validate');
	if (same && trigger !== 'validate')
		throw new DebugError(
			`the same failure was already investigated in round ${same.id} (fingerprint ${fp.slice(0, 12)}); block the ticket for a person`,
		);
	const id = all.length + 1;
	const rec = { id, trigger, command: command.trim(), fingerprint: fp, status: 'open', openedAt: new Date(now).toISOString(), loops: [] };
	fs.mkdirSync(dirOf(root), { recursive: true });
	fs.writeFileSync(fileOf(root, id), JSON.stringify(rec, null, 2) + '\n');
	return rec;
}

// Runs one command under the debugger's own shell rules and stores the command and exit code it observed.
export function runLoop({ root, id, command, branch }) {
	const rec = load(root, id);
	if (rec.status !== 'open') throw new DebugError(`round ${id} is already ${rec.status}`);
	const verdict = evaluate(command, { role: 'debugger', branch });
	if (verdict.deny) throw new DebugError(verdict.reason);
	const r = spawnSync('bash', ['-c', command], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
	const exitCode = r.status ?? (r.signal ? 124 : 1);
	rec.loops.push({ command, exitCode, at: new Date().toISOString() });
	fs.writeFileSync(fileOf(root, id), JSON.stringify(rec, null, 2) + '\n');
	return { exitCode, stdout: (r.stdout || '').slice(-4000), stderr: (r.stderr || '').slice(-2000) };
}

function load(root, id) {
	const f = fileOf(root, id);
	if (!fs.existsSync(f)) throw new DebugError(`no debug round ${id}`);
	return read(f);
}

export function record({ root, id, loop, rootCause, evidence, fixPlan, validationPlan, caps = {}, scrubPatterns = [], now = Date.now() }) {
	const rec = load(root, id);
	if (rec.status !== 'open') throw new DebugError(`round ${id} is already ${rec.status}`);
	const minutes = caps.debugMinutes ?? 20;
	if (now - Date.parse(rec.openedAt) > minutes * 60000)
		throw new DebugError(`round ${id} is past its ${minutes} minute budget; block the ticket for a person`);
	const ran = rec.loops.find((l) => l.command === loop);
	if (!loop || !ran) throw new DebugError('--loop must be a command run through qa.mjs debug run in this round');
	if (!rootCause || rootCause.trim().length < MIN_ROOT_CAUSE_CHARS)
		throw new DebugError(`root cause needs at least ${MIN_ROOT_CAUSE_CHARS} characters`);
	if (!fixPlan || !fixPlan.trim()) throw new DebugError('--fix-plan is required');
	let ev;
	try {
		ev = typeof evidence === 'string' ? JSON.parse(evidence) : evidence;
	} catch {
		throw new DebugError('--evidence must be a JSON array');
	}
	if (!Array.isArray(ev) || !ev.length) throw new DebugError('at least one evidence item is required');
	for (const e of ev) {
		if (!EVIDENCE_KINDS.includes(e?.kind) || !e.ref || !e.summary)
			throw new DebugError(`evidence needs kind (${EVIDENCE_KINDS.join('|')}), ref and summary`);
	}
	const text = JSON.stringify({ rootCause, fixPlan, validationPlan, ev });
	const leaks = scrubFindings(text.replace(/\\n/g, '\n'), scrubPatterns);
	if (leaks.length) throw new DebugError(`record holds raw data (${leaks[0].rule}); store ids and aggregate counts only`);
	Object.assign(rec, {
		status: 'recorded',
		loop: { command: ran.command, exitCode: ran.exitCode },
		rootCause: rootCause.trim(),
		evidence: ev,
		fixPlan: fixPlan.trim(),
		validationPlan: validationPlan?.trim() || null,
		recordedAt: new Date(now).toISOString(),
	});
	fs.writeFileSync(fileOf(root, id), JSON.stringify(rec, null, 2) + '\n');
	return rec;
}

// The debugger's way to give up: blocked.json is what the scheduler and the stop gate read.
export function block({ root, reason }) {
	if (!reason || !reason.trim()) throw new DebugError('block needs --reason');
	const f = path.join(root, '.dev-factory', 'blocked.json');
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(
		f,
		JSON.stringify(
			{ reason: reason.trim(), decision: 'a person must reproduce or decide; the debugger could not establish a root cause' },
			null,
			2,
		) + '\n',
	);
	return { blocked: true };
}
