import './isolate-state.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { configFromEnv, handle, makeTools, MAX_UPLOAD_BYTES, worktreeRoots } from '../scripts/jira-mcp.mjs';
import { entry, merge } from '../scripts/jira-mcp-config.mjs';

const ok = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });

function server(routes, extra = {}) {
	const seen = [];
	const fetchImpl = async (url, init = {}) => {
		const u = String(url).replace('https://example.atlassian.net/rest/api/3', '');
		seen.push({ method: init.method ?? 'GET', url: u, init });
		for (const [re, fn] of routes) {
			const m = re.exec(`${init.method ?? 'GET'} ${u}`);
			if (m) return fn(m, init);
		}
		return ok({}, 404);
	};
	return { seen, tools: makeTools({ site: 'example.atlassian.net', email: 'a@b.c', token: 'tok', fetchImpl, ...extra }) };
}

test('the issue comes back flattened, with people and comments as text', async () => {
	const { tools, seen } = server([
		[
			/^GET \/issue\/APP-1\?/,
			() =>
				ok({
					key: 'APP-1',
					fields: {
						summary: 'S',
						status: { name: 'To Do' },
						labels: ['dev-factory'],
						assignee: { accountId: 'a1', displayName: 'Jane' },
						reporter: { accountId: 'b2', displayName: 'Omar' },
						description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Do it' }] }] },
						comment: {
							comments: [
								{
									id: '5',
									author: { accountId: 'a1' },
									created: 'c',
									body: {
										type: 'doc',
										content: [
											{
												type: 'paragraph',
												content: [
													{ type: 'mention', attrs: { id: 'b2', text: '@Omar' } },
													{ type: 'text', text: ' ok?' },
												],
											},
										],
									},
								},
							],
						},
						attachment: [{ filename: 'a.png', size: 5 }],
					},
				}),
		],
	]);
	const i = await tools.getJiraIssue.run({ issueIdOrKey: 'APP-1' });
	assert.equal(i.description, 'Do it');
	assert.deepEqual(i.assignee, { accountId: 'a1', displayName: 'Jane' });
	assert.equal(i.comments[0].body, '@Omar ok?');
	assert.deepEqual(i.attachments, [{ filename: 'a.png', size: 5 }]);
	assert.match(seen[0].init.headers.Authorization, /^Basic /);
	assert.equal(Buffer.from(seen[0].init.headers.Authorization.slice(6), 'base64').toString(), 'a@b.c:tok');
	await assert.rejects(tools.getJiraIssue.run({ issueIdOrKey: 'APP-1/../../x' }), /issue key/);
	await assert.rejects(tools.getJiraIssue.run({ issueIdOrKey: 'nope' }), /issue key/);
});

test('a comment is written as a document with real mentions, a transition by id, labels by add and remove', async () => {
	const { tools, seen } = server([
		[/^POST \/issue\/APP-1\/comment/, () => ok({ id: '9' }, 201)],
		[/^POST \/issue\/APP-1\/transitions/, () => ok(null, 204)],
		[/^GET \/issue\/APP-1\/transitions/, () => ok({ transitions: [{ id: '31', name: 'Start', to: { name: 'In Progress' } }] })],
		[/^PUT \/issue\/APP-1/, () => ok(null, 204)],
	]);
	assert.deepEqual(
		await tools.addCommentToJiraIssue.run({
			issueIdOrKey: 'APP-1',
			commentBody: '[~accountid:a1] a question\n\n[dev-factory] blocked: question',
		}),
		{ id: '9' },
	);
	const body = JSON.parse(seen[0].init.body).body;
	assert.equal(body.content[0].content[0].type, 'mention');
	assert.equal(body.content[0].content[0].attrs.id, 'a1');
	assert.deepEqual(await tools.getTransitionsForJiraIssue.run({ issueIdOrKey: 'APP-1' }), {
		transitions: [{ id: '31', name: 'Start', to: 'In Progress' }],
	});
	await tools.transitionJiraIssue.run({ issueIdOrKey: 'APP-1', transition: { id: 31 } });
	assert.deepEqual(JSON.parse(seen.at(-1).init.body), { transition: { id: '31' } });
	await tools.editJiraIssue.run({
		issueIdOrKey: 'APP-1',
		update: { labels: [{ add: 'factory-blocked' }, { remove: 'ready' }, { add: 'bad label"' }] },
	});
	assert.deepEqual(JSON.parse(seen.at(-1).init.body), { update: { labels: [{ add: 'factory-blocked' }, { remove: 'ready' }] } });
	await assert.rejects(tools.editJiraIssue.run({ issueIdOrKey: 'APP-1', update: { labels: [] } }), /at least one/);
	await assert.rejects(tools.addCommentToJiraIssue.run({ issueIdOrKey: 'APP-1', commentBody: '  ' }), /required/);
	await assert.rejects(tools.transitionJiraIssue.run({ issueIdOrKey: 'APP-1', transition: {} }), /transition\.id/);
});

