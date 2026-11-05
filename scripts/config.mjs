// Reads the factory's settings in layers, later layers winning (objects merge key by key; arrays and scalars replace):
//   1. defaults  config.json inside the plugin, shared and free of any organisation
//   2. user      <DF_STATE_DIR or ~/.dev-factory>/config.json, one person's choices for every project
//   3. project   <repo>/.devfactory/config.json (the old <repo>/dev-factory.config.json is still read, with a notice,
//                when the new file is absent), or the file named by DF_CONFIG, which replaces this layer
//   4. env       the DF_* variables of ENV_OVERRIDES, applied by get()
// The plugin carries no organisation: a team's tracker, branches and environments live in its repository.
//   config.mjs get <dotted.path>        print one value (JSON for objects and arrays)
//   config.mjs agent <role>             print the model and effort a role runs with
//   config.mjs validate                 exit 1 and list problems; each notice is printed as `note: ...` on stderr
//   config.mjs write-from-env [--if-set] [--force]
//                                       write .devfactory/config.json from DF_PROJECT_CONFIG and .devfactory/qa.yaml from
//                                       DF_PROJECT_QA (raw or base64), for a checkout that has neither; an existing file is
//                                       kept unless --force, and --if-set skips a variable that is not set
// A path that starts with `source.` reads from the active task source: `source.states.inProgress` is
// `sources.<tasks.source>.states.inProgress`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { PROJECT_FILES, ensureProjectDir, projectRoot } from './project-dir.mjs';

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(PLUGIN_ROOT, 'config.json');
export const REPO_CONFIG = 'dev-factory.config.json';
export const SOURCES = ['local', 'github', 'notion', 'jira'];
export const SCHEDULERS = ['auto', 'launchd', 'github-actions', 'routine', 'none'];
export const REPO_SKILL_PHASES = ['implement', 'qa', 'review', 'ship', 'diagnose'];
export const ROLES = ['builder', 'reviewer', 'debugger', 'researcher', 'improver', 'promoter'];

export const ENV_OVERRIDES = {
	'caps.maxOpenPrs': 'DF_MAX_OPEN_PRS',
	'caps.maxConcurrent': 'DF_MAX_CONCURRENT',
	'caps.maxBudgetUsd': 'DF_MAX_BUDGET_USD',
	'tasks.source': 'DF_TASK_SOURCE',
	'tasks.label': 'DF_TASK_LABEL',
	'sources.github.repo': 'DF_GITHUB_REPO',
	'sources.notion.databaseId': 'DF_NOTION_DATABASE_ID',
	'sources.notion.project': 'DF_NOTION_PROJECT',
	'sources.jira.cloudId': 'DF_JIRA_CLOUD_ID',
	'sources.jira.projects': 'DF_JIRA_PROJECTS',
	'models.orchestrator': 'DF_MODEL',
	'models.builder': 'DF_BUILDER_MODEL',
	'models.reviewer': 'DF_REVIEWER_MODEL',
	'models.effort': 'DF_EFFORT',
	'mobile.metroPort': 'DF_METRO_PORT',
	'models.debugger': 'DF_DEBUGGER_MODEL',
	'caps.maxResumes': 'DF_MAX_RESUMES',
	'caps.frontierRepeatHours': 'DF_FRONTIER_REPEAT_HOURS',
	'improvement.factoryRepo': 'DF_FACTORY_REPO',
	'runtime.scheduler': 'DF_SCHEDULER',
	'blocked.agentDecides': 'DF_AGENT_DECIDES',
	'scheduler.intervalMinutes': 'DF_SCHEDULER_INTERVAL_MINUTES',
};

