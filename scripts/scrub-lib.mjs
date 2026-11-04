// Detects raw telemetry or personal data that must never reach a file, a PR body or a task comment.
// Pattern based: it reduces the chance of copying something sensitive, it does not remove the need
// to keep outputs aggregate-only. Pure functions so they are unit-tested.
const BUILTIN = [
	// anchored: a match can only start where a run of address characters starts, and the parts are bounded. Without that, a
	// 64 KB line of minified code with no @ in it was scanned from every position to its end and took seconds.
	['email address', /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,128}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/],
	['phone number', /(?<![\w.])(?<!\brun[=:]\s*)\+?\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}(?![\w.])/],
	['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/],
	['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/i],
	// Device ids and tokens are long hex. A git object id (exactly 40 hex) and an identifier carrying its own label
	// (head=, sha256:, commit, fingerprint, run=) are the factory's own bookkeeping and stay allowed.
	['long hex identifier', /(?<!\b(?:head|sha\d*|commit|fingerprint|run)[=:\s]\s*)\b(?![0-9a-fA-F]{40}\b)[0-9a-fA-F]{16,}\b/i],
	['API key', /\b(sk|pk|xox[abp]|ghp|gho|ghs)[-_][A-Za-z0-9_-]{16,}\b/],
];

// Returns [{rule, line, sample}] with the sample masked so the finding itself does not leak the value.
export function scrubFindings(text, extraPatterns = []) {
	const rules = [...BUILTIN];
	for (const p of extraPatterns) rules.push([`configured pattern ${p}`, new RegExp(p)]);
	const found = [];
	text.split('\n').forEach((line, i) => {
		for (const [rule, re] of rules) {
			const m = line.match(re);
			if (m) found.push({ rule, line: i + 1, sample: mask(m[0]) });
		}
	});
	return found;
}

export function mask(s) {
	return s.length <= 6 ? '***' : `${s.slice(0, 2)}***${s.slice(-2)}`;
}

// ---- redaction ----
// A log, a response body or a diff hunk that is kept as evidence is not refused for holding a finding (as a comment or PR
// body is): the finding is replaced and the rest is kept. Every finding on a line becomes `[redacted:<rule>]`, overlapping
// findings are merged into one span, and `secrets` are literal strings (a test account's password) that are removed
// wherever they appear, whatever they look like.
//
// It works line by line. What it cannot catch: a secret split across lines (a PEM private key's body, a value wrapped by a
// log formatter) and a value that looks like nothing (a password in a JSON field: `"password": "hunter2"`). Keep such
// output out of evidence, or pass the value in `secrets`.
function spansOf(line, rules) {
	const spans = [];
	for (const [rule, re] of rules) {
		const g = re.global ? re : new RegExp(re.source, re.flags + 'g');
		g.lastIndex = 0;
		for (const m of line.matchAll(g)) {
			if (!m[0]) continue;
			spans.push({ start: m.index, end: m.index + m[0].length, rule });
		}
	}
	return spans;
}

export function mergeSpans(spans) {
	const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
	const out = [];
	for (const s of sorted) {
		const last = out[out.length - 1];
		if (last && s.start <= last.end) {
			if (s.end > last.end) last.end = s.end;
			if (!last.rules.includes(s.rule)) last.rules.push(s.rule);
		} else out.push({ start: s.start, end: s.end, rules: [s.rule] });
	}
	return out;
}

export function redactText(text, { extraPatterns = [], secrets = [] } = {}) {
	const rules = [...BUILTIN];
	for (const p of extraPatterns) rules.push([`configured pattern`, new RegExp(p)]);
	const literal = secrets.filter((x) => typeof x === 'string' && x.length >= 3);
	let count = 0;
	const out = String(text)
		.split('\n')
		.map((line) => {
			const spans = spansOf(line, rules);
			for (const sec of literal) {
				for (let at = line.indexOf(sec); at >= 0; at = line.indexOf(sec, at + sec.length))
					spans.push({ start: at, end: at + sec.length, rule: 'secret' });
			}
			if (!spans.length) return line;
			let res = '';
			let pos = 0;
			for (const m of mergeSpans(spans)) {
				res += line.slice(pos, m.start) + `[redacted:${m.rules[0]}]`;
				pos = m.end;
				count++;
			}
			return res + line.slice(pos);
		})
		.join('\n');
	return { text: out, redactions: count };
}