test('a Jira failure names the call and the status, never the issue, the query or a header', async () => {
	const { tools } = server([[/^GET \/issue\/APP-1/, () => new Response('secret detail in the body', { status: 403 })]]);
	await assert.rejects(
		tools.getJiraIssue.run({ issueIdOrKey: 'APP-1' }),
		(e) => /Jira GET \/issue\/<issue> answered 403/.test(e.message) && !/secret|APP-1|tok/.test(e.message),
	);
});

test('search, create, links and account lookup', async () => {
	const { tools, seen } = server([
		[/^GET \/search\/jql/, () => ok({ issues: [{ key: 'APP-2', fields: { summary: 's' } }] })],
		[/^POST \/issue$/, () => ok({ key: 'APP-9' }, 201)],
		[/^POST \/issue\/APP-1\/remotelink/, () => ok({ id: 1 }, 201)],
		[/^GET \/user\/search/, () => ok([{ accountId: 'a1', displayName: 'Jane', emailAddress: 'jane@example.com' }])],
	]);
	assert.deepEqual((await tools.searchJiraIssuesUsingJql.run({ jql: 'project = "APP"', maxResults: 500 })).issues, [
		{ key: 'APP-2', fields: { summary: 's' } },
	]);
	assert.match(seen[0].url, /maxResults=100/, 'capped');
	assert.match(seen[0].url, /jql=project%20%3D%20%22APP%22/);
	assert.deepEqual(
		await tools.createJiraIssue.run({
			projectKey: 'APP',
			issueTypeName: 'Task',
			summary: 'S',
			description: 'D',
			labels: ['dev-factory'],
			assigneeAccountId: 'a1',
		}),
		{ key: 'APP-9' },
	);
	const created = JSON.parse(seen[1].init.body).fields;
	assert.equal(created.assignee.accountId, 'a1');
	assert.equal(created.description.type, 'doc');
	await assert.rejects(tools.createJiraIssue.run({ projectKey: 'app', issueTypeName: 'Task', summary: 'S' }), /project key/);
	await tools.addRemoteLinkToJiraIssue.run({ issueIdOrKey: 'APP-1', url: 'https://github.com/o/r/pull/7', title: 'PR 7' });
	await assert.rejects(tools.addRemoteLinkToJiraIssue.run({ issueIdOrKey: 'APP-1', url: 'javascript:alert(1)', title: 'x' }), /https/);
	assert.deepEqual(
		await tools.lookupJiraAccountId.run({ searchString: 'jane' }),
		{ users: [{ accountId: 'a1', displayName: 'Jane' }] },
		'no email address is passed on',
	);
	await assert.rejects(tools.searchJiraIssuesUsingJql.run({}), /jql is required/);
});

// ---- attachments ----

function worktree(key = 'APP-1') {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'df-att-')));
	const run = path.join(dir, '.dev-factory/evidence', key, 'run-1');
	fs.mkdirSync(run, { recursive: true });
	fs.writeFileSync(path.join(dir, '.dev-factory/run.json'), JSON.stringify({ key }));
	fs.writeFileSync(path.join(run, 'login-1.png'), Buffer.alloc(2048, 7));
	return { dir, run };
}
const upload = (extra = {}) => [/^POST \/issue\/APP-1\/attachments/, (m, init) => ((extra.log ??= []).push(init), ok([{ id: '1' }]))];
const attachments = (list) => [/^GET \/issue\/APP-1\?fields=attachment/, () => ok({ fields: { attachment: list } })];

