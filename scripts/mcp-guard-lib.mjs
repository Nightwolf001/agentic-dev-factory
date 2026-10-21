// Rules for the read-only Sentry and Axiom MCP tools. Enforced by hook, not by instruction.
// Pure function so it is unit-tested; mcp-guard.mjs feeds it the PreToolUse input.
const VERBS =
	'update|resolve|assign|merge|create|delete|mute|ingest|write|edit|set|add|remove|archive|ignore|unresolve|post|send|upload|import|trigger';
// snake_case, kebab-case and camelCase tool names alike.
const SNAKE = new RegExp(`(^|[_-])(${VERBS})([_-]|$)`, 'i');
const CAMEL = new RegExp(`(^(${VERBS})|[a-z](${VERBS.replace(/\b[a-z]/g, (c) => c.toUpperCase())}))([A-Z]|$)`);
const isWrite = (tool) => SNAKE.test(tool) || CAMEL.test(tool);
const PREFIX = /^mcp__plugin_dev-factory_(sentry|axiom)__(.+)$/;

const daysOf = (v) => {
	const m = /^(\d+)\s*([hdw])$/i.exec(String(v).trim());
	if (!m) return null;
	return Number(m[1]) * { h: 1 / 24, d: 1, w: 7 }[m[2].toLowerCase()];
};

export function datasetsIn(input) {
	const out = new Set();
	for (const k of ['dataset', 'datasetName', 'dataset_name']) if (typeof input?.[k] === 'string') out.add(input[k]);
	for (const k of ['datasets']) if (Array.isArray(input?.[k])) input[k].forEach((d) => out.add(String(d)));
	for (const k of ['apl', 'query', 'aplQuery']) {
		if (typeof input?.[k] !== 'string') continue;
		for (const m of input[k].matchAll(/\['([^']+)'\]|\["([^"]+)"\]/g)) out.add(m[1] ?? m[2]);
	}
	return [...out];
}

export function evaluateMcp({ toolName, toolInput = {}, config }) {
	const m = PREFIX.exec(toolName || '');
	if (!m) return { deny: false };
	const [, server, tool] = m;
	const deny = (why) => ({ deny: true, reason: `dev-factory guard: ${server} ${tool}: ${why}` });
	if (isWrite(tool)) return deny('write operations are not allowed, telemetry is read-only');
	const maxRows = config?.telemetry?.maxRows ?? 200;
	const maxDays = config?.telemetry?.maxWindowDays ?? 14;
	for (const k of ['limit', 'maxRows', 'max_rows', 'per_page', 'perPage']) {
		if (toolInput[k] != null && Number(toolInput[k]) > maxRows) return deny(`${k} ${toolInput[k]} exceeds telemetry.maxRows ${maxRows}`);
	}
	for (const k of ['apl', 'query', 'aplQuery']) {
		const t = typeof toolInput[k] === 'string' ? /\|\s*(take|limit)\s+(\d+)/i.exec(toolInput[k]) : null;
		if (t && Number(t[2]) > maxRows) return deny(`${t[1]} ${t[2]} exceeds telemetry.maxRows ${maxRows}`);
	}
	for (const k of ['statsPeriod', 'window', 'period', 'timeRange']) {
		const d = toolInput[k] == null ? null : daysOf(toolInput[k]);
		if (d != null && d > maxDays) return deny(`${k} ${toolInput[k]} exceeds telemetry.maxWindowDays ${maxDays}`);
	}
	if (toolInput.startTime && toolInput.endTime) {
		const span = (Date.parse(toolInput.endTime) - Date.parse(toolInput.startTime)) / 86400000;
		if (Number.isFinite(span) && span > maxDays) return deny(`time range of ${Math.ceil(span)} days exceeds telemetry.maxWindowDays ${maxDays}`);
	}
	if (server === 'axiom') {
		const allowed = new Set(Object.values(config?.environments ?? {}).flatMap((e) => e?.axiomDatasets ?? []));
		for (const d of datasetsIn(toolInput)) {
			if (!allowed.has(d)) return deny(`dataset '${d}' is not listed in environments.*.axiomDatasets`);
		}
	}
	return { deny: false };
}
