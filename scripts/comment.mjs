// Writes the factory's comments for people, and reads replies back. See scripts/comment-lib.mjs for the shape.
//
//   comment.mjs compose --kind phase|question|factory|summary|coverage|evidence --text TEXT [--detail TEXT]
//                       [--assignee TAG] [--reporter TAG] [--format text]   prints the comment
//   comment.mjs compose --format html --kind K --text TEXT [--detail TEXT] [--assignee-id ID --assignee-name N] [--reporter-id ID --reporter-name N]
//                                                                    prints HTML with real mention elements, for an MCP server whose comment tool takes HTML
//   comment.mjs compose-adf --kind K --text TEXT [--detail TEXT] [--assignee-id ID --assignee-name N] [--reporter-id ID --reporter-name N]
//                                                                    prints an Atlassian Document with real mention nodes
//   comment.mjs replies --file COMMENTS.json                         {question, replies, cancelled} from [{id, author, created, body}]
//   comment.mjs fix --file COMMENTS.json [--pr-open true]            the fix request on the ticket, or null
import fs from 'node:fs';
import { get, load } from './config.mjs';
import { compose, composeAdf, composeHtml, findFixRequest, findReplies } from './comment-lib.mjs';
import { isMain } from './is-main.mjs';

// compose reads its options by name: a token that starts with -- at a name position is an option name, and the token after a known
// name is its value, taken as it is whatever it looks like, so a reason that quotes a flag ("--format=html") is plain text. An unknown
// --name is skipped with its value, a --name=value token is not an option of ours, and any other token is skipped alone.
const ID_OPTIONS = ['assignee-id', 'assignee-name', 'reporter-id', 'reporter-name'];
const COMPOSE_OPTIONS = ['kind', 'text', 'detail', 'assignee', 'reporter', 'format', ...ID_OPTIONS];
function parseCompose(args) {
	const opts = {};
	const names = new Set();
	let formatCount = 0;
	let formatEquals = false;
	for (let i = 0; i < args.length; i++) {
		const t = args[i];
		if (!t.startsWith('--')) continue;
		const name = t.slice(2);
		if (name.includes('=')) {
			if (name.startsWith('format=')) formatEquals = true;
			continue;
		}
		if (COMPOSE_OPTIONS.includes(name)) {
			names.add(name);
			if (name === 'format') formatCount++;
			if (!(name in opts)) opts[name] = args[i + 1];
		}
		i++; // the value (an unknown option's too)
	}
	return { opts, names, formatCount, formatEquals };
}

if (isMain(import.meta.url)) {
	const argv = process.argv.slice(2);
	const val = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
	try {
		const cmd = argv[0];
		if (cmd === 'compose') {
			const o = parseCompose(argv.slice(1));
			// a mistyped or mismatched option is refused, never guessed at: a comment that quietly lost its mentions tells nobody
			if (o.formatEquals) throw new Error('--format takes its value after a space: --format html');
			if (o.formatCount > 1) throw new Error('--format was given more than once');
			if (o.formatCount === 1 && (o.opts.format === undefined || COMPOSE_OPTIONS.some((n) => o.opts.format === `--${n}`)))
				throw new Error('--format needs a value (text or html)');
			const format = o.opts.format ?? 'text';
			if (format !== 'text' && format !== 'html') throw new Error('--format must be text or html');
			if (format === 'text' && ID_OPTIONS.some((n) => o.names.has(n)))
				throw new Error('--assignee-id and the other id/name options need --format html');
			if (format === 'html' && ['assignee', 'reporter'].some((n) => o.names.has(n)))
				throw new Error('--assignee and --reporter are for --format text; use --assignee-id/--assignee-name with --format html');
			const { kind, text } = o.opts;
			const detail = o.opts.detail ?? '';
			if (format === 'html') {
				const people = ['assignee', 'reporter'].map((w) => ({ id: o.opts[`${w}-id`], name: o.opts[`${w}-name`] }));
				console.log(composeHtml({ kind, text, detail, people }));
			} else {
				console.log(compose({ kind, text, detail, assignee: o.opts.assignee, reporter: o.opts.reporter }));
			}
		} else if (cmd === 'compose-adf') {
			const people = ['assignee', 'reporter'].map((w) => ({ id: val(`${w}-id`), name: val(`${w}-name`) }));
			console.log(JSON.stringify(composeAdf({ kind: val('kind'), text: val('text'), detail: val('detail') ?? '', people })));
		} else if (cmd === 'replies') {
			let ignoreAuthors = [];
			try {
				ignoreAuthors = get('tasks.ignoreCommentAuthors', { config: load() }) ?? [];
			} catch {
				/* no readable settings: nobody is ignored */
			}
			console.log(JSON.stringify(findReplies(JSON.parse(fs.readFileSync(val('file'), 'utf8')), { ignoreAuthors }), null, 2));
		} else if (cmd === 'fix') {
			let fixComment = 'dev-factory fix';
			try {
				fixComment = get('tasks.fixComment', { config: load() }) ?? fixComment;
			} catch {
				/* the default phrase */
			}
			console.log(
				JSON.stringify(
					findFixRequest(JSON.parse(fs.readFileSync(val('file'), 'utf8')), { fixComment, prOpen: val('pr-open') === 'true' }),
					null,
					2,
				),
			);
		} else throw new Error('usage: comment.mjs compose [--format text|html]|compose-adf|replies|fix (see the header of this file)');
	} catch (e) {
		console.error(`comment: ${e.message}`);
		process.exit(1);
	}
}
