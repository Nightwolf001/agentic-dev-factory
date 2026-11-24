// The pass's one wait for every task it is building at once: each worktree has a phase it is waiting on, and the wait ends as soon
// as any of them has handed off, so one task's review never waits for another task's build.
//
//   handoff.mjs wait --for <worktree>=<phase> [--for ...] [--seconds 540] [--interval 5]
//        <phase> is build, ship, review:<axis>, debug:<recorded before> or research:<KEY>. Prints one JSON line per worktree that
//        has handed off, {"worktree","phase","result"}, and exits 0; prints STILL_WAITING and exits 10 when none has within the
//        time. The results, in the order they win:
//          blocked       .dev-factory/blocked.json exists (always first: a block is never hidden by a hand-off)
//          needs_debug   (build) .dev-factory/needs_debug.json exists
//          done          build: build.done exists and `qa.mjs build-ready` accepts it; ship: ship.done; review:<axis>: the record
//                        .dev-factory/review/<HEAD>-<axis>.json; debug:<n>: more than n rounds recorded in .dev-factory/debug/;
//                        research:<KEY>: docs/plans/<KEY>/research.md
//   handoff.mjs check --for ...  the same, once, without waiting (exit 10 when none has handed off)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseFor(text) {
	const at = String(text ?? '').lastIndexOf('=');
	if (at <= 0) return null;
	const worktree = text.slice(0, at);
	const phase = text.slice(at + 1);
	if (!/^(build|ship|review:[a-z]+|debug:[0-9]+|research:[A-Za-z][A-Za-z0-9_]*-[0-9]+)$/.test(phase)) return null;
	return { worktree: path.resolve(worktree), phase };
}

const buildReady = (worktree) =>
	spawnSync(process.execPath, [path.join(ROOT, 'bin', 'qa.mjs'), 'build-ready', '--worktree', worktree], { stdio: 'ignore' }).status === 0;

const head = (worktree) => {
	const r = spawnSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
	return r.status === 0 ? r.stdout.trim() : null;
};

const recordedRounds = (dir) => {
	let n = 0;
	try {
		for (const f of fs.readdirSync(dir))
			if (f.endsWith('.json'))
				try {
					if (/"status": "recorded"/.test(fs.readFileSync(path.join(dir, f), 'utf8'))) n++;
				} catch {
					/* being written */
				}
	} catch {
		/* no rounds yet */
	}
	return n;
};

// -> 'blocked' | 'needs_debug' | 'done' | null
export function handedOff({ worktree, phase }, { ready = buildReady, headOf = head } = {}) {
	const run = path.join(worktree, '.dev-factory');
	const has = (f) => fs.existsSync(path.join(run, f));
	if (has('blocked.json')) return 'blocked';
	const [kind, arg] = phase.split(':');
	if (kind === 'build') {
		if (has('needs_debug.json')) return 'needs_debug';
		return has('build.done') && ready(worktree) ? 'done' : null;
	}
	if (kind === 'ship') return has('ship.done') ? 'done' : null;
	if (kind === 'review') {
		const h = headOf(worktree);
		return h && has(path.join('review', `${h}-${arg}.json`)) ? 'done' : null;
	}
	if (kind === 'debug') return recordedRounds(path.join(run, 'debug')) > Number(arg) ? 'done' : null;
	if (kind === 'research') return fs.existsSync(path.join(worktree, 'docs', 'plans', arg, 'research.md')) ? 'done' : null;
	return null;
}

export function checkAll(items, opts) {
	const out = [];
	for (const it of items) {
		const result = handedOff(it, opts);
		if (result) out.push({ worktree: it.worktree, phase: it.phase, result });
	}
	return out;
}

export async function waitAny(items, { seconds = 540, interval = 5, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...opts } = {}) {
	const end = Date.now() + seconds * 1000;
	for (;;) {
		const out = checkAll(items, opts);
		if (out.length || Date.now() >= end) return out;
		await sleep(interval * 1000);
	}
}

if (isMain(import.meta.url)) {
	const [cmd, ...argv] = process.argv.slice(2);
	const items = [];
	let seconds = 540;
	let interval = 5;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--for') {
			const it = parseFor(argv[++i]);
			if (!it) {
				console.error(`handoff: --for wants <worktree>=<phase> (build, ship, review:<axis>, debug:<n>, research:<KEY>), got ${argv[i]}`);
				process.exit(3);
			}
			items.push(it);
		} else if (argv[i] === '--seconds') seconds = Number(argv[++i]);
		else if (argv[i] === '--interval') interval = Number(argv[++i]);
		else {
			console.error(`handoff: unknown argument ${argv[i]}`);
			process.exit(3);
		}
	}
	if (!['wait', 'check'].includes(cmd) || !items.length) {
		console.error('usage: handoff.mjs wait|check --for <worktree>=<phase> [--for ...] [--seconds 540] [--interval 5]');
		process.exit(3);
	}
	const out = cmd === 'check' ? checkAll(items) : await waitAny(items, { seconds, interval });
	if (!out.length) {
		console.log('STILL_WAITING');
		process.exit(10);
	}
	for (const o of out) console.log(JSON.stringify(o));
}
