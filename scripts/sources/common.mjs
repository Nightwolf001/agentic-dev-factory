// What every task source shares. A task is normalised to
//   { key, title, state, updated, labels, type, blockedBy: [{ key, done }] }
// where state is one of STATES (the source's own status names are mapped by `sources.<name>.states` in config.json).
import { createHash } from 'node:crypto';

export const STATES = ['ready', 'inProgress', 'inReview', 'reviewed', 'done'];
export const KEY_RE = /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/;

export const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// Logical state of a native status name, or 'other' when the source's status is not one the factory knows.
export function stateOf(nativeName, states) {
	const lower = String(nativeName ?? '').toLowerCase();
	for (const s of STATES) if (asList(states[s]).some((n) => String(n).toLowerCase() === lower)) return s;
	return 'other';
}

// "Blocked by: KEY, #12, https://github.com/o/r/issues/12" inline, or a "Blocked by" heading followed by a list.
// Returns bare references as written; normaliseRef turns them into keys.
export function parseBlockedBy(text) {
	const refs = [];
	const lines = String(text ?? '').split(/\r?\n/);
	let inSection = false;
	for (const line of lines) {
		const inline = /^\s*(?:[-*+]\s*)?(?:\*\*|__)?\s*blocked by\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i.exec(line);
		if (inline) {
			inSection = !inline[1].trim();
			if (inline[1].trim()) refs.push(...splitRefs(inline[1]));
			continue;
		}
		const heading = /^\s*(?:#{1,6}\s*|h[1-6]\.\s*|\*\*|__)\s*blocked by\s*(?:\*\*|__)?\s*:?\s*$/i.exec(line);
		if (heading) {
			inSection = true;
			continue;
		}
		if (inSection) {
			if (!line.trim()) continue;
			if (/^\s*(#{1,6}\s|h[1-6]\.\s|\*\*[^*]+\*\*\s*:?\s*$)/.test(line) || /^[A-Za-z][A-Za-z ]{1,40}:\s*\S/.test(line)) inSection = false;
			else if (/^\s*[-*+\d]/.test(line)) refs.push(...splitRefs(line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '')));
			else inSection = false;
		}
	}
	return [...new Set(refs)];
}

function splitRefs(text) {
	const out = [];
	for (const m of text.matchAll(/https?:\/\/[^\s)>,]+\/issues\/(\d+)|#(\d+)|\b([A-Za-z][A-Za-z0-9]*-\d+)\b/g)) out.push(m[0]);
	return out;
}

// A reference as it appears in a description to a task key: #12 and issue URLs belong to the GitHub prefix.
export function normaliseRef(ref, githubPrefix = 'GH') {
	let m = /\/issues\/(\d+)$/.exec(ref) || /^#(\d+)$/.exec(ref);
	if (m) return `${githubPrefix}-${m[1]}`;
	return KEY_RE.test(ref) ? ref.toUpperCase() : null;
}

// A task is buildable unless something that blocks it is not done yet.
export const isBuildable = (task) => !(task.blockedBy ?? []).some((b) => !b.done);

export function fingerprintOf(tasks) {
	const rows = tasks.map((t) => `${t.key}|${t.state}|${t.updated}`).sort();
	return createHash('sha1').update(rows.join('\n')).digest('hex');
}

export const minutesSince = (iso, now = Date.now()) => (now - Date.parse(iso)) / 60000;

// Whether a task passes a list filter ({ states, staleMinutes }); adapters push what they can into the query and
// rely on this for the rest.
export function matches(task, { states, staleMinutes } = {}, now = Date.now()) {
	if (states && !states.includes(task.state)) return false;
	if (staleMinutes != null && !(minutesSince(task.updated, now) >= staleMinutes)) return false;
	return true;
}
