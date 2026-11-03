// The factory's task-source commands, for the sources a script can drive on its own (local, github). Jira and Notion
// are read by `list` here (preflight) and written through their MCP servers: see skills/task-source.
//
//   tasks.mjs list   --state ready|inProgress|inReview|reviewed|done [--stale-minutes N]    JSON array of tasks
//                    [--label NAME] [--updated-within-minutes N]                           narrow it further
//                    [--not-label NAME] [--not-state STATE]                                exclude tasks with a label or in a state
//   tasks.mjs get    KEY                                                                    JSON task with body and comments
//   tasks.mjs comments KEY                                                                  [{id, author, created, body}] oldest first
//   tasks.mjs set-state KEY STATE                                                           move a task
//   tasks.mjs comment KEY --file F                                                          add a comment / activity line
//   tasks.mjs label  KEY --add NAME | --remove NAME
//   tasks.mjs link   KEY [--branch NAME|URL] [--pr URL] [--qa-verdict pass|fail|not applicable] [--evidence F,F]   record where the work is
//   tasks.mjs block  KEY --reason R --decision D [--kind question|factory] [--assignee TAG] [--reporter TAG]   label it blocked (and, for a question, with the question label), comment, return it to ready
//   tasks.mjs unblock KEY                                                                   remove the blocked and question labels
//   tasks.mjs create --title T --file BODY [--type TYPE] [--blocked-by K,K] [--parent KEY]  prints {"key"}
//   tasks.mjs init                                                                          create the labels or the folder
//
// Exit codes: 0 ok, 1 failure, 3 usage, 4 the active source is written through its MCP server, 21 a list that needs credentials this
// machine lacks (an empty list would be a wrong answer, not an empty queue).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { compose } from './comment-lib.mjs';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';
import { STATES } from './sources/common.mjs';
import { SCRIPTED, makeSource, missingCredentials } from './sources/index.mjs';

export const PHASE_PREFIX = '[dev-factory]';

function parse(argv) {
	const a = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
		else a._.push(argv[i]);
	}
	return a;
}

