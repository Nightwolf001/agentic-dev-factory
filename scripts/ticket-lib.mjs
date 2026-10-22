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