// Keys every source needs; the active source's own keys are added by requiredFor().
const REQUIRED = [
	'tasks.source',
	'tasks.label',
	'tasks.blockedLabel',
	'tasks.placeholderKey',
	'tasks.bugTypes',
	'git.branchTypes',
	'pr.sizeLabels',
	'pr.areaLabels',
	'caps.maxOpenPrs',
	'caps.maxConcurrent',
	'caps.maxFixRounds',
	'caps.maxBudgetUsd',
	'models.orchestrator',
	'models.builder',
	'models.reviewer',
	'models.debugger',
	'models.researcher',
	'models.improver',
	'caps.maxResumes',
	'caps.frontierRepeatHours',
	'caps.stallMinutes',
	'models.effort',
	'models.efforts.improver',
	'environment.type',
	'environments.dev',
	'telemetry.maxRows',
	'telemetry.maxWindowDays',
	'debug.maxDebugRounds',
	'debug.debugMinutes',
	'validation.minHoursAfterMerge',
	'improvement.label',
	'improvement.maxTicketsPerScan',
	'improvement.maxPrsPerScan',
	'improvement.minEvidence',
	'improvement.maxPromotionsPerScan',
	'improvement.agentsRuleCap',
	'review.specialistAxes',
];

// What a source needs before it can run, beyond the states every source maps.
const SOURCE_NEEDS = {
	local: ['dir'],
	github: [],
	notion: ['databaseId', 'properties.title', 'properties.status'],
	jira: ['site', 'cloudId', 'projects'],
};
const STATE_KEYS = ['ready', 'inProgress', 'inReview', 'reviewed', 'done'];

const AXES = ['data', 'infra', 'security'];
const NUMERIC = [
	'caps.maxBugbotRounds',
	'caps.maxResumes',
	'caps.maxDecisions',
	'caps.stallMinutes',
	'caps.frontierRepeatHours',
	'telemetry.maxRows',
	'telemetry.maxWindowDays',
	'debug.maxDebugRounds',
	'debug.debugMinutes',
	'validation.minHoursAfterMerge',
	'environment.readyTimeout',
	'improvement.maxTicketsPerScan',
	'improvement.maxPrsPerScan',
	'improvement.minEvidence',
	'improvement.maxPromotionsPerScan',
	'improvement.agentsRuleCap',
];

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Objects merge key by key; arrays and scalars in the override replace the default.
export function merge(base, over) {
	if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
	const out = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
	return out;
}

// DF_CONFIG names the file; otherwise the nearest folder at or above `from` that holds .devfactory/config.json or the old
// dev-factory.config.json, the new one winning when a folder holds both.
export function findRepoConfig(from = process.cwd(), env = process.env) {
	if (env.DF_CONFIG) return fs.existsSync(env.DF_CONFIG) ? env.DF_CONFIG : null;
	for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
		for (const candidate of [path.join(dir, PROJECT_FILES.config), path.join(dir, REPO_CONFIG)]) if (fs.existsSync(candidate)) return candidate;
		if (path.dirname(dir) === dir) return null;
	}
}

export const isLegacyConfig = (file) => path.basename(file) === REPO_CONFIG;

export const userConfigFile = (env = process.env) => path.join(env.DF_STATE_DIR || path.join(os.homedir(), '.dev-factory'), 'config.json');

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		throw new Error(`${file}: ${e.message}`);
	}
}

// The three file layers, always in this order. A layer whose file is missing has file null and no data.
export function layers({ from = process.cwd(), env = process.env } = {}) {
	const user = userConfigFile(env);
	const project = findRepoConfig(from, env);
	const read = (file) => (file && fs.existsSync(file) ? { file, data: readJson(file) } : { file: null, data: {} });
	return [
		{ name: 'defaults', file: FILE, data: readJson(FILE) },
		{ name: 'user', ...read(user) },
		{ name: 'project', ...read(project) },
	];
}

// An explicit file is read as it is (tests, tools); no argument gives the defaults, the user's file and the project's.
export function load(file, opts) {
	if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
	return layers(opts).reduce((acc, l) => merge(acc, l.data), {});
}

// What a person should know about the project file in use: the old location, or two files where one is ignored.
export function notices({ from = process.cwd(), env = process.env } = {}) {
	if (env.DF_CONFIG) return [];
	for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
		const fresh = path.join(dir, PROJECT_FILES.config);
		const old = path.join(dir, REPO_CONFIG);
		if (fs.existsSync(fresh)) return fs.existsSync(old) ? [`${old} is ignored: ${fresh} is used`] : [];
		if (fs.existsSync(old)) return [`${old} is the old location: run dev-factory migrate`];
		if (path.dirname(dir) === dir) return [];
	}
}

