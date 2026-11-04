import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { COMMANDS } from '../scripts/cli.mjs';
import { anchors } from './patterns.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const docs = () =>
	execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '*.md'], { encoding: 'utf8' })
		.split('\0')
		.filter(Boolean)
		.filter((f) => f !== 'docs/fork-improvements-to-port.md' && fs.existsSync(path.join(ROOT, f)));
const text = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
// markdown without fenced code, so a shell example is not read as prose
const noFences = (t) => t.replace(/^```[\s\S]*?^```/gm, '');

test('every `dev-factory <x>` command the documentation shows is a real subcommand', () => {
	const known = new Set([...Object.keys(COMMANDS), 'path']);
	const bad = [];
	for (const f of docs()) {
		// a command is shown in code: in backticks or in a fenced block. "the dev-factory flow" in a sentence is the product's name.
		const code = [...text(f).matchAll(/`([^`\n]*)`/g)].map((m) => m[1]).concat(text(f).match(/^```[\s\S]*?^```/gm) ?? []);
		// `dev-factory fix` is the phrase of a fix comment (tasks.fixComment), and an error message quotes the product's name
		for (const span of code)
			for (const m of span.matchAll(/(?<![\w/.-])dev-factory ([a-z][a-z-]*)\b(?!\.json|\.config|\.qa)/g))
				if (!known.has(m[1]) && !['fix', 'plugin'].includes(m[1])) bad.push(`${f}: dev-factory ${m[1]}`);
	}
	assert.deepEqual(bad, []);
	for (const c of ['doctor', 'install', 'update', 'import-env', 'tick', 'scheduler', 'cleanup', 'qa', 'config']) assert.ok(known.has(c), c);
});

test('the commands the README presents in code blocks run a real subcommand', () => {
	const known = new Set([...Object.keys(COMMANDS), 'path']);
	const readme = text('README.md');
	const bad = [];
	for (const block of readme.match(/^```(?:bash|sh)?\n[\s\S]*?^```/gm) ?? [])
		for (const line of block.split('\n')) {
			const m = /^\s*(?:\$ )?dev-factory ([a-z][a-z-]*)/.exec(line);
			if (m && !known.has(m[1])) bad.push(line.trim());
		}
	assert.deepEqual(bad, []);
});

test('relative links and anchors in the documentation resolve', () => {
	const bad = [];
	for (const f of docs()) {
		const t = noFences(text(f)).replace(/`[^`\n]*`/g, ''); // a link inside code is an example, not a link
		const own = anchors(t);
		for (const m of t.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
			const href = m[1];
			if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // https:, mailto:
			const [file, anchor] = href.split('#');
			let target = f;
			if (file) {
				target = path.normalize(path.join(path.dirname(f), file));
				if (!fs.existsSync(path.join(ROOT, target))) {
					bad.push(`${f}: ${href} (no such file)`);
					continue;
				}
			}
			if (anchor && target.endsWith('.md')) {
				const set = target === f ? own : anchors(noFences(text(target)));
				if (!set.has(anchor.toLowerCase())) bad.push(`${f}: ${href} (no such heading)`);
			}
		}
	}
	assert.deepEqual(bad, []);
});

test('the contributor guide keeps the sections a new contributor needs, and its commands are the real checks', () => {
	const t = text('CONTRIBUTING.md');
	for (const h of ['## The loop', '## The checks', '## Rules that are easy to break', '## Versions']) assert.ok(t.includes(h), h);
	for (const cmd of ['node --test test/*.test.mjs', 'prettier@3.2.5 --check', 'bash scripts/lint-vocabulary.sh', 'claude plugin validate .'])
		assert.ok(t.includes(cmd), cmd);
	assert.match(t, /AGENTS\.md/);
	assert.match(text('AGENTS.md'), /npx prettier@3\.2\.5 --check/);
});

test('the README names every script a command or skill tells an agent to run, and every one exists', () => {
	const missing = [];
	for (const f of docs().filter((d) => /^(commands|skills|agents)\//.test(d))) {
		for (const m of text(f).matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/((?:scripts|bin)\/[\w.-]+)/g))
			if (!fs.existsSync(path.join(ROOT, m[1]))) missing.push(`${f}: ${m[1]}`);
	}
	assert.deepEqual(missing, []);
});
