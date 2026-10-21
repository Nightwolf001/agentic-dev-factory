// Detects raw telemetry or personal data that must never reach a file, a PR body or a Jira comment.
// Pattern based: it reduces the chance of copying something sensitive, it does not remove the need
// to keep outputs aggregate-only. Pure functions so they are unit-tested.
const BUILTIN = [
	['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
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