test('an evidence file of this ticket is uploaded once, by bare name, with the header Jira requires', async () => {
	const w = worktree();
	const log = [];
	const { tools } = server([attachments([]), [/^POST \/issue\/APP-1\/attachments/, (m, init) => (log.push(init), ok([{}]))]]);
	const r = await tools.uploadAttachmentToJiraIssue.run({ issueIdOrKey: 'APP-1', worktree: w.dir, run: 1, fileName: 'login-1.png' });
	assert.deepEqual(r, { attached: 'login-1.png', size: 2048 });
	assert.equal(log[0].headers['X-Atlassian-Token'], 'no-check');
	assert.ok(log[0].body instanceof FormData);
	assert.equal(log[0].body.get('file').name, 'login-1.png');
	// the same name and size: not uploaded again
	const again = server([attachments([{ filename: 'login-1.png', size: 2048 }]), [/attachments$/, () => assert.fail('uploaded twice')]]);
	assert.deepEqual(await again.tools.uploadAttachmentToJiraIssue.run({ issueIdOrKey: 'APP-1', worktree: w.dir, run: 1, fileName: 'login-1.png' }), {
		skipped: 'already attached',
		fileName: 'login-1.png',
		size: 2048,
	});
	// the same name with a different size is a different file
	const changed = server([attachments([{ filename: 'login-1.png', size: 1 }]), [/^POST \/issue\/APP-1\/attachments/, () => ok([{}])]]);
	assert.equal(
		(await changed.tools.uploadAttachmentToJiraIssue.run({ issueIdOrKey: 'APP-1', worktree: w.dir, run: 1, fileName: 'login-1.png' })).attached,
		'login-1.png',
	);
});

test('an attachment is refused when it is not the ticket’s own evidence, however the path is written', async () => {
	const w = worktree();
	const other = worktree('APP-2');
	const outside = path.join(os.tmpdir(), `df-outside-${process.pid}.txt`);
	fs.writeFileSync(outside, 'not evidence');
	fs.symlinkSync(outside, path.join(w.run, 'link.txt'));
	const { tools } = server([attachments([]), [/attachments$/, () => assert.fail('must not upload')]]);
	const go = (args) => tools.uploadAttachmentToJiraIssue.run({ issueIdOrKey: 'APP-1', worktree: w.dir, run: 1, fileName: 'login-1.png', ...args });
	for (const bad of ['../run-2/x.png', '/etc/passwd', 'sub/x.png', '..', '.hidden', 'a\\b.png', 'x\0.png', ''])
		await assert.rejects(go({ fileName: bad }), /bare file name/, JSON.stringify(bad));
	await assert.rejects(go({ fileName: 'link.txt' }), /not inside the run’s evidence folder/, 'a symlink out of the folder');
	await assert.rejects(go({ fileName: 'missing.png' }), /ENOENT/);
	await assert.rejects(go({ worktree: other.dir }), /not the one for this issue/, 'another ticket’s worktree');
	await assert.rejects(go({ run: 0 }), /run number/);
	await assert.rejects(go({ run: '1' }), /run number/);
	await assert.rejects(go({ worktree: os.tmpdir() }), /not the one for this issue|ENOENT/);
	const strict = server([attachments([])], { roots: [fs.realpathSync(os.tmpdir()) + '/nowhere'] });
	await assert.rejects(
		strict.tools.uploadAttachmentToJiraIssue.run({ issueIdOrKey: 'APP-1', worktree: w.dir, run: 1, fileName: 'login-1.png' }),
		/not one of this repository/,
	);
	fs.writeFileSync(path.join(w.run, 'big.bin'), Buffer.alloc(8));
	fs.truncateSync(path.join(w.run, 'big.bin'), MAX_UPLOAD_BYTES + 1);
	await assert.rejects(go({ fileName: 'big.bin' }), /Jira takes at most/);
});

// ---- the protocol ----

