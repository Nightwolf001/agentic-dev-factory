// The factory's task-source commands, for the sources a script can drive on its own (local, github). Jira and Notion
// are read by `list` here (preflight) and written through their MCP servers: see skills/task-source.
//
//   tasks.mjs list   --state ready|inProgress|inReview|reviewed|done [--stale-minutes N]    JSON array of tasks
//                    [--label NAME] [--updated-within-minutes N]                           narrow it further
//   tasks.mjs get    KEY                                                                    JSON task with body and comments
//   tasks.mjs set-state KEY STATE                                                           move a task
//   tasks.mjs comment KEY --file F                                                          add a comment / activity line
//   tasks.mjs label  KEY --add NAME | --remove NAME
//   tasks.mjs block  KEY --reason R --decision D                                            label it blocked, comment, return it to ready
//   tasks.mjs create --title T --file BODY [--type TYPE] [--blocked-by K,K] [--parent KEY]  prints {"key"}
//   tasks.mjs init                                                                          create the labels or the folder
//
// Exit codes: 0 ok, 1 failure, 3 usage, 4 the active source is written through its MCP server.
import fs from 'node:fs';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';
import { STATES } from './sources/common.mjs';
import { SCRIPTED, makeSource } from './sources/index.mjs';

export const PHASE_PREFIX = '[dev-factory]';

function parse(argv) {
	const a = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
		else a._.push(argv[i]);
	}
	return a;
}

export async function run(argv, { cfg = load(), source } = {}) {
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
			const stale = a['stale-minutes'] !== undefined ? Number(a['stale-minutes']) : undefined;
			const within = a['updated-within-minutes'] !== undefined ? Number(a['updated-within-minutes']) : undefined;
			const tasks = await src.list({ states: a.state ? [needState(a.state)] : undefined, staleMinutes: stale });
			return tasks
				.filter((t) => typeof a.label !== 'string' || t.labels.includes(a.label))
				.filter((t) => within === undefined || Date.now() - Date.parse(t.updated) <= within * 60000);
		}
		case 'get':
			return src.get(a._[0]);
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
		case 'block': {
			const key = a._[0];
			await src.addLabel(key, get('tasks.blockedLabel', { config: cfg }));
			await src.comment(key, `${PHASE_PREFIX} blocked: ${a.reason}. Decision needed: ${a.decision}`);
			await src.setState(key, 'ready');
			return { ok: true };
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
			throw Object.assign(new Error('usage: tasks.mjs list|get|set-state|comment|label|block|create|init'), { code: 3 });
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
