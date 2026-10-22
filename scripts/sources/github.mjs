// GitHub Issues task source, driven entirely through the `gh` CLI: no MCP server and no extra token.
// The factory's label (tasks.label) marks an issue as work for it. Progress is a state label
// (sources.github.states: df:in-progress, df:in-review, df:reviewed); an open issue with none of them is ready, and
// a closed issue is done. Task keys are GH-<issue number>.
import { execFileSync } from 'node:child_process';
import { get } from '../config.mjs';
import { matches, normaliseRef, parseBlockedBy } from './common.mjs';

const defaultGh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });

export function githubSource(cfg, { env = process.env, gh = defaultGh } = {}) {
	const g = (k) => get(k, { config: cfg, env });
	const repo = g('sources.github.repo');
	const assignee = g('sources.github.assignee');
	const prefix = g('sources.github.keyPrefix') ?? 'GH';
	const states = g('sources.github.states');
	const label = g('tasks.label');
	const blocked = g('tasks.blockedLabel');
	const stateLabels = ['inProgress', 'inReview', 'reviewed'].map((s) => states[s]);
	const repoArgs = repo ? ['--repo', repo] : [];
	const numberOf = (key) => {
		const m = new RegExp(`^${prefix}-(\\d+)$`, 'i').exec(key);
		if (!m) throw new Error(`${key} is not a ${prefix}-<number> key`);
		return m[1];
	};
	const json = (args) => JSON.parse(gh(args) || 'null');

	const stateFrom = (issue) => {
		if (String(issue.state).toLowerCase() === 'closed') return 'done';
		const names = (issue.labels ?? []).map((l) => l.name);
		for (const s of ['inProgress', 'inReview', 'reviewed']) if (names.includes(states[s])) return s;
		return 'ready';
	};

	const doneCache = new Map();
	const isDone = (key) => {
		if (!doneCache.has(key)) {
			try {
				const i = json(['issue', 'view', numberOf(key), '--json', 'state', ...repoArgs]);
				doneCache.set(key, String(i.state).toLowerCase() === 'closed');
			} catch {
				doneCache.set(key, false); // an unreadable blocker is treated as open: never build past what cannot be checked
			}
		}
		return doneCache.get(key);
	};

	const normalise = (i) => ({
		key: `${prefix}-${i.number}`,
		title: i.title,
		state: stateFrom(i),
		updated: i.updatedAt,
		labels: (i.labels ?? []).map((l) => l.name),
		type: (i.labels ?? []).map((l) => l.name).find((n) => /^(bug|feature|story|epic|task|chore|improvement)$/i.test(n)) ?? 'task',
		blockedBy: parseBlockedBy(i.body)
			.map((r) => normaliseRef(r, prefix))
			.filter(Boolean)
			.map((k) => ({ key: k, done: isDone(k) })),
	});

	const FIELDS = 'number,title,labels,updatedAt,body,state';

	return {
		name: 'github',
		async list(filter = {}) {
			const wantDone = filter.states?.includes('done');
			const args = ['issue', 'list', '--label', label, '--state', wantDone ? 'all' : 'open', '--limit', '100', '--json', FIELDS, ...repoArgs];
			if (assignee) args.push('--assignee', assignee);
			return json(args)
				.map(normalise)
				.filter((t) => !(filter.states?.includes('ready') && t.labels.includes(blocked)))
				.filter((t) => matches(t, filter));
		},
		async get(key) {
			const i = json(['issue', 'view', numberOf(key), '--json', `${FIELDS},comments`, ...repoArgs]);
			return { ...normalise(i), body: i.body ?? '', comments: (i.comments ?? []).map((c) => c.body) };
		},
		async create({ title, body, type, labels = [label], blockedBy = [], parent }) {
			const refs = blockedBy.length ? `\n\nBlocked by: ${blockedBy.join(', ')}` : '';
			const par = parent ? `\n\nParent: ${parent}` : '';
			const all = [...new Set([...labels, ...(type ? [type] : [])])];
			for (const l of all) gh(['label', 'create', l, '--force', ...repoArgs]);
			const out = gh(
				['issue', 'create', '--title', title, '--body-file', '-', ...all.flatMap((l) => ['--label', l]), ...repoArgs],
				`${body}${refs}${par}\n`,
			);
			const m = /\/issues\/(\d+)/.exec(out);
			if (!m) throw new Error(`could not read the new issue number from: ${out.trim()}`);
			return { key: `${prefix}-${m[1]}`, url: out.trim() };
		},
		async setState(key, state) {
			const n = numberOf(key);
			const remove = stateLabels.filter((l) => l && l !== states[state]);
			if (state === 'done') {
				gh(['issue', 'close', n, ...repoArgs]);
			} else {
				try {
					gh(['issue', 'reopen', n, ...repoArgs]);
				} catch {
					/* already open */
				}
			}
			const edit = ['issue', 'edit', n, ...repoArgs];
			for (const l of remove) edit.push('--remove-label', l);
			if (state !== 'ready' && state !== 'done' && states[state]) {
				gh(['label', 'create', states[state], '--force', ...repoArgs]);
				edit.push('--add-label', states[state]);
			}
			if (edit.length > 3 + repoArgs.length) gh(edit);
		},
		async comment(key, text) {
			gh(['issue', 'comment', numberOf(key), '--body-file', '-', ...repoArgs], text);
		},
		async addLabel(key, name) {
			gh(['label', 'create', name, '--force', ...repoArgs]);
			gh(['issue', 'edit', numberOf(key), '--add-label', name, ...repoArgs]);
		},
		async removeLabel(key, name) {
			gh(['issue', 'edit', numberOf(key), '--remove-label', name, ...repoArgs]);
		},
		async init() {
			for (const l of [
				label,
				blocked,
				...stateLabels,
				'factory-validated',
				'factory-regression',
				'needs-research',
				get('improvement.label', { config: cfg, env }),
			])
				if (l) gh(['label', 'create', l, '--force', ...repoArgs]);
			return { labels: 'ensured' };
		},
	};
}
