// Readiness lint for a task description, whichever tracker it lives in. Pure. A ticket the factory claims must say what done
// looks like; one written by /dev-factory:plan (strict) also names scope limits and how to test.
const SECTIONS = { acceptance: /acceptance criteria|^ac$/i, outOfScope: /out of scope/i, testing: /testing decisions|test plan|testing/i };
const HEADING = /^\s*(?:#{1,6}\s*|h[1-6]\.\s*|\*\*|__)?\s*([A-Za-z][A-Za-z \/-]{1,40}?)\s*(?:\*\*|__)?\s*:?\s*$/;

export function parseSections(text) {
	const sections = {};
	let current = null;
	for (const line of text.split(/\r?\n/)) {
		const m = HEADING.exec(line);
		const name = m && Object.keys(SECTIONS).find((k) => SECTIONS[k].test(m[1].trim()));
		if (name) {
			current = name;
			sections[current] = [];
			continue;
		}
		if (m && /^\s*(#{1,6}|h[1-6]\.|\*\*)/.test(line)) {
			current = null;
			continue;
		}
		if (current && line.trim()) sections[current].push(line.trim());
	}
	return sections;
}

const items = (lines = []) => lines.filter((l) => /^([-*+]|\d+[.)]|\[[ x]\]|[-*] \[[ x]\])\s*\S/.test(l) || l.length >= 12);

export function lintTicket(text, { strict = false } = {}) {
	const s = parseSections(text || '');
	const problems = [];
	if (items(s.acceptance).length === 0)
		problems.push('needs acceptance criteria: add an Acceptance criteria section with at least one concrete, checkable item');
	if (strict) {
		if (items(s.outOfScope).length === 0) problems.push('needs an Out of scope section with at least one item');
		if (items(s.testing).length === 0) problems.push('needs a Testing decisions section naming the first red test');
	}
	return problems;
}

// "Remote-QA: staging" or "Remote-QA: staging (account: reviewer)", also as a list item or in bold: the ticket asks for its QA to
// run against that deployed environment (e2e-env.sh up --remote ENV [--account NAME]) instead of a stack started here. The names
// are the ones the settings use, so a line that does not look like a name is no request.
export function parseRemoteQa(text) {
	const m =
		/^\s*(?:[-*+]\s*)?(?:\*\*|__)?\s*remote[- ]qa\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*`?([A-Za-z0-9][A-Za-z0-9_-]*)`?(?:\s*[,(]?\s*(?:account\s*[:=]?\s*)`?([A-Za-z0-9][A-Za-z0-9_-]*)`?\)?)?\s*(?:\*\*|__)?\s*$/im.exec(
			text || '',
		);
	return m ? { env: m[1], account: m[2] ?? null } : null;
}
