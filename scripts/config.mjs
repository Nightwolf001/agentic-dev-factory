// Reads dev-factory/config.json. Environment variables override scalar settings so one machine
// can differ without editing the committed file.
//   config.mjs get <dotted.path>     print one value (JSON for objects and arrays)
//   config.mjs validate              exit 1 and list problems if required keys are missing
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');

export const ENV_OVERRIDES = {
	'caps.maxOpenPrs': 'DF_MAX_OPEN_PRS',
	'caps.maxConcurrent': 'DF_MAX_CONCURRENT',
	'caps.maxBudgetUsd': 'DF_MAX_BUDGET_USD',
	'jira.label': 'DF_JIRA_LABEL',
	'jira.cloudId': 'DF_JIRA_CLOUD_ID',
	'jira.projects': 'DF_JIRA_PROJECTS',
	'models.orchestrator': 'DF_MODEL',
	'models.builder': 'DF_BUILDER_MODEL',
	'models.reviewer': 'DF_REVIEWER_MODEL',
	'models.effort': 'DF_EFFORT',
	'mobile.metroPort': 'DF_METRO_PORT',
	'models.debugger': 'DF_DEBUGGER_MODEL',
	'caps.maxResumes': 'DF_MAX_RESUMES',
	'caps.frontierRepeatHours': 'DF_FRONTIER_REPEAT_HOURS',
};

const REQUIRED = [
	'jira.cloudId',
	'jira.projects',
	'jira.label',
	'jira.blockedLabel',
	'jira.statuses.readyForDev',
	'jira.statuses.todo',
	'jira.statuses.inProgress',
	'jira.statuses.peerReview',
	'jira.statuses.afterReview',
	'jira.doneStatuses',
	'jira.bugTypes',
	'git.baseBranch',
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
	'environments',
	'telemetry.maxRows',
	'telemetry.maxWindowDays',
	'debug.maxDebugRounds',
	'debug.debugMinutes',
	'validation.minHoursAfterMerge',
	'improvement.jiraProject',
	'improvement.label',
	'improvement.maxTicketsPerScan',
	'improvement.maxPrsPerScan',
	'improvement.minEvidence',
	'improvement.maxPromotionsPerScan',
	'improvement.agentsRuleCap',
	'review.specialistAxes',
];

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
	'improvement.maxTicketsPerScan',
	'improvement.maxPrsPerScan',
	'improvement.minEvidence',
	'improvement.maxPromotionsPerScan',
	'improvement.agentsRuleCap',
];

export function load(file = FILE) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const dig = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function get(dotted, { config = load(), env = process.env } = {}) {
	const name = ENV_OVERRIDES[dotted];
	if (name && env[name] !== undefined && env[name] !== '') {
		const raw = env[name];
		const base = dig(config, dotted);
		if (Array.isArray(base))
			return raw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
		return typeof base === 'number' ? Number(raw) : raw;
	}
	return dig(config, dotted);
}

export function validate(config = load()) {
	const problems = REQUIRED.filter((k) => dig(config, k) === undefined).map((k) => `missing ${k}`);
	const projects = dig(config, 'jira.projects');
	if (Array.isArray(projects) && !projects.every((p) => /^[A-Z][A-Z0-9]+$/.test(p))) problems.push('jira.projects must be upper-case keys');
	for (const k of NUMERIC) {
		const v = dig(config, k);
		if (v !== undefined && !(Number.isInteger(v) && v >= 0)) problems.push(`${k} must be a non-negative integer`);
	}
	for (const k of ['jira.doneStatuses', 'jira.bugTypes']) {
		const v = dig(config, k);
		if (v !== undefined && !(Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && x)))
			problems.push(`${k} must be a non-empty list of names`);
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
		for (const name of ['dev', 'staging', 'prod']) if (!envs[name]) problems.push(`missing environments.${name}`);
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
		if (v === undefined) {
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
