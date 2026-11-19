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

if (isMain(import.meta.url)) {
	const argv = process.argv.slice(2);
	const val = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
	try {
		const cmd = argv[0];
		if (cmd === 'compose') {
			// a mistyped or mismatched option is refused, never guessed at: a comment that quietly lost its mentions tells nobody
			if (argv.some((a) => a.startsWith('--format='))) throw new Error('--format takes its value after a space: --format html');
			if (argv.filter((a) => a === '--format').length > 1) throw new Error('--format was given more than once');
			if (argv.includes('--format') && (argv[argv.indexOf('--format') + 1] ?? '--').startsWith('--'))
				throw new Error('--format needs a value (text or html)');
			const format = val('format') ?? 'text';
			if (format !== 'text' && format !== 'html') throw new Error('--format must be text or html');
			if (format === 'text' && ['assignee-id', 'assignee-name', 'reporter-id', 'reporter-name'].some((o) => argv.includes(`--${o}`)))
				throw new Error('--assignee-id and the other id/name options need --format html');
			if (format === 'html' && ['assignee', 'reporter'].some((o) => argv.includes(`--${o}`)))
				throw new Error('--assignee and --reporter are for --format text; use --assignee-id/--assignee-name with --format html');
			if (format === 'html') {
				const people = ['assignee', 'reporter'].map((w) => ({ id: val(`${w}-id`), name: val(`${w}-name`) }));
				console.log(composeHtml({ kind: val('kind'), text: val('text'), detail: val('detail') ?? '', people }));
			} else {
				console.log(
					compose({
						kind: val('kind'),
						text: val('text'),
						detail: val('detail') ?? '',
						assignee: val('assignee'),
						reporter: val('reporter'),
					}),
				);
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
