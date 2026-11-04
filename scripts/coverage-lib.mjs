// What the tests of a change reached. A coverage percentage for the whole repository says nothing about this change, so the
// report is about the lines the change added: of those, how many a test run executed. Pure functions over lcov text and
// `git diff -U0` text, so they are unit-tested.
import { globToRegExp } from './env-build-files.mjs';

// lcov: SF:<file>, DA:<line>,<hits> ..., end_of_record -> Map(file -> Map(line -> hits))
export function parseLcov(text) {
	const files = new Map();
	let cur = null;
	for (const raw of String(text).split('\n')) {
		const line = raw.trim();
		if (line.startsWith('SF:')) {
			const f = line.slice(3);
			cur = files.get(f) ?? new Map();
			files.set(f, cur);
		} else if (line.startsWith('DA:') && cur) {
			const [n, hits] = line.slice(3).split(',');
			const ln = Number(n);
			if (Number.isInteger(ln) && ln > 0) cur.set(ln, Math.max(cur.get(ln) ?? 0, Number(hits) || 0));
		} else if (line === 'end_of_record') cur = null;
	}
	return files;
}

// A path as git prints it in a diff header: a name with unusual characters is quoted, with C escapes and octal bytes ("b/\303\274.js").
function unquotePath(p) {
	if (!(p.startsWith('"') && p.endsWith('"') && p.length >= 2)) return p;
	const bytes = [];
	const text = p.slice(1, -1);
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c !== '\\') bytes.push(...Buffer.from(c));
		else {
			const oct = /^[0-7]{1,3}/.exec(text.slice(i + 1));
			if (oct) {
				bytes.push(parseInt(oct[0], 8));
				i += oct[0].length;
			} else {
				const e = text[++i];
				bytes.push(...Buffer.from({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[e] ?? e ?? ''));
			}
		}
	}
	return Buffer.from(bytes).toString('utf8');
}

