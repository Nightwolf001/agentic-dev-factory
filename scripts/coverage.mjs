// The tests and coverage of a change, for the PR and the reviewer.
//
//   coverage.mjs record-tests --kind unit|functional --tests N [--suites N] [--failed N] [--command CMD]
//                    the builder reports the counts from the run it did; they are kept in .dev-factory/coverage/tests.json
//                    and shown as reported, not as verified
//   coverage.mjs report [--base REF] [--lcov FILE] [--json]
//                    of the lines the change added, how many a test run reached (from the lcov file), and which it did not
//
// Settings: coverage.command (what produces the lcov file, run in the environment), coverage.lcovPath, coverage.unitGlobs,
// coverage.functionalGlobs (which changed files count as unit and functional tests).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { baseFor, repoRoot } from '../bin/qa.mjs';
import { get, load } from './config.mjs';
import { report, summary } from './coverage-lib.mjs';
import { isMain } from './is-main.mjs';
import { workRoot } from './run-context.mjs';

const testsFile = (root) => path.join(root, '.dev-factory', 'coverage', 'tests.json');
export const readTests = (root) => {
	try {
		return JSON.parse(fs.readFileSync(testsFile(root), 'utf8'));
	} catch {
		return null;
	}
};

const count = (v, name) => {
	if (v === undefined) return null;
	const n = Number(v);
	if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number`);
	return n;
};

export function recordTests({ root, kind, tests, suites, failed, command, now = new Date() }) {
	if (!['unit', 'functional'].includes(kind)) throw new Error('--kind must be unit or functional');
	const entry = {
		tests: count(tests, 'tests'),
		suites: count(suites, 'suites'),
		failed: count(failed, 'failed') ?? 0,
		command: command ? String(command).slice(0, 200) : null,
		at: now.toISOString(),
	};
	if (entry.tests == null) throw new Error('--tests is required: the number of tests the run executed');
	const all = readTests(root) ?? {};
	all[kind] = entry;
	fs.mkdirSync(path.dirname(testsFile(root)), { recursive: true });
	fs.writeFileSync(testsFile(root), JSON.stringify(all, null, 2) + '\n');
	return all;
}

export function build({ root, base, lcov, cfg = load() }) {
	const diff = execFileSync('git', ['diff', '-U0', '--no-color', '--no-ext-diff', `${base}...HEAD`], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 256 << 20,
	});
	const lcovPath = lcov ?? get('coverage.lcovPath', { config: cfg }) ?? 'coverage/lcov.info';
	const abs = path.resolve(root, lcovPath);
	return report({
		diff,
		lcovText: fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null,
		root,
		lcovPath,
		unitGlobs: get('coverage.unitGlobs', { config: cfg }) ?? [],
		functionalGlobs: get('coverage.functionalGlobs', { config: cfg }) ?? [],
		tests: readTests(root),
	});
}

if (isMain(import.meta.url)) {
	const argv = process.argv.slice(2);
	const val = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
	try {
		const root = val('worktree') ? repoRoot(path.resolve(val('worktree'))) : workRoot({ cwd: process.cwd() });
		if (argv[0] === 'record-tests') {
			console.log(
				JSON.stringify(
					recordTests({
						root,
						kind: val('kind'),
						tests: val('tests'),
						suites: val('suites'),
						failed: val('failed'),
						command: val('command'),
					}),
					null,
					2,
				),
			);
		} else if (argv[0] === 'report') {
			const r = build({ root, base: val('base') ?? baseFor(root), lcov: val('lcov') });
			console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : summary(r));
		} else throw new Error('usage: coverage.mjs record-tests --kind unit|functional --tests N ... | report [--base REF] [--lcov FILE] [--json]');
	} catch (e) {
		console.error(`coverage: ${e.message}`);
		process.exit(1);
	}
}
