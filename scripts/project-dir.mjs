// The per-repository folder `.devfactory/`: this repository's own factory settings and scratch QA cases. It carries
// its own .gitignore, so no one edits the project's .gitignore and nothing in it can be committed by accident.
// (`.factory/tasks/` of the local task source stays committed, and `.dev-factory/` is per-worktree run state; neither
// moves.) The files that used to sit at the repository root or in `.factory/` are still read for one release.
//
//   project-dir.mjs migrate [--apply]    list (or, with --apply, perform) the move of each old file into .devfactory/.
//                                        Prints `plan  <from> -> <to>` or `do  <from> -> <to>` per move, `skip  <from>: <reason>`
//                                        for one that cannot move, then the `git rm --cached` commands that stop git tracking the
//                                        old paths. The script runs no git write itself: a person runs those commands and commits.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './is-main.mjs';

export const PROJECT_DIR = '.devfactory';
export const PROJECT_FILES = {
	config: '.devfactory/config.json',
	qa: '.devfactory/qa.yaml',
	cases: '.devfactory/qa/cases',
	mcp: '.devfactory/mcp.json',
};
export const LEGACY_FILES = { config: 'dev-factory.config.json', qa: 'dev-factory.qa.yaml', cases: '.factory/qa/cases' };

const IGNORE_HEADER = '# written by dev-factory: this folder stays out of git';

// The nearest folder at or above `from` that holds `.git`, a folder or (in a worktree) a file. Null outside a repository.
export function projectRoot(from = process.cwd()) {
	let dir = path.resolve(from);
	for (;;) {
		if (fs.existsSync(path.join(dir, '.git'))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// Makes <root>/.devfactory/ and its .gitignore. An existing .gitignore is kept; it gains a `*` line only when it has none.
export function ensureProjectDir(root) {
	const dir = path.join(root, PROJECT_DIR);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, '.gitignore');
	if (!fs.existsSync(file)) {
		fs.writeFileSync(file, `${IGNORE_HEADER}\n*\n`);
		return dir;
	}
	const text = fs.readFileSync(file, 'utf8');
	if (!text.split(/\r?\n/).some((line) => line.trim() === '*'))
		fs.writeFileSync(file, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}*\n`);
	return dir;
}

function isTracked(root, rel) {
	try {
		return execFileSync('git', ['-C', root, 'ls-files', '--', rel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
	} catch {
		return false;
	}
}

// One entry per legacy path that exists, in the order config, qa, cases.
export function planMigration(root) {
	const moves = [];
	for (const key of ['config', 'qa', 'cases']) {
		const from = LEGACY_FILES[key];
		const to = PROJECT_FILES[key];
		if (!fs.existsSync(path.join(root, from))) continue;
		moves.push({ from, to, tracked: isTracked(root, from), conflict: fs.existsSync(path.join(root, to)) });
	}
	return moves;
}

const untrackCommand = (from) => `git rm -r --cached -- ${from}`;

// Renames each move that has no conflict. Runs no git write: `untrack` lists the commands for the tracked sources moved.
export function applyMigration(root, moves) {
	const moved = [];
	const skipped = [];
	const untrack = [];
	for (const m of moves) {
		const from = path.join(root, m.from);
		const to = path.join(root, m.to);
		if (m.conflict || fs.existsSync(to)) {
			skipped.push({ from: m.from, reason: `already exists: ${m.to}` });
			continue;
		}
		if (!fs.existsSync(from)) {
			skipped.push({ from: m.from, reason: 'not found' });
			continue;
		}
		ensureProjectDir(root);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.renameSync(from, to);
		moved.push(m.from);
		if (m.tracked) untrack.push(untrackCommand(m.from));
	}
	return { moved, skipped, untrack };
}

function main(argv) {
	if (argv[0] !== 'migrate') {
		console.error('usage: project-dir.mjs migrate [--apply]');
		return 2;
	}
	const root = projectRoot();
	if (!root) {
		console.error('project-dir: not inside a git repository');
		return 1;
	}
	const moves = planMigration(root);
	// the MCP servers of a legacy .mcp.json move separately: they belong in the settings, not in a folder
	const mcpReminder = () => {
		if (fs.existsSync(path.join(root, '.mcp.json')))
			console.log("note: .mcp.json is read for one more release: dev-factory mcp migrate moves the factory's own entries into the settings");
	};
	if (!argv.includes('--apply')) {
		for (const m of moves) {
			if (m.conflict) console.log(`skip  ${m.from}: already exists: ${m.to}`);
			else console.log(`plan  ${m.from} -> ${m.to}`);
		}
		for (const m of moves) if (m.tracked && !m.conflict) console.log(untrackCommand(m.from));
		mcpReminder();
		return 0;
	}
	const { moved, skipped, untrack } = applyMigration(root, moves);
	const to = new Map(moves.map((m) => [m.from, m.to]));
	for (const from of moved) console.log(`do  ${from} -> ${to.get(from)}`);
	for (const s of skipped) console.log(`skip  ${s.from}: ${s.reason}`);
	for (const cmd of untrack) console.log(cmd);
	mcpReminder();
	return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
