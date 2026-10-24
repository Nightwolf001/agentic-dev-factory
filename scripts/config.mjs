// Reads dev-factory/config.json (the defaults, shipped with the plugin) and merges the repository's own
// dev-factory.config.json over it, so a team's tracker, branches and environments live in its repository and the
// plugin carries no organisation. Environment variables override scalar settings so one machine can differ without
// editing a committed file.
//   config.mjs get <dotted.path>     print one value (JSON for objects and arrays)
//   config.mjs validate              exit 1 and list problems if required keys are missing
// A path that starts with `source.` reads from the active task source: `source.states.inProgress` is
// `sources.<tasks.source>.states.inProgress`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');
export const REPO_CONFIG = 'dev-factory.config.json';
export const SOURCES = ['local', 'github', 'notion', 'jira'];
export const SCHEDULERS = ['auto', 'launchd', 'github-actions', 'routine', 'none'];

export const ENV_OVERRIDES = {
	'caps.maxOpenPrs': 'DF_MAX_OPEN_PRS',
	'caps.maxConcurrent': 'DF_MAX_CONCURRENT',
	'caps.maxBudgetUsd': 'DF_MAX_BUDGET_USD',
	'tasks.source': 'DF_TASK_SOURCE',
	'tasks.label': 'DF_TASK_LABEL',
	'sources.github.repo': 'DF_GITHUB_REPO',
	'sources.notion.databaseId': 'DF_NOTION_DATABASE_ID',
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
	'cleanup.takeover': 'DF_TAKEOVER',
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
	'caps.maxResumes',
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

// DF_CONFIG names the file; otherwise the nearest dev-factory.config.json at or above `from`.
export function findRepoConfig(from = process.cwd(), env = process.env) {
	if (env.DF_CONFIG) return fs.existsSync(env.DF_CONFIG) ? env.DF_CONFIG : null;
	for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, REPO_CONFIG);
		if (fs.existsSync(candidate)) return candidate;
		if (path.dirname(dir) === dir) return null;
	}
}

// An explicit file is read as it is (tests, tools); no argument gives the defaults plus the repository's file.
export function load(file) {
	if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
	const defaults = JSON.parse(fs.readFileSync(FILE, 'utf8'));
	const repo = findRepoConfig();
	return repo ? merge(defaults, JSON.parse(fs.readFileSync(repo, 'utf8'))) : defaults;
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

export function requiredFor(config) {
	const source = dig(config, 'tasks.source');
	if (!SOURCES.includes(source)) return REQUIRED;
	return [...REQUIRED, ...SOURCE_NEEDS[source].map((k) => `sources.${source}.${k}`), ...STATE_KEYS.map((k) => `sources.${source}.states.${k}`)];
}

const nonEmptyNames = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x);

export function validate(config = load()) {
	const source = dig(config, 'tasks.source');
	const problems = [];
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
	const takeover = dig(config, 'cleanup.takeover');
	if (takeover !== undefined && typeof takeover !== 'boolean') problems.push('cleanup.takeover must be true or false');
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
		if (setup !== undefined && !(Array.isArray(setup) && setup.every((c) => typeof c === 'string' && c)))
			problems.push('environment.setup must be a list of commands');
	}
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
		}
	}
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

if (isMain(import.meta.url)) {
	const [cmd, arg] = process.argv.slice(2);
	if (cmd === 'get') {
		const v = get(arg);
		if (v === undefined || v === null) {
			console.error(`config: no value for ${arg}`);
			process.exit(1);
		}
		console.log(typeof v === 'object' ? JSON.stringify(v) : v);
	} else if (cmd === 'validate') {
		const problems = validate();
		if (problems.length) {
			console.error(problems.join('\n'));
			process.exit(1);
		}
		console.log('config: ok');
	} else {
		console.error('usage: config.mjs get <path> | validate');
		process.exit(3);
	}
}
