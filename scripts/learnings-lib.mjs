// Learnings are short, scoped, and live in the PR body (a "## Learnings" section), never as files in the
// repository tree. The builder writes the section to .dev-factory/learnings.md, ship copies it into the PR body,
// and the weekly scan reads merged PR bodies. Pure functions, unit-tested.
export const MAX_ENTRIES = 3;
export const MAX_LESSON_CHARS = 300;
const SCOPE_RE = /^[A-Za-z0-9_.\/-]+$/;

// Entry shape:
//   - <lesson, one or two sentences>
//     scope: <path prefix the lesson concerns, "." for the whole repository>
export function parseLearnings(text) {
	const section = extractSection(text);
	const entries = [];
	let cur = null;
	for (const line of section.split('\n')) {
		const item = /^[-*]\s+(\S.*)$/.exec(line);
		const scope = /^\s+scope:\s*(\S+)\s*$/i.exec(line);
		if (item) entries.push((cur = { text: item[1].trim(), scope: null }));
		else if (scope && cur) cur.scope = scope[1];
	}
	return entries;
}

// The "## Learnings" section of a PR body, or the whole text when it has no such heading.
export function extractSection(text) {
	const m = /^#{2,3}\s+Learnings\s*$/im.exec(text);
	if (!m) return text;
	const rest = text.slice(m.index + m[0].length);
	const next = /^#{1,3}\s+\S/m.exec(rest);
	return next ? rest.slice(0, next.index) : rest;
}

export function lintLearnings(text) {
	const entries = parseLearnings(text);
	if (!entries.length) return ['no entries: write "- <lesson>" followed by an indented "scope: <path>" line'];
	const problems = [];
	if (entries.length > MAX_ENTRIES) problems.push(`at most ${MAX_ENTRIES} entries per ticket, found ${entries.length}`);
	entries.forEach((e, i) => {
		const n = `entry ${i + 1}`;
		if (e.text.length < 20) problems.push(`${n}: the lesson needs at least 20 characters`);
		if (e.text.length > MAX_LESSON_CHARS) problems.push(`${n}: the lesson is ${e.text.length} characters, the cap is ${MAX_LESSON_CHARS}`);
		if (!e.scope) problems.push(`${n}: missing the indented "scope:" line`);
		else if (!SCOPE_RE.test(e.scope) || e.scope.includes('..') || e.scope.startsWith('/'))
			problems.push(`${n}: scope must be a relative path prefix or "."`);
	});
	return problems;
}

// A learning is mandatory when a debug round happened or a review round found a Critical or High finding.
export function learningRequired({ debugRounds = 0, reviewCounts = [] }) {
	if (debugRounds > 0) return 'a debug round happened';
	if (reviewCounts.some((c) => (c.critical ?? 0) + (c.high ?? 0) > 0)) return 'a review round found a Critical or High finding';
	return null;
}

// ---- reading merged PRs -------------------------------------------------------------------------
const KEY_RE = /\[([A-Za-z]+-\d+)\]\s*$/;

// prs: [{ title, body, mergedAt, comments: [{body}] }] from `gh pr list --state merged --json ...`
export function entriesFromPrs(prs) {
	const out = [];
	for (const pr of prs) {
		const key = KEY_RE.exec(pr.title ?? '')?.[1];
		if (!key || !/^#{2,3}\s+Learnings\s*$/im.test(pr.body ?? '')) continue;
		const confirmed = (pr.comments ?? []).some((c) => /\/dev-factory promote/.test(c.body ?? ''));
		for (const e of parseLearnings(pr.body)) if (e.scope) out.push({ key, at: pr.mergedAt, scope: e.scope, text: e.text, confirmed });
	}
	return out;
}

const words = (s) =>
	new Set(
		s
			.toLowerCase()
			.replace(/[^a-z0-9 ]/g, ' ')
			.split(/\s+/)
			.filter((w) => w.length > 3),
	);
const jaccard = (a, b) => {
	const i = [...a].filter((w) => b.has(w)).length;
	return a.size + b.size - i === 0 ? 0 : i / (a.size + b.size - i);
};
const related = (a, b) => (a.scope.startsWith(b.scope) || b.scope.startsWith(a.scope)) && jaccard(words(a.text), words(b.text)) >= 0.3;

// Promotion candidates: the same lesson on at least `min` different tickets, or one a person confirmed with
// "/dev-factory promote" on the PR. Each candidate carries the narrowest scope among its entries.
export function promotionCandidates(entries, min = 2) {
	const groups = [];
	for (const e of entries) {
		const g = groups.find((x) => x.entries.some((y) => related(y, e)));
		if (g) g.entries.push(e);
		else groups.push({ entries: [e] });
	}
	return groups
		.map((g) => {
			const keys = [...new Set(g.entries.map((e) => e.key))];
			const scope = g.entries.map((e) => e.scope).sort((a, b) => b.length - a.length)[0];
			return { text: g.entries[0].text, scope, tickets: keys, confirmed: g.entries.some((e) => e.confirmed) };
		})
		.filter((c) => c.tickets.length >= min || c.confirmed)
		.sort((a, b) => b.tickets.length - a.tickets.length);
}

// ---- preload for a build --------------------------------------------------------------------------
const PATH_TOKEN = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*/g;

// The newest recorded learnings whose scope covers a path the ticket text mentions ("." covers everything),
// capped by count and by total characters so the preload stays small.
export function preload({ entries, ticketText, max = 5, maxChars = 1500 }) {
	const paths = [...(ticketText.match(PATH_TOKEN) ?? [])];
	const hit = (e) => e.scope === '.' || paths.some((p) => p.startsWith(e.scope) || e.scope.startsWith(p.replace(/\/$/, '')));
	const out = [];
	let used = 0;
	for (const e of [...entries].sort((a, b) => String(b.at).localeCompare(String(a.at)))) {
		if (!hit(e) || out.length >= max) continue;
		const line = `- ${e.text} (scope ${e.scope}, ${e.key})`;
		if (used + line.length > maxChars) break;
		out.push(line);
		used += line.length;
	}
	return out;
}