const dig = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// `source.x` is shorthand for the active source's `sources.<name>.x`.
export function resolvePath(dotted, config, env = process.env) {
	if (!dotted.startsWith('source.')) return dotted;
	return `sources.${env.DF_TASK_SOURCE || dig(config, 'tasks.source')}.${dotted.slice('source.'.length)}`;
}

export function get(dotted, { config = load(), env = process.env } = {}) {
	dotted = resolvePath(dotted, config, env);
	const name = ENV_OVERRIDES[dotted];
	if (name && env[name] !== undefined && env[name] !== '') {
		const raw = env[name];
		const base = dig(config, dotted);
		if (Array.isArray(base))
			return raw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
		if (typeof base === 'boolean') return /^(1|true|yes|on)$/i.test(raw);
		return typeof base === 'number' ? Number(raw) : raw;
	}
	return dig(config, dotted);
}

// Where the value of `dotted` comes from: the DF_* variable that overrides it, else the last layer that sets it
// ('project', or 'file' when DF_CONFIG replaces the project layer), else 'default'.
export function sourceOf(dotted, { from = process.cwd(), env = process.env } = {}) {
	return sourceFrom(layers({ from, env }), dotted, env);
}

// sourceOf over layers already read (the settings page reads them once).
export function sourceFrom(ls, dotted, env = process.env) {
	dotted = resolvePath(
		dotted,
		ls.reduce((acc, l) => merge(acc, l.data), {}),
		env,
	);
	const name = ENV_OVERRIDES[dotted];
	if (name && env[name] !== undefined && env[name] !== '') return name;
	for (const l of [...ls].reverse()) {
		if (l.name === 'defaults' || dig(l.data, dotted) === undefined) continue;
		return l.name === 'project' && env.DF_CONFIG ? 'file' : l.name;
	}
	return 'default';
}

const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];