// `git diff -U0` -> Map(file -> Set(line)) of the lines the change added. A line inside a hunk is counted by the hunk's own
// lengths, so an added line that reads "++ x" (shown as "+++ x") is not taken for the next file's header.
export function addedLines(diffText) {
	const out = new Map();
	let file = null;
	let oldLeft = 0;
	let newLeft = 0;
	for (const line of String(diffText).split('\n')) {
		if (oldLeft > 0 || newLeft > 0) {
			if (line.startsWith('+')) newLeft--;
			else if (line.startsWith('-')) oldLeft--;
			else if (line.startsWith(' ')) {
				oldLeft--;
				newLeft--;
			}
			continue;
		}
		if (line.startsWith('+++ ')) {
			const p = unquotePath(line.slice(4).replace(/\t.*$/, '').trim());
			file = p === '/dev/null' ? null : p.replace(/^b\//, '');
			if (file && !out.has(file)) out.set(file, new Set());
		} else if (line.startsWith('@@') && file) {
			const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (!m) continue;
			const start = Number(m[2]);
			const count = m[3] === undefined ? 1 : Number(m[3]);
			oldLeft = m[1] === undefined ? 1 : Number(m[1]);
			newLeft = count;
			for (let i = 0; i < count; i++) out.get(file).add(start + i);
		}
	}
	for (const [f, set] of out) if (!set.size) out.delete(f);
	return out;
}

const strip = (p, root) => {
	let q = p.replace(/\\/g, '/');
	if (root && q.startsWith(root.replace(/\/$/, '') + '/')) q = q.slice(root.replace(/\/$/, '').length + 1);
	return q.replace(/^\.\//, '');
};

// The lcov entry for a repository file: the same path, else the longest one that is a path suffix of it (lcov written relative to
// a package folder) or of which it is a suffix. null when the file is not in the data.
export function lcovEntryFor(file, lcov, root) {
	let best = null;
	for (const key of lcov.keys()) {
		const k = strip(key, root);
		if (k === file) return key;
		if ((file.endsWith('/' + k) || k.endsWith('/' + file)) && (!best || k.length > strip(best, root).length)) best = key;
	}
	return best;
}

// -> compact ranges: [3,4,5,9] -> "3-5, 9"
export const ranges = (lines) => {
	const out = [];
	for (let i = 0; i < lines.length; ) {
		let j = i;
		while (lines[j + 1] === lines[j] + 1) j++;
		out.push(j > i ? `${lines[i]}-${lines[j]}` : String(lines[i]));
		i = j + 1;
	}
	return out.join(', ');
};

export function classifyTestFile(file, { unitGlobs = [], functionalGlobs = [] } = {}) {
	if (functionalGlobs.map(globToRegExp).some((re) => re.test(file))) return 'functional';
	if (unitGlobs.map(globToRegExp).some((re) => re.test(file))) return 'unit';
	return null;
}

export function report({ diff, lcovText, root = '', lcovPath = 'coverage/lcov.info', unitGlobs = [], functionalGlobs = [], tests = null }) {
	const changed = addedLines(diff);
	const lcov = lcovText == null ? null : parseLcov(lcovText);
	const changedTests = { unit: 0, functional: 0 };
	for (const f of changed.keys()) {
		const k = classifyTestFile(f, { unitGlobs, functionalGlobs });
		if (k) changedTests[k]++;
	}
	const files = [];
	const notInLcov = [];
	const totals = { changed: 0, instrumented: 0, reached: 0 };
	for (const [file, lines] of changed) {
		totals.changed += lines.size;
		const entry = lcov ? lcovEntryFor(file, lcov, root) : null;
		if (!entry) {
			notInLcov.push(file);
			continue;
		}
		const da = lcov.get(entry);
		const exec = [...lines].filter((l) => da.has(l)).sort((a, b) => a - b);
		const reached = exec.filter((l) => da.get(l) > 0);
		const missing = exec.filter((l) => da.get(l) === 0);
		totals.instrumented += exec.length;
		totals.reached += reached.length;
		files.push({ file, changed: lines.size, instrumented: exec.length, reached: reached.length, missing: ranges(missing) });
	}
	totals.pct = totals.instrumented ? Math.round((totals.reached / totals.instrumented) * 1000) / 10 : null;
	let note = null;
	if (!changed.size) note = 'the change adds no lines, so there is nothing to measure';
	else if (lcovText == null)
		note = `no coverage data was found at ${lcovPath}: run the coverage command first (coverage.command), or check coverage.lcovPath`;
	else if (!files.length)
		note = `none of the ${changed.size} changed file${changed.size === 1 ? '' : 's'} is in the coverage data (${lcovPath}): this report says nothing about the change. Either the tests were not run with coverage over these files, or the paths in the data are not these paths`;
	else if (!totals.instrumented)
		note = 'the changed lines are not executable code (comments, blank lines, types), so there is nothing a test could reach';
	return { files, notInLcov, totals, changedTests, tests, note };
}

export function summary(r) {
	const out = [];
	if (r.tests?.unit || r.tests?.functional)
		for (const k of ['unit', 'functional'])
			if (r.tests[k])
				out.push(
					`${k} tests: ${r.tests[k].tests ?? '?'} in ${r.tests[k].suites ?? '?'} suite(s), ${r.tests[k].failed ?? 0} failed (reported by the builder)`,
				);
	out.push(`test files changed: ${r.changedTests.unit} unit, ${r.changedTests.functional} functional`);
	if (r.note) out.push(r.note);
	if (r.totals.instrumented) {
		out.push(`changed lines reached by a test run: ${r.totals.reached} of ${r.totals.instrumented} executable (${r.totals.pct}%)`);
		for (const f of r.files) if (f.missing) out.push(`  ${f.file}: ${f.reached}/${f.instrumented}, not reached: ${f.missing}`);
	}
	if (r.notInLcov.length && r.files.length) out.push(`not in the coverage data: ${r.notInLcov.join(', ')}`);
	return out.join('\n');
}