test('the MCP handshake, the tool list and a call, as a client sends them', async () => {
	const { tools } = server([[/^POST \/issue\/APP-1\/comment/, () => ok({ id: '1' }, 201)]]);
	const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, tools);
	assert.equal(init.result.protocolVersion, '2025-03-26');
	assert.deepEqual(init.result.capabilities, { tools: {} });
	assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools), null);
	const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools);
	const names = list.result.tools.map((t) => t.name);
	for (const n of [
		'getJiraIssue',
		'searchJiraIssuesUsingJql',
		'getTransitionsForJiraIssue',
		'transitionJiraIssue',
		'addCommentToJiraIssue',
		'editJiraIssue',
		'createJiraIssue',
		'addRemoteLinkToJiraIssue',
		'lookupJiraAccountId',
		'uploadAttachmentToJiraIssue',
	])
		assert.ok(names.includes(n), n);
	const call = await handle(
		{
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'addCommentToJiraIssue', arguments: { issueIdOrKey: 'APP-1', commentBody: 'hello' } },
		},
		tools,
	);
	assert.equal(JSON.parse(call.result.content[0].text).id, '1');
	const bad = await handle(
		{
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: { name: 'addCommentToJiraIssue', arguments: { issueIdOrKey: 'nope', commentBody: 'x' } },
		},
		tools,
	);
	assert.equal(bad.result.isError, true, 'a failing tool is a tool error, not a protocol error');
	assert.equal(
		(await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'toString' } }, tools)).error.code,
		-32602,
		'a prototype name is not a tool',
	);
	assert.equal((await handle({ jsonrpc: '2.0', id: 6, method: 'nope' }, tools)).error.code, -32601);
	assert.deepEqual((await handle({ jsonrpc: '2.0', id: 7, method: 'ping' }, tools)).result, {});
});

test('the server runs over stdio and refuses to start without its credentials', async () => {
	const script = path.resolve(import.meta.dirname, '../scripts/jira-mcp.mjs');
	// an empty state folder: the server reads <DF_STATE_DIR>/.env.local, never the developer's own
	const state = fs.mkdtempSync(path.join(os.tmpdir(), 'df-jira-spawn-'));
	const run = (env, lines) =>
		new Promise((resolve) => {
			const c = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, DF_STATE_DIR: state, ...env }, cwd: os.tmpdir() });
			let out = '';
			let err = '';
			c.stdout.on('data', (d) => (out += d));
			c.stderr.on('data', (d) => (err += d));
			c.on('close', (code) => resolve({ code, out, err }));
			for (const l of lines) c.stdin.write(JSON.stringify(l) + '\n');
			setTimeout(() => c.stdin.end(), 300);
		});
	const good = await run({ JIRA_SITE: 'example.atlassian.net', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 't' }, [
		{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
		{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
	]);
	const replies = good.out
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l));
	assert.equal(replies.length, 2);
	assert.equal(replies[0].result.serverInfo.name, 'dev-factory-jira');
	assert.ok(replies[1].result.tools.length >= 10);
	const bad = await run({}, []);
	assert.equal(bad.code, 1);
	assert.match(bad.err, /JIRA_EMAIL, JIRA_API_TOKEN/);
	const none = fs.mkdtempSync(path.join(os.tmpdir(), 'df-jira-none-'));
	assert.deepEqual(configFromEnv({ DF_STATE_DIR: none, JIRA_SITE: 's', JIRA_EMAIL: 'e', JIRA_API_TOKEN: 't' }), {
		site: 's',
		email: 'e',
		token: 't',
	});
});

test('configFromEnv fills only empty variables from the state folder’s .env.local and never overrides a set one', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-jira-env-'));
	fs.writeFileSync(
		path.join(dir, '.env.local'),
		'JIRA_EMAIL=file@example.com\nJIRA_API_TOKEN=file-token\nJIRA_SITE=from-file.example.atlassian.net\n',
	);
	const env = { DF_STATE_DIR: dir, JIRA_EMAIL: 'set@example.com', JIRA_API_TOKEN: '' };
	assert.deepEqual(configFromEnv(env), { site: 'from-file.example.atlassian.net', email: 'set@example.com', token: 'file-token' });
	assert.equal(env.JIRA_EMAIL, 'set@example.com');
	// with no file the variables stay as they are, and JIRA_SITE falls back to sources.jira.site (null by default: no site)
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'df-jira-env-'));
	assert.deepEqual(configFromEnv({ DF_STATE_DIR: empty, JIRA_EMAIL: 'e', JIRA_API_TOKEN: 't' }), { site: null, email: 'e', token: 't' });
});