// Sets (or, for undefined, removes and prunes the objects it leaves empty) one dotted key in the user's file or in the
// project's .devfactory/config.json, and returns the file. The project layer is never the old dev-factory.config.json;
// the first write into a repository that only has the old file starts from its content, which the new file then replaces.
export function setIn(layer, dotted, value, { from = process.cwd(), env = process.env } = {}) {
	if (layer !== 'user' && layer !== 'project') throw new Error(`layer must be user or project, not ${layer}`);
	const keys = String(dotted).split('.');
	if (keys.some((k) => !k || UNSAFE_KEYS.includes(k))) throw new Error(`${dotted} is not a valid setting path`);
	let file;
	let seed = null;
	if (layer === 'user') file = userConfigFile(env);
	else {
		const root = projectRoot(from);
		if (!root) throw new Error('not inside a git repository: the project layer lives in <repository>/.devfactory/config.json');
		ensureProjectDir(root);
		file = path.join(root, PROJECT_FILES.config);
		if (!fs.existsSync(file) && fs.existsSync(path.join(root, REPO_CONFIG))) seed = path.join(root, REPO_CONFIG);
	}
	const data = fs.existsSync(file) ? readJson(file) : seed ? readJson(seed) : {};
	const trail = [data];
	let at = data;
	for (const k of keys.slice(0, -1)) {
		if (!isObject(at[k])) {
			if (value === undefined) break;
			at[k] = {};
		}
		at = at[k];
		trail.push(at);
	}
	if (trail.length === keys.length) {
		const last = keys.at(-1);
		if (value === undefined) delete at[last];
		else at[last] = value;
		for (let i = trail.length - 1; i > 0 && value === undefined && Object.keys(trail[i]).length === 0; i--) delete trail[i - 1][keys[i - 1]];
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(data, null, '\t')}\n`);
	return file;
}

// The model and effort an agent of `role` runs with: models.<role>, and models.efforts.<role> over models.effort. Commands
// pass these to every Agent dispatch, so the settings reach the agents; an agent's own frontmatter is only the fallback.
export function agentSettings(role, { config = load(), env = process.env } = {}) {
	if (!ROLES.includes(role)) throw new Error(`no such agent role: ${role} (one of ${ROLES.join(', ')})`);
	return {
		model: get(`models.${role}`, { config, env }) ?? get('models.builder', { config, env }),
		effort: get(`models.efforts.${role}`, { config, env }) ?? get('models.effort', { config, env }),
	};
}

export function requiredFor(config) {
	const source = dig(config, 'tasks.source');
	if (!SOURCES.includes(source)) return REQUIRED;
	return [...REQUIRED, ...SOURCE_NEEDS[source].map((k) => `sources.${source}.${k}`), ...STATE_KEYS.map((k) => `sources.${source}.states.${k}`)];
}

const readPluginFile = (rel) => JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf8'));

// The MCP servers a configuration cannot do without: those the catalog flags `required` (the browser for web QA), and the device
// runner once a mobile app is set, which the catalog cannot say because it depends on the configuration.
export function requiredServers(config, servers = readPluginFile('mcp/catalog.json').servers ?? {}) {
	const ids = Object.entries(servers)
		.filter(([, s]) => s?.required === true)
		.map(([id]) => id);
	return dig(config, 'mobile.appDir') != null && !ids.includes('maestro') ? [...ids, 'maestro'] : ids;
}

const catalogIds = () => Object.keys(readPluginFile('mcp/catalog.json').servers ?? {});
const pluginList = () => readPluginFile('plugins.json').plugins ?? [];

// Problems with the on/off maps of one layer's data, read against `config` (the merged settings) for what is required.
function togglesProblems(data, config) {
	const problems = [];
	const check = (key, noun, known, required) => {
		const map = dig(data, key);
		if (map === undefined) return;
		if (!isObject(map)) return problems.push(`${key} must be an object of ${noun} ids to true or false`);
		for (const [id, v] of Object.entries(map)) {
			if (!known.includes(id)) problems.push(`${key}.${id} is not ${noun === 'server' ? 'a catalog server' : 'a known plugin'}`);
			if (typeof v !== 'boolean') problems.push(`${key}.${id} must be true or false`);
			else if (v === false && required.includes(id)) problems.push(`${key}.${id} is required and cannot be false`);
		}
	};
	check('mcp.servers', 'server', catalogIds(), requiredServers(config));
	check(
		'plugins.enabled',
		'plugin',
		pluginList().map((p) => p.id),
		pluginList()
			.filter((p) => p.required)
			.map((p) => p.id),
	);
	return problems;
}

const nonEmptyNames = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x);

// With no argument the configuration in effect is checked, and so is each layer on its own: a required server turned off
// in the user's file is a mistake even where the project's file turns it back on.
export function validate(config) {
	const layered = config === undefined;
	if (layered) config = load();
	const source = dig(config, 'tasks.source');
	const problems = [];
	const offered = layered ? layers().map((l) => l.data) : [config];
	for (const p of offered.flatMap((data) => togglesProblems(data, config))) if (!problems.includes(p)) problems.push(p);
	if (!SOURCES.includes(source)) problems.push(`tasks.source must be one of ${SOURCES.join(', ')}`);
	for (const k of requiredFor(config)) {
		const v = dig(config, k);
		if (v === undefined || v === null || (Array.isArray(v) && v.length === 0 && k.endsWith('.projects'))) problems.push(`missing ${k}`);
	}
	if (SOURCES.includes(source)) {
		const states = dig(config, `sources.${source}.states`) ?? {};
		for (const k of ['ready', 'done']) {
			if (states[k] !== undefined && !nonEmptyNames(states[k]))
				problems.push(`sources.${source}.states.${k} must be a non-empty list of names`);
		}
	}
	const projects = dig(config, 'sources.jira.projects');
	if (source === 'jira' && Array.isArray(projects) && !projects.every((p) => /^[A-Z][A-Z0-9]+$/.test(p)))
		problems.push('sources.jira.projects must be upper-case keys');
	const repo = dig(config, 'sources.github.repo');
	if (repo != null && !/^[\w.-]+\/[\w.-]+$/.test(repo)) problems.push('sources.github.repo must look like owner/name');
	for (const k of NUMERIC) {
		const v = dig(config, k);
		if (v !== undefined && !(Number.isInteger(v) && v >= 0)) problems.push(`${k} must be a non-negative integer`);
	}
	if (dig(config, 'tasks.bugTypes') !== undefined && !nonEmptyNames(dig(config, 'tasks.bugTypes')))
		problems.push('tasks.bugTypes must be a non-empty list of names');
	if (!/^[A-Za-z][A-Za-z0-9]*-[0-9]+$/.test(dig(config, 'tasks.placeholderKey') ?? ''))
		problems.push('tasks.placeholderKey must look like TASK-000');
	if (!['auto', 'local', 'cloud'].includes(dig(config, 'runtime.mode') ?? 'auto')) problems.push('runtime.mode must be auto, local or cloud');
	if (!SCHEDULERS.includes(dig(config, 'runtime.scheduler') ?? 'auto')) problems.push(`runtime.scheduler must be one of ${SCHEDULERS.join(', ')}`);
	const sandbox = dig(config, 'sandbox.enabled');
	if (sandbox != null && typeof sandbox !== 'boolean') problems.push('sandbox.enabled must be true, false or null');
	const wt = dig(config, 'git.worktreeRoot');
	if (wt !== undefined && (typeof wt !== 'string' || !wt)) problems.push('git.worktreeRoot must be a folder path');
	const factoryRepo = dig(config, 'improvement.factoryRepo');
	if (factoryRepo != null && (typeof factoryRepo !== 'string' || !factoryRepo))
		problems.push('improvement.factoryRepo must be a folder path or null');
	const attribution = dig(config, 'git.agentAttribution');
	if (attribution !== undefined && typeof attribution !== 'boolean') problems.push('git.agentAttribution must be true or false');
	for (const k of ['pr.reviewedOnMergeInto', 'pr.doneOnMergeInto', 'sources.notion.project']) {
		const v = dig(config, k);
		if (v != null && (typeof v !== 'string' || !v)) problems.push(`${k} must be a name or null`);
	}
	const bugbot = dig(config, 'review.bugbot');
	if (bugbot !== undefined && typeof bugbot !== 'boolean') problems.push('review.bugbot must be true or false');
	if (bugbot === true)
		for (const k of ['review.bugbotComment', 'review.bugbotAuthor'])
			if (typeof dig(config, k) !== 'string' || !dig(config, k)) problems.push(`${k} is required when review.bugbot is true`);
	const unblock = dig(config, 'tasks.unblockOnPr');
	if (unblock !== undefined && typeof unblock !== 'boolean') problems.push('tasks.unblockOnPr must be true or false');
	const depth = dig(config, 'caps.maxStackDepth');
	if (depth !== undefined && !(Number.isInteger(depth) && depth >= 1)) problems.push('caps.maxStackDepth must be a positive integer');
	if (dig(config, 'cleanup.takeover') !== undefined)
		problems.push(
			'cleanup.takeover is not a setting: a repository file cannot grant takeover. The machine owner sets DF_TAKEOVER=1 in <state>/.env.local (or the shell that starts a run)',
		);
	const agentDecides = dig(config, 'blocked.agentDecides');
	if (agentDecides !== undefined && typeof agentDecides !== 'boolean') problems.push('blocked.agentDecides must be true or false');
	const cports = dig(config, 'cleanup.ports');
	if (cports !== undefined && !(Array.isArray(cports) && cports.every((p) => Number.isInteger(p) && p > 0 && p < 65536)))
		problems.push('cleanup.ports must be a list of port numbers');
	const preCommit = dig(config, 'environment.preCommit');
	if (preCommit != null && (typeof preCommit !== 'string' || !preCommit)) problems.push('environment.preCommit must be a command or null');
	const type = dig(config, 'environment.type');
	if (type !== undefined && !['none', 'compose'].includes(type)) problems.push('environment.type must be none or compose');
	if (type === 'compose') {
		for (const k of ['composeFile', 'service'])
			if (!dig(config, `environment.${k}`)) problems.push(`environment.${k} is required when environment.type is compose`);
		const setup = dig(config, 'environment.setup');
		const step = (c) =>
			(typeof c === 'string' && c) ||
			(c && typeof c === 'object' && typeof c.run === 'string' && c.run && (c.user === undefined || (typeof c.user === 'string' && c.user)));
		if (setup !== undefined && !(Array.isArray(setup) && setup.every(step)))
			problems.push('environment.setup must be a list of commands, each a string or {"run": "...", "user": "..."}');
	}
	const buildFiles = dig(config, 'environment.buildFiles');
	if (buildFiles !== undefined && !(Array.isArray(buildFiles) && buildFiles.every((g) => typeof g === 'string' && g)))
		problems.push('environment.buildFiles must be a list of globs');
	const axes = dig(config, 'review.specialistAxes');
	if (axes && typeof axes === 'object') {
		for (const [name, globs] of Object.entries(axes)) {
			if (!AXES.includes(name)) problems.push(`review.specialistAxes.${name} is not one of ${AXES.join(', ')}`);
			if (!Array.isArray(globs) || !globs.every((g) => typeof g === 'string' && g))
				problems.push(`review.specialistAxes.${name} must be a list of globs`);
		}
	}
	const envs = dig(config, 'environments');
	if (envs && typeof envs === 'object') {
		for (const [name, e] of Object.entries(envs)) {
			if (e && e.axiomDatasets !== undefined && !Array.isArray(e.axiomDatasets))
				problems.push(`environments.${name}.axiomDatasets must be a list`);
			const remote = e?.remote;
			if (remote != null) {
				if (typeof remote !== 'object' || Array.isArray(remote)) problems.push(`environments.${name}.remote must be an object with a url`);
				else {
					if (!/^https?:\/\/[^\s/@]+(:\d+)?(\/\S*)?$/.test(remote.url ?? ''))
						problems.push(`environments.${name}.remote.url must be an http(s) address without credentials`);
					const accounts = remote.accounts ?? [];
					if (!(Array.isArray(accounts) && accounts.every((a) => typeof a === 'string' && /^[A-Za-z0-9_-]+$/.test(a))))
						problems.push(`environments.${name}.remote.accounts must be a list of account names (letters, digits, - and _)`);
					if (remote.defaultAccount != null && !accounts.includes(remote.defaultAccount))
						problems.push(`environments.${name}.remote.defaultAccount must be one of its accounts`);
					if (!/^[A-Za-z0-9_-]+$/.test(name)) problems.push(`environments.${name}: a remote environment name is letters, digits, - and _`);
				}
			}
		}
	}
	const skipHooks = dig(config, 'git.skipCommitHooks');
	if (skipHooks !== undefined && typeof skipHooks !== 'boolean') problems.push('git.skipCommitHooks must be true or false');
	const repoSkills = dig(config, 'repoSkills');
	if (repoSkills !== undefined) {
		if (!repoSkills || typeof repoSkills !== 'object' || Array.isArray(repoSkills))
			problems.push('repoSkills must map phases to lists of skill names');
		else
			for (const [phase, list] of Object.entries(repoSkills)) {
				if (!REPO_SKILL_PHASES.includes(phase)) problems.push(`repoSkills.${phase} is not a phase (${REPO_SKILL_PHASES.join(', ')})`);
				else if (!(Array.isArray(list) && list.every((n) => typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(n))))
					problems.push(`repoSkills.${phase} must be a list of skill names such as repo-rules or plugin:skill`);
			}
	}
	const readFirst = dig(config, 'review.readFirst');
	if (
		readFirst !== undefined &&
		!(Array.isArray(readFirst) && readFirst.every((f) => typeof f === 'string' && f && !path.isAbsolute(f) && !f.split('/').includes('..')))
	)
		problems.push('review.readFirst must be a list of file paths inside the repository (no absolute path, no ..)');
	const questionLabel = dig(config, 'tasks.questionLabel');
	if (questionLabel !== undefined && (typeof questionLabel !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(questionLabel)))
		problems.push('tasks.questionLabel must be a label name (letters, digits, . _ : -)');
	if (questionLabel !== undefined && questionLabel === dig(config, 'tasks.blockedLabel'))
		problems.push('tasks.questionLabel must differ from tasks.blockedLabel');
	const ignoreAuthors = dig(config, 'tasks.ignoreCommentAuthors');
	if (ignoreAuthors !== undefined && !(Array.isArray(ignoreAuthors) && ignoreAuthors.every((a) => typeof a === 'string' && a.trim())))
		problems.push('tasks.ignoreCommentAuthors must be a list of comment author ids or names');
	const platform = dig(config, 'mobile.platform');
	if (platform !== undefined && !['ios', 'android'].includes(platform))
		problems.push('mobile.platform must be ios or android (leave it unset to infer it from the ticket)');
	for (const k of ['mobile.androidAvd', 'mobile.iosAutofillOff', 'mobile.androidBuild', 'mobile.appId']) {
		const v = dig(config, k);
		if (v != null && (typeof v !== 'string' || !v)) problems.push(`${k} must be a non-empty string or null`);
	}
	if (dig(config, 'mobile.clientLogs') !== undefined && typeof dig(config, 'mobile.clientLogs') !== 'boolean')
		problems.push('mobile.clientLogs must be true or false');
	const rev = dig(config, 'mobile.androidReversePorts');
	if (rev !== undefined && !(Array.isArray(rev) && rev.every((p) => Number.isInteger(p) && p > 0 && p < 65536)))
		problems.push('mobile.androidReversePorts must be a list of port numbers');
	const login = dig(config, 'mobile.login');
	if (login !== undefined && !(login && typeof login === 'object' && Object.values(login).every((v) => typeof v === 'string' && v)))
		problems.push('mobile.login must map userField, passwordField, submit and success to element ids');
	const maxMb = dig(config, 'evidence.maxAttachmentMb');
	if (maxMb !== undefined && !(typeof maxMb === 'number' && maxMb > 0 && maxMb <= 1024))
		problems.push('evidence.maxAttachmentMb must be a number of megabytes above 0');
	const cmd = dig(config, 'coverage.command');
	if (cmd != null && (typeof cmd !== 'string' || !cmd)) problems.push('coverage.command must be a command or null');
	const lcov = dig(config, 'coverage.lcovPath');
	if (lcov !== undefined && (typeof lcov !== 'string' || !lcov)) problems.push('coverage.lcovPath must be a file path');
	for (const k of ['coverage.unitGlobs', 'coverage.functionalGlobs']) {
		const v = dig(config, k);
		if (v !== undefined && !(Array.isArray(v) && v.every((g) => typeof g === 'string' && g))) problems.push(`${k} must be a list of globs`);
	}
	const interval = dig(config, 'scheduler.intervalMinutes');
	if (interval !== undefined && !(Number.isInteger(interval) && interval >= 1 && interval <= 1440))
		problems.push('scheduler.intervalMinutes must be a whole number of minutes from 1 to 1440');
	const notify = dig(config, 'alerts.notify');
	if (notify !== undefined && typeof notify !== 'boolean') problems.push('alerts.notify must be true or false');
	const trackerHosts = dig(config, 'guard.trackerHosts');
	if (
		trackerHosts !== undefined &&
		!(Array.isArray(trackerHosts) && trackerHosts.every((h) => typeof h === 'string' && /^[A-Za-z0-9.-]+$/.test(h)))
	)
		problems.push('guard.trackerHosts must be a list of host names, such as jira.internal.example');
	const roles = dig(config, 'telemetry.allowedRoles');
	if (roles !== undefined && !(Array.isArray(roles) && roles.every((r) => ROLES.includes(r))))
		problems.push(`telemetry.allowedRoles must be a list of roles from ${ROLES.join(', ')} (empty allows every role)`);
	const patterns = dig(config, 'telemetry.scrubPatterns') ?? [];
	for (const pat of patterns) {
		try {
			new RegExp(pat);
		} catch {
			problems.push(`telemetry.scrubPatterns has an invalid pattern: ${pat}`);
		}
	}
	return problems;
}

// A value from the environment: JSON is raw when it starts with {, and base64 otherwise. YAML is raw when it holds any
// character a base64 text cannot (a colon, a quote, a dash line, a comment), and base64 otherwise.
const looksRaw = { config: (s) => s.trimStart().startsWith('{'), qa: (s) => /[^A-Za-z0-9+/=\s]/.test(s) };
const decode = (kind, value) => (looksRaw[kind](value) ? value : Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8'));

const FROM_ENV = [
	{ kind: 'config', variable: 'DF_PROJECT_CONFIG', file: PROJECT_FILES.config },
	{ kind: 'qa', variable: 'DF_PROJECT_QA', file: PROJECT_FILES.qa },
];

// Writes .devfactory/config.json and .devfactory/qa.yaml from DF_PROJECT_CONFIG and DF_PROJECT_QA, for a checkout that does
// not have them (they are never committed). Returns { code, messages }: code 1 when a value is invalid, a variable is unset
// without ifSet, or a file exists without force or ifSet (with ifSet an existing file is kept and named in `notes`).
// Nothing is written when a value is invalid. `wrote` lists the files written.
export function writeFromEnv({ from = process.cwd(), env = process.env, ifSet = false, force = false } = {}) {
	const messages = [];
	const notes = [];
	const wrote = [];
	let code = 0;
	const todo = [];
	for (const item of FROM_ENV) {
		const raw = env[item.variable];
		if (raw === undefined || raw === '') {
			if (!ifSet) {
				messages.push(`${item.variable} is not set`);
				code = 1;
			}
			continue;
		}
		const text = decode(item.kind, raw);
		if (item.kind === 'config') {
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch (e) {
				return { code: 1, messages: [`${item.variable} is not valid JSON: ${e.message}`], notes, wrote };
			}
			if (!isObject(parsed)) return { code: 1, messages: [`${item.variable} must be a JSON object`], notes, wrote };
		}
		todo.push({ ...item, text });
	}
	if (todo.length === 0) return { code, messages, notes, wrote };
	const root = projectRoot(from);
	if (!root) return { code: 1, messages: [...messages, 'not inside a git repository: nowhere to write .devfactory/'], notes, wrote };
	ensureProjectDir(root);
	for (const item of todo) {
		const file = path.join(root, item.file);
		if (fs.existsSync(file) && !force) {
			// A session start runs this with ifSet on every start, so a configured checkout is not a failure there.
			if (ifSet) notes.push(`${file} exists, kept (use --force to replace it)`);
			else {
				messages.push(`${file} exists: kept (use --force to replace it)`);
				code = 1;
			}
			continue;
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, item.text);
		wrote.push(file);
	}
	return { code, messages, notes, wrote };
}

if (isMain(import.meta.url)) {
	const [cmd, arg] = process.argv.slice(2);
	const flag = (name) => process.argv.slice(3).includes(name);
	if (cmd === 'get') {
		const v = get(arg);
		if (v === undefined || v === null) {
			console.error(`config: no value for ${arg}`);
			process.exit(1);
		}
		console.log(typeof v === 'object' ? JSON.stringify(v) : v);
	} else if (cmd === 'agent') {
		try {
			console.log(JSON.stringify(agentSettings(arg)));
		} catch (e) {
			console.error(`config: ${e.message}`);
			process.exit(3);
		}
	} else if (cmd === 'validate') {
		for (const n of notices()) console.error(`note: ${n}`);
		const problems = validate();
		if (problems.length) {
			console.error(problems.join('\n'));
			process.exit(1);
		}
		console.log('config: ok');
	} else if (cmd === 'write-from-env') {
		const { code, messages, notes, wrote } = writeFromEnv({ ifSet: flag('--if-set'), force: flag('--force') });
		for (const f of wrote) console.log(`config: wrote ${f}`);
		for (const n of notes) console.error(`note: ${n}`);
		for (const m of messages) console.error(`config: ${m}`);
		process.exit(code);
	} else {
		console.error('usage: config.mjs get <path> | agent <role> | validate | write-from-env [--if-set] [--force]');
		process.exit(3);
	}
}
