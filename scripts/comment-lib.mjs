// The comments the factory leaves for people, and the replies people leave back. Pure functions over comment text, so they are
// unit-tested and work for any tracker.
//
// A human-facing comment is short and tags the people who need to see it:
//
//   @assignee @reporter                          <- who is asked (assignee first, then reporter, nobody twice)
//
//   One paragraph of at most 280 characters.     <- what happened or what is asked, in plain words
//
//   [dev-factory] blocked: question              <- the marker line, always last: the machine-readable part
//
// The marker line is how the factory finds its own comments again (a person's answer is a comment with no marker line after the
// question's), so text that came from outside is defanged: a task title or a person's words cannot forge one.
export const MARK = '[dev-factory]';
export const KINDS = ['phase', 'question', 'factory', 'summary', 'coverage', 'evidence'];
export const MAX_PARAGRAPH = 280;

// kind -> the words after `[dev-factory] ` on the marker line
const MARKER = {
	phase: 'phase',
	question: 'blocked: question',
	factory: 'blocked: factory',
	summary: 'summary',
	coverage: 'coverage',
	evidence: 'evidence',
};

// Any spelling of the marker inside untrusted text becomes a look-alike that no parser reads
export const defang = (text) => String(text ?? '').replace(/\[\s*dev-factory\s*\]/gi, '‹dev-factory›');

const oneLine = (t) => defang(t).replace(/\s+/g, ' ').trim();

// One paragraph: line breaks and runs of spaces collapsed, cut at a word boundary with an ellipsis when over the limit
export function paragraph(text, max = MAX_PARAGRAPH) {
	const t = oneLine(text);
	if (t.length <= max) return t;
	const cut = t.slice(0, max - 1);
	const at = cut.lastIndexOf(' ');
	return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

// Assignee first, then reporter, nobody twice. A person is a tag string ("@jane", "[~accountid:abc]") or { tag }.
export function tagLine(...people) {
	const seen = new Set();
	const out = [];
	for (const p of people) {
		const tag = typeof p === 'string' ? p.trim() : p?.tag?.trim();
		if (!tag || seen.has(tag.toLowerCase())) continue;
		seen.add(tag.toLowerCase());
		out.push(tag);
	}
	return out.join(' ');
}

export function markerLine(kind, detail = '') {
	if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
	const d = oneLine(detail).slice(0, 120);
	return `${MARK} ${MARKER[kind]}${d ? (kind === 'question' || kind === 'factory' ? ` ${d}` : `: ${d}`) : ''}`.replace(/: $/, '');
}

export function compose({ kind, text, detail = '', assignee = null, reporter = null }) {
	const tags = tagLine(assignee, reporter);
	const body = paragraph(text);
	if (!body) throw new Error('a comment needs some text');
	return [tags, body, markerLine(kind, detail)].filter(Boolean).join('\n\n');
}

// The same comment as an Atlassian Document Format document, with real mention nodes for the people tagged. A wiki token such as
// [~accountid:abc] written into a comment through an MCP server can arrive as literal text; a mention node always notifies.
// people: [{ id, name }]
export function composeAdf({ kind, text, detail = '', people = [] }) {
	const body = paragraph(text);
	if (!body) throw new Error('a comment needs some text');
	const seen = new Set();
	const mentions = [];
	for (const p of people) {
		if (!p?.id || seen.has(p.id)) continue;
		seen.add(p.id);
		if (mentions.length) mentions.push({ type: 'text', text: ' ' });
		mentions.push({ type: 'mention', attrs: { id: p.id, text: `@${p.name ?? p.id}` } });
	}
	const content = [];
	if (mentions.length) content.push({ type: 'paragraph', content: mentions });
	content.push({ type: 'paragraph', content: [{ type: 'text', text: body }] });
	content.push({ type: 'paragraph', content: [{ type: 'text', text: markerLine(kind, detail) }] });
	return { version: 1, type: 'doc', content };
}

// ---- reading comments back ----

// The factory's marker on a comment: the last line that starts with it. -> { name, rest, key } or null.
export function markerOf(body) {
	const lines = String(body ?? '').split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = /^\s*\[dev-factory\]\s+([a-z][a-z-]*)\s*(?::\s*(.*))?$/i.exec(lines[i]);
		if (!m) continue;
		const name = m[1].toLowerCase();
		const rest = (m[2] ?? '').trim();
		const first =
			rest
				.split(/\s+/)[0]
				?.toLowerCase()
				.replace(/[^a-z-]/g, '') ?? '';
		return { name, rest, key: name === 'blocked' && first ? `blocked:${first}` : name };
	}
	return null;
}

// comments: [{ id, author, created, body }] oldest first. The newest question the factory asked, and the comments a person wrote
// after it that carry no marker line (a quoted marker line starts with ">" and does not count as one). A later `blocked: factory`
// marker withdraws the question; a marker comment after a reply means the reply was already taken up, so only what follows the
// last marker counts.
export function findReplies(comments) {
	const list = comments ?? [];
	let q = -1;
	for (let i = list.length - 1; i >= 0; i--) {
		if (markerOf(list[i].body)?.key === 'blocked:question') {
			q = i;
			break;
		}
	}
	if (q < 0) return { question: null, replies: [], cancelled: false };
	let last = q;
	let cancelled = false;
	for (let i = q + 1; i < list.length; i++) {
		const m = markerOf(list[i].body);
		if (!m) continue;
		last = i;
		if (m.key === 'blocked:factory') cancelled = true;
	}
	const replies = cancelled ? [] : list.slice(last + 1).filter((c) => String(c.body ?? '').trim());
	return { question: list[q], replies, cancelled };
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A comment asks for a fix pass when a line starts with the fix phrase as a whole word ("fixed" and "fix-up" do not count)
export const isFixLine = (body, fixComment = 'dev-factory fix') => {
	const phrase = String(fixComment ?? '').replace(/^\//, '');
	return !!phrase && new RegExp(`^\\s*/?${escapeRe(phrase)}(?![\\w-])`, 'im').test(String(body ?? ''));
};

// The fix request on a ticket: the newest comment with a fix line and no marker line of its own, while the PR is open and until
// a factory comment (any marker) follows it. -> the comment or null
export function findFixRequest(comments, { fixComment = 'dev-factory fix', prOpen = false } = {}) {
	if (!prOpen) return null;
	const list = comments ?? [];
	for (let i = list.length - 1; i >= 0; i--) {
		if (markerOf(list[i].body)) return null; // the factory spoke last, or after the request
		if (isFixLine(list[i].body, fixComment)) return list[i];
	}
	return null;
}
