// One JSON line per ticket pass in ~/.dev-factory/runs/runs.jsonl, the input of /dev-factory:improve.
//   run-record.mjs ticket --worktree W [--env E] [--cost USD] [--duration S] [--outcome O]
//   run-record.mjs pass --result-file F --started ISO [--exit N]   (session cost from the claude result JSON)
//   run-record.mjs learnings --worktree W --key K       index the ticket's short learnings for later builds
//   run-record.mjs preload --text-file F                the few learnings that match the paths a ticket mentions
//   run-record.mjs clusters [--since ISO] [--min N]                recurring causes, as JSON
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listRecords } from './debug-lib.mjs';
import { isMain } from './is-main.mjs';
import { learningRequired, parseLearnings, preload } from './learnings-lib.mjs';

export const learningsIndex = () => path.join(path.dirname(path.dirname(runsFile())), 'learnings.jsonl');
export const runsFile = () => path.join(process.env.DF_STATE_DIR || path.join(os.homedir(), '.dev-factory'), 'runs', 'runs.jsonl');

const readJson = (f) => {
	try {
		return JSON.parse(fs.readFileSync(f, 'utf8'));
	} catch {
		return null;
	}
};

export function buildTicketRecord({ worktree, env = null, costUsd = null, durationS = null, outcome = null, now = new Date() }) {
	const dir = path.join(worktree, '.dev-factory');
	const run = readJson(path.join(dir, 'run.json')) ?? {};
	const reviewDir = path.join(dir, 'review');
	const reviews = fs.existsSync(reviewDir)
		? fs
				.readdirSync(reviewDir)
				.filter((f) => f.endsWith('.json'))
				.map((f) => readJson(path.join(reviewDir, f)))
				.filter(Boolean)
		: [];
	const qaDir = path.join(dir, 'qa');
	const qaRuns = fs.existsSync(qaDir) ? fs.readdirSync(qaDir).filter((f) => /^run-\d+\.json$/.test(f)).length : 0;
	const debug = listRecords(worktree);
	const blocked = readJson(path.join(dir, 'blocked.json'));
	const has = (f) => fs.existsSync(path.join(dir, f));
	const phases = ['environment', has('build.done') && 'build', qaRuns && 'qa', reviews.length && 'review', has('ship.done') && 'ship'].filter(
		Boolean,
	);
	const counts = reviews.map((r) => r.counts);
	return {
		type: 'ticket',
		at: now.toISOString(),
		key: run.key ?? null,
		kind: run.kind ?? null,
		environment: env,
		phases,
		reviewRounds: new Set(reviews.map((r) => r.head)).size,
		reviewHigh: counts.reduce((n, c) => n + (c.critical ?? 0) + (c.high ?? 0), 0),
		reviewAxes: [...new Set(reviews.map((r) => r.axis))],
		qaAttempts: qaRuns,
		debugRounds: debug.filter((d) => d.trigger !== 'validate').length,
		fingerprints: debug.map((d) => d.fingerprint),
		blockedReason: blocked?.reason ?? null,
		learningRequired: learningRequired({ debugRounds: debug.length, reviewCounts: counts }),
		costUsd,
		durationS,
		outcome: outcome ?? (blocked ? 'blocked' : has('ship.done') ? 'shipped' : 'incomplete'),
	};
}

export function append(record, file = runsFile()) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, JSON.stringify(record) + '\n');
	return record;
}

export function readRuns(file = runsFile(), since = null) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((r) => !since || r.at > since);
}

const norm = (s) => s.toLowerCase().replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 120);

// Causes that recur across different tickets: same debug fingerprint, same blocked reason, same
// outcome of a repeated review High, or a repeated environment failure.
export function clusters(records, min = 2) {
	const groups = new Map();
	const add = (kind, key, r, sample) => {
		const id = `${kind}:${key}`;
		const g = groups.get(id) ?? { kind, key, tickets: new Set(), sample };
		g.tickets.add(r.key ?? 'unknown');
		groups.set(id, g);
	};
	for (const r of records.filter((x) => x.type === 'ticket')) {
		for (const fp of new Set(r.fingerprints ?? [])) add('fingerprint', fp, r, `debug fingerprint ${fp.slice(0, 12)}`);
		if (r.blockedReason) add('blocked', norm(r.blockedReason), r, r.blockedReason);
		if ((r.reviewHigh ?? 0) > 0)
			add('review-high', (r.reviewAxes ?? []).sort().join('+') || 'review', r, 'review rounds with Critical or High findings');
		if ((r.qaAttempts ?? 0) > 2) add('qa-retries', r.kind ?? 'any', r, 'more than two QA attempts');
	}
	return [...groups.values()]
		.filter((g) => g.tickets.size >= min)
		.map((g) => ({ kind: g.kind, key: g.key, count: g.tickets.size, tickets: [...g.tickets], sample: g.sample }))
		.sort((a, b) => b.count - a.count);
}

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) argv[i].startsWith('--') ? (out[argv[i].slice(2)] = argv[++i]) : out._.push(argv[i]);
	return out;
}

if (isMain(import.meta.url)) {
	const [cmd, ...rest] = process.argv.slice(2);
	const a = parseArgs(rest);
	if (cmd === 'ticket') {
		console.log(
			JSON.stringify(
				append(
					buildTicketRecord({
						worktree: a.worktree,
						env: a.env,
						costUsd: a.cost ? Number(a.cost) : null,
						durationS: a.duration ? Number(a.duration) : null,
						outcome: a.outcome,
					}),
				),
			),
		);
	} else if (cmd === 'pass') {
		const res = readJson(a['result-file']) ?? {};
		console.log(
			JSON.stringify(
				append({
					type: 'pass',
					at: new Date().toISOString(),
					startedAt: a.started,
					exit: Number(a.exit ?? 0),
					costUsd: res.total_cost_usd ?? null,
					durationMs: res.duration_ms ?? null,
					turns: res.num_turns ?? null,
					result:
						String(res.result ?? '')
							.split('\n')
							.filter((l) => l.startsWith('tick:'))
							.pop() ?? null,
				}),
			),
		);
	} else if (cmd === 'learnings') {
		const text = fs.readFileSync(path.join(a.worktree, '.dev-factory', 'learnings.md'), 'utf8');
		const rows = parseLearnings(text)
			.filter((e) => e.scope)
			.map((e) => ({ at: new Date().toISOString(), key: a.key, scope: e.scope, text: e.text }));
		fs.mkdirSync(path.dirname(learningsIndex()), { recursive: true });
		for (const r of rows) fs.appendFileSync(learningsIndex(), JSON.stringify(r) + '\n');
		console.log(JSON.stringify({ indexed: rows.length }));
	} else if (cmd === 'preload') {
		const f = learningsIndex();
		const entries = fs.existsSync(f)
			? fs
					.readFileSync(f, 'utf8')
					.split('\n')
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
		console.log(preload({ entries, ticketText: fs.readFileSync(a['text-file'], 'utf8') }).join('\n'));
	} else if (cmd === 'clusters') {
		console.log(JSON.stringify(clusters(readRuns(runsFile(), a.since), Number(a.min ?? 2)), null, 2));
	} else {
		console.error('usage: run-record.mjs ticket|pass|clusters');
		process.exit(3);
	}
}
