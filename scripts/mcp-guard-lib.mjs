// Rules for the read-only Sentry and Axiom MCP tools, and for the GitHub MCP server inside a run. Enforced by hook, not by instruction.
// Pure function so it is unit-tested; mcp-guard.mjs feeds it the PreToolUse input.
//
// Three kinds of server carry these tools: the plugin's own (`plugin_dev-factory_sentry`), one from the repository's .mcp.json
// (`sentry`), and a claude.ai connector (`claude_ai_Sentry`). The first two are for the factory and are guarded wherever they
// are used. A connector belongs to the person and is also used in their own sessions, so it is guarded only inside a factory
// run (`inRun`).
const VERBS =
	'update|resolve|assign|merge|create|delete|mute|ingest|write|edit|set|add|remove|archive|ignore|unresolve|post|send|upload|import|trigger|manage|replace|push|fork|close|submit|cancel';
// snake_case, kebab-case and camelCase tool names alike.
const SNAKE = new RegExp(`(^|[_-])(${VERBS})([_-]|$)`, 'i');
const CAMEL = new RegExp(`(^(${VERBS})|[a-z](${VERBS.replace(/\b[a-z]/g, (c) => c.toUpperCase())}))([A-Z]|$)`);
const isWrite = (tool) => SNAKE.test(tool) || CAMEL.test(tool);
// The server is named plugin_dev-factory_<id> when the plugin starts it, <id> when the repository's .mcp.json does, and
// claude_ai_<Id> for a claude.ai connector.
const PREFIX = /^mcp__(plugin_dev-factory_|claude_ai_)?(sentry|axiom)__(.+)$/i;

// GitHub is the person's own server, so it is judged inside a factory run only. There it may read (get, list, search, and the
// `<thing>_read` tools) and only when the name holds no write verb, so `get_or_create_x` or `search_and_replace_x` is refused;
// every change goes through the guarded gh CLI, whose pushes and merges the shell guard already limits.
const GITHUB = /^mcp__(?:plugin_dev-factory_|claude_ai_)?github__(.+)$/i;
const GITHUB_READ = /^(get|list|search)_|_read$/i;

// Sentry's connector runs its other tools through one tool, `execute_sentry_tool`, which names the tool it runs. That name,
// not the wrapper's, decides whether the call writes. The input key and the key holding its arguments are not fixed, so the
// usual spellings are read, and a call that names no tool cannot be judged and is refused.
const WRAPPER = /^execute[_-]?(sentry|axiom)?[_-]?tool$/i;
const INNER_NAME = ['tool_name', 'toolName', 'tool', 'name', 'command', 'action'];
const INNER_ARGS = ['arguments', 'args', 'params', 'parameters', 'input', 'tool_input', 'toolInput'];
const innerCall = (input) => {
	const key = INNER_NAME.find((k) => typeof input?.[k] === 'string' && input[k]);
	if (!key) return null;
	const argKey = INNER_ARGS.find((k) => input[k] && typeof input[k] === 'object' && !Array.isArray(input[k]));
	return { name: input[key], args: { ...input, ...(argKey ? input[argKey] : {}) } };
};

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

// inRun: the event belongs to a factory run. role: that run's role, when known.
export function evaluateMcp({ toolName, toolInput = {}, config, inRun, role }) {
	const gh = GITHUB.exec(toolName || '');
	if (gh) {
		if (inRun !== true || (GITHUB_READ.test(gh[1]) && !isWrite(gh[1]))) return { deny: false };
		return {
			deny: true,
			reason: `dev-factory guard: github ${gh[1]}: a run reaches GitHub through the guarded gh CLI; the GitHub MCP server is read-only here`,
		};
	}
	const m = PREFIX.exec(toolName || '');
	if (!m) return { deny: false };
	const connector = m[1] === 'claude_ai_';
	const server = m[2].toLowerCase();
	let tool = m[3];
	if (connector && inRun !== true) return { deny: false };
	const deny = (why) => ({ deny: true, reason: `dev-factory guard: ${server} ${tool}: ${why}` });
	// telemetry.allowedRoles narrows who may read: inside a run, only the roles listed. Empty or unset lists no restriction.
	const roles = config?.telemetry?.allowedRoles;
	if (inRun === true && Array.isArray(roles) && roles.length && !roles.includes(role))
		return deny(`${role ? `the ${role} role` : 'a role that is not known'} may not read telemetry (telemetry.allowedRoles: ${roles.join(', ')})`);
	if (WRAPPER.test(tool)) {
		const inner = innerCall(toolInput);
		if (!inner) return deny('this call does not say which tool it runs, so it cannot be judged');
		if (WRAPPER.test(inner.name)) return deny('a tool that runs a tool cannot be nested');
		tool = `${tool} → ${inner.name}`;
		if (isWrite(inner.name)) return deny('write operations are not allowed, telemetry is read-only');
		toolInput = inner.args;
	}
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