const repoUrl = () => execFileSync('gh', ['repo', 'view', '--json', 'url', '--jq', '.url'], { encoding: 'utf8' }).trim();
const resolveRepoUrl = async () => repoUrl();
// A branch given by name becomes its GitHub URL; a URL is kept as it is.
export async function branchUrl(branch, resolve) {
	if (/^https?:\/\//.test(branch)) return branch;
	return `${(await resolve()).replace(/\/$/, '')}/tree/${branch}`;
}

export async function run(argv, { cfg = load(), source, resolveRepoUrl: resolver = resolveRepoUrl } = {}) {
	const [cmd, ...rest] = argv;
	const a = parse(rest);
	const name = get('tasks.source', { config: cfg });
	const src = source ?? makeSource(cfg);
	const needsWrite = !['list'].includes(cmd);
	if (needsWrite && !source && !SCRIPTED.includes(name)) {
		const err = new Error(`tasks.source is ${name}: its tasks are written through the ${name} MCP server (see skills/task-source/${name}.md)`);
		err.code = 4;
		throw err;
	}
	const needState = (s) => {
		if (!STATES.includes(s)) throw Object.assign(new Error(`state must be one of ${STATES.join(', ')}`), { code: 3 });
		return s;
	};
	switch (cmd) {
		case 'list': {
			// Jira answers a search it is not allowed to run with an empty list, which reads as "no work". Without the credentials
			// the answer would be wrong, not empty: say so, with a code a script can tell apart.
			const missing = source ? null : missingCredentials(cfg);
			if (missing) throw Object.assign(new Error(`cannot list ${name} tasks: ${missing}`), { code: 21 });
			const stale = a['stale-minutes'] !== undefined ? Number(a['stale-minutes']) : undefined;
			const within = a['updated-within-minutes'] !== undefined ? Number(a['updated-within-minutes']) : undefined;
			const tasks = await src.list({
				states: a.state ? [needState(a.state)] : undefined,
				staleMinutes: stale,
				label: typeof a.label === 'string' ? a.label : undefined,
				notLabel: typeof a['not-label'] === 'string' ? a['not-label'] : undefined,
				notStates: typeof a['not-state'] === 'string' ? [needState(a['not-state'])] : undefined,
			});
			return tasks
				.filter((t) => typeof a.label !== 'string' || t.labels.includes(a.label))
				.filter((t) => typeof a['not-label'] !== 'string' || !t.labels.includes(a['not-label']))
				.filter((t) => typeof a['not-state'] !== 'string' || t.state !== a['not-state'])
				.filter((t) => within === undefined || Date.now() - Date.parse(t.updated) <= within * 60000);
		}
		case 'get':
			return src.get(a._[0]);
		case 'comments':
			if (typeof src.comments !== 'function') throw Object.assign(new Error(`${name} comments are read through its MCP server`), { code: 4 });
			return src.comments(a._[0]);
		case 'set-state':
			await src.setState(a._[0], needState(a._[1]));
			return { ok: true };
		case 'comment':
			await src.comment(a._[0], fs.readFileSync(a.file, 'utf8').trim());
			return { ok: true };
		case 'label':
			if (a.add) await src.addLabel(a._[0], a.add);
			else if (a.remove) await src.removeLabel(a._[0], a.remove);
			else throw Object.assign(new Error('label needs --add or --remove'), { code: 3 });
			return { ok: true };
		case 'link': {
			const evidence =
				typeof a.evidence === 'string'
					? a.evidence
							.split(',')
							.map((f) => f.trim())
							.filter(Boolean)
					: [];
			const branch = typeof a.branch === 'string' ? await branchUrl(a.branch, resolver) : undefined;
			await src.link(a._[0], {
				branch,
				pr: typeof a.pr === 'string' ? a.pr : undefined,
				qaVerdict: typeof a['qa-verdict'] === 'string' ? a['qa-verdict'] : undefined,
				evidence,
			});
			return { ok: true };
		}
		case 'block': {
			// a question waits for a person's answer (and carries the question label, so it is not counted as a failure and a reply
			// wakes it); --kind factory is a block the factory cannot get past by being told something
			const key = a._[0];
			const kind = a.kind === 'factory' ? 'factory' : 'question';
			await src.addLabel(key, get('tasks.blockedLabel', { config: cfg }));
			if (kind === 'question') await src.addLabel(key, get('tasks.questionLabel', { config: cfg }));
			const people = typeof src.people === 'function' ? await src.people(key).catch(() => ({})) : {};
			await src.comment(
				key,
				compose({
					kind,
					text: `${a.reason}. Decision needed: ${a.decision}`,
					assignee: typeof a.assignee === 'string' ? a.assignee : people.assignee,
					reporter: typeof a.reporter === 'string' ? a.reporter : people.reporter,
				}),
			);
			await src.setState(key, 'ready');
			return { ok: true };
		}
		case 'unblock': {
			// the blocked and question labels come off (a person answered, or the task is done and the label is a leftover)
			const key = a._[0];
			const removed = [];
			for (const l of [get('tasks.blockedLabel', { config: cfg }), get('tasks.questionLabel', { config: cfg })]) {
				try {
					await src.removeLabel(key, l);
					removed.push(l);
				} catch {
					/* the task did not carry it */
				}
			}
			return { ok: true, removed };
		}
		case 'create': {
			if (!a.title || !a.file) throw Object.assign(new Error('create needs --title and --file'), { code: 3 });
			const blockedBy =
				typeof a['blocked-by'] === 'string'
					? a['blocked-by']
							.split(',')
							.map((s) => s.trim())
							.filter(Boolean)
					: [];
			return src.create({
				title: a.title,
				body: fs.readFileSync(a.file, 'utf8'),
				type: typeof a.type === 'string' ? a.type : undefined,
				blockedBy,
				parent: typeof a.parent === 'string' ? a.parent : undefined,
			});
		}
		case 'init':
			return src.init();
		default:
			throw Object.assign(new Error('usage: tasks.mjs list|get|comments|set-state|comment|label|block|unblock|create|init'), { code: 3 });
	}
}

if (isMain(import.meta.url)) {
	run(process.argv.slice(2))
		.then((r) => console.log(JSON.stringify(r)))
		.catch((e) => {
			console.error(`tasks: ${e.message}`);
			process.exit(e.code ?? 1);
		});
}
