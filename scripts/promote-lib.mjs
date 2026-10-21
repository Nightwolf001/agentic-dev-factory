// Checks a promotion of learnings into AGENTS.md files: only the "## Learned rules" section may change, each
// rule is one short line with its evidence, and the section stays under a hard cap. Pure, unit-tested.
export const HEADING = '## Learned rules';
export const MAX_RULE_CHARS = 200;
const RULE_RE = /^- .{10,}\s\((?:[A-Za-z]+-\d+)(?:, [A-Za-z]+-\d+)*\)$/;

export function splitSection(text) {
	const i = text.indexOf(`\n${HEADING}`);
	const start = i === -1 ? (text.startsWith(HEADING) ? 0 : -1) : i + 1;
	if (start === -1) return { before: text, section: null, after: '' };
	const rest = text.slice(start + HEADING.length);
	const next = /\n#{1,2}\s+\S/.exec(rest);
	const end = next ? start + HEADING.length + next.index : text.length;
	return { before: text.slice(0, start), section: text.slice(start, end), after: text.slice(end) };
}

export const isAgentsFile = (p) => /(^|\/)AGENTS\.md$/.test(p) && !p.startsWith('dev-factory/');

// files: [{ path, before, after }] where before is '' for a new file.
export function checkPromotion(files, { cap = 15 } = {}) {
	const problems = [];
	if (!files.length) return ['no changed files'];
	for (const f of files) {
		if (!isAgentsFile(f.path)) {
			problems.push(`${f.path}: only AGENTS.md files outside dev-factory/ may change`);
			continue;
		}
		const b = splitSection(f.before);
		const a = splitSection(f.after);
		if (!a.section) {
			problems.push(`${f.path}: the "${HEADING}" section is missing`);
			continue;
		}
		const outsideSame =
			b.section === null
				? f.after.startsWith(f.before.replace(/\s*$/, '')) && a.before.trim() === f.before.trim()
				: a.before === b.before && a.after === b.after;
		if (!outsideSame) problems.push(`${f.path}: text outside the "${HEADING}" section changed`);
		const rules = a.section
			.split('\n')
			.slice(1)
			.filter((l) => l.trim());
		if (rules.length > cap) problems.push(`${f.path}: ${rules.length} rules, the cap is ${cap}; retire or merge one first`);
		for (const r of rules) {
			if (!RULE_RE.test(r)) problems.push(`${f.path}: rule must be one line "- <rule> (KEY)" with its evidence ticket: ${r.slice(0, 60)}`);
			else if (r.length > MAX_RULE_CHARS) problems.push(`${f.path}: rule is ${r.length} characters, the cap is ${MAX_RULE_CHARS}`);
		}
	}
	return problems;
}