test('the server entry holds no secret, only the host, and starts the newest installed copy through the launcher', () => {
	const e = entry({ site: 'example.atlassian.net' });
	assert.deepEqual(e.env, { JIRA_SITE: 'example.atlassian.net' });
	assert.equal(entry({}).env, undefined);
	const text = JSON.stringify(e);
	assert.doesNotMatch(text, /JIRA_API_TOKEN|JIRA_EMAIL|password|token/i);
	assert.match(e.args[1], /bin\/dev-factory" path\)\/scripts\/jira-mcp\.mjs/);
	const merged = merge({ mcpServers: { other: { command: 'x' } }, extra: 1 }, 'jira', e);
	assert.deepEqual(Object.keys(merged.mcpServers), ['other', 'jira']);
	assert.equal(merged.extra, 1);
});

test('a run folder that is a link out of the worktree is refused, and a comment can be a ready ADF document', async () => {
	const w = worktree();
	const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-outside-run-'));
	fs.writeFileSync(path.join(outsideDir, 'secret.png'), 'not evidence');
	fs.symlinkSync(outsideDir, path.join(w.dir, '.dev-factory', 'evidence', 'APP-1', 'run-7'));
	const { tools } = server([attachments([]), [/attachments$/, () => assert.fail('must not upload')]]);
	await assert.rejects(
		tools.uploadAttachmentToJiraIssue.run({ issueIdOrKey: 'APP-1', worktree: w.dir, run: 7, fileName: 'secret.png' }),
		/link out of the worktree/,
	);
	const sent = [];
	const c = server([[/^POST \/issue\/APP-1\/comment$/, (m, init) => (sent.push(JSON.parse(init.body)), ok({ id: '1' }))]]);
	const doc = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] };
	await c.tools.addCommentToJiraIssue.run({ issueIdOrKey: 'APP-1', commentBody: doc });
	assert.deepEqual(sent[0].body, doc);
	await assert.rejects(c.tools.addCommentToJiraIssue.run({ issueIdOrKey: 'APP-1', commentBody: { type: 'nope' } }), /commentBody is required/);
});

test('worktreeRoots lists the repository’s worktrees, and nothing outside a repository', () => {
	const here = worktreeRoots(process.cwd());
	assert.ok(here.length >= 1);
	assert.deepEqual(worktreeRoots(fs.mkdtempSync(path.join(os.tmpdir(), 'df-norepo-'))), []);
});

test('tools/list describes each tool’s input as a typed schema with its required fields', async () => {
	const { schemaFor } = await import('../scripts/jira-mcp.mjs');
	assert.deepEqual(
		schemaFor({ jql: 'string', maxResults: 'number?', fields: 'string[]?', transition: '{ id: string }', body: 'string | object' }),
		{
			type: 'object',
			properties: {
				jql: { type: 'string', description: 'string' },
				maxResults: { type: 'number', description: 'number?' },
				fields: { type: 'array', items: { type: 'string' }, description: 'string[]?' },
				transition: { type: 'object', description: '{ id: string }' },
				body: { anyOf: [{ type: 'string' }, { type: 'object' }], description: 'string | object' },
			},
			required: ['jql', 'transition', 'body'],
			additionalProperties: true,
		},
	);
	const listed = await handle(
		{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
		makeTools({ site: 'example.atlassian.net', email: 'a@b.c', token: 't' }),
	);
	for (const t of listed.result.tools) {
		assert.equal(t.inputSchema.type, 'object', t.name);
		for (const [k, p] of Object.entries(t.inputSchema.properties)) assert.ok(p.type || p.anyOf, `${t.name}.${k} has a type`);
	}
	const create = listed.result.tools.find((t) => t.name === 'createJiraIssue');
	assert.deepEqual(create.inputSchema.required, ['projectKey', 'issueTypeName', 'summary']);
});
