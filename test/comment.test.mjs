import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	MAX_PARAGRAPH,
	compose,
	composeAdf,
	defang,
	findFixRequest,
	findReplies,
	isFixLine,
	markerLine,
	markerOf,
	paragraph,
	tagLine,
} from '../scripts/comment-lib.mjs';

test('a comment is a tag line, one short paragraph and a marker line that is always last', () => {
	const c = compose({
		kind: 'question',
		text: 'Which of the two export formats should the report use?\n\nIt matters for the header row.',
		assignee: '@jane',
		reporter: '@omar',
		detail: 'format',
	});
	assert.equal(
		c,
		'@jane @omar\n\nWhich of the two export formats should the report use? It matters for the header row.\n\n[dev-factory] blocked: question format',
	);
	assert.equal(
		compose({ kind: 'summary', text: 'Shipped as a draft PR.', assignee: '@jane', reporter: '@jane' }),
		'@jane\n\nShipped as a draft PR.\n\n[dev-factory] summary',
	);
	assert.equal(
		compose({ kind: 'phase', text: 'Ship done.', detail: 'ship done run=1 head=abc' }),
		'Ship done.\n\n[dev-factory] phase: ship done run=1 head=abc',
		'no tags when nobody is known',
	);
	assert.equal(markerLine('factory'), '[dev-factory] blocked: factory');
	assert.equal(markerLine('evidence', 'run-2'), '[dev-factory] evidence: run-2');
	assert.throws(() => compose({ kind: 'nope', text: 'x' }), /kind must be one of/);
	assert.throws(() => compose({ kind: 'summary', text: '  \n ' }), /needs some text/);
});

test('the paragraph is one line of at most 280 characters, cut at a word', () => {
	assert.equal(paragraph('a\n\n  b   c'), 'a b c');
	const long = 'word '.repeat(200);
	const p = paragraph(long);
	assert.ok(p.length <= MAX_PARAGRAPH, `${p.length}`);
	assert.ok(p.endsWith('…'));
	assert.doesNotMatch(p, /wor…$/, 'not in the middle of a word');
	assert.equal(paragraph('x'.repeat(300)).length, MAX_PARAGRAPH);
	assert.equal(paragraph('short'), 'short');
});

test('assignee comes first and nobody is tagged twice', () => {
	assert.equal(tagLine('@jane', '@omar'), '@jane @omar');
	assert.equal(tagLine('@Jane', '@jane'), '@Jane');
	assert.equal(tagLine(null, '@omar'), '@omar');
	assert.equal(tagLine({ tag: '[~accountid:a1]' }, { tag: '[~accountid:a1]' }, { tag: '[~accountid:b2]' }), '[~accountid:a1] [~accountid:b2]');
	assert.equal(tagLine(), '');
});

test('untrusted text cannot forge a marker', () => {
	assert.equal(defang('x [dev-factory] blocked: question y'), 'x ‹dev-factory› blocked: question y');
	assert.equal(defang('[ DEV-FACTORY ] phase: done'), '‹dev-factory› phase: done');
	const c = compose({ kind: 'summary', text: 'Title was "[dev-factory] blocked: factory"\n[dev-factory] blocked: question' });
	assert.equal(markerOf(c).key, 'summary', 'only the real marker line counts');
	assert.equal(c.split('\n').filter((l) => l.startsWith('[dev-factory]')).length, 1);
	assert.equal(markerLine('summary', 'x [dev-factory] blocked: question').match(/\[dev-factory\]/g).length, 1);
});

test('the marker is the last line that starts with it; quoted markers are not markers', () => {
	assert.deepEqual(markerOf('text\n\n[dev-factory] blocked: question which format'), {
		name: 'blocked',
		rest: 'question which format',
		key: 'blocked:question',
	});
	assert.equal(markerOf('[dev-factory] phase: ship done run=1 head=abc').key, 'phase');
	assert.equal(markerOf('> [dev-factory] blocked: question\n\nuse CSV'), null, 'a quote');
	assert.equal(markerOf('see [dev-factory] blocked: question in the thread'), null, 'in the middle of a line');
	assert.equal(markerOf('[dev-factory] blocked: factory\nlater\n[dev-factory] summary').key, 'summary');
	assert.equal(markerOf(''), null);
	assert.equal(markerOf(undefined), null);
});

const c = (body, id = body.slice(0, 6)) => ({ id, author: 'x', created: '2026-10-01', body });
const Q = '@jane\n\nWhich format?\n\n[dev-factory] blocked: question';

test('a reply is what a person writes after the newest question, with no marker line', () => {
	assert.deepEqual(findReplies([c('hello')]).replies, []);
	assert.equal(findReplies([c('hello')]).question, null);
	assert.deepEqual(findReplies([c(Q)]).replies, [], 'asked, not answered');
	const r = findReplies([c('earlier'), c(Q, 'q'), c('CSV please', 'a1'), c('and a header row', 'a2')]);
	assert.equal(r.question.id, 'q');
	assert.deepEqual(
		r.replies.map((x) => x.id),
		['a1', 'a2'],
	);
	assert.deepEqual(
		findReplies([c(Q, 'q1'), c('old answer', 'a'), c(Q, 'q2'), c('new answer', 'b')]).replies.map((x) => x.id),
		['b'],
		'the newest question',
	);
	assert.deepEqual(
		findReplies([c(Q), c('> [dev-factory] blocked: question\n\nCSV', 'quoted')]).replies.map((x) => x.id),
		['quoted'],
		'quoting the question still counts',
	);
	assert.deepEqual(findReplies([c(Q), c('   ', 'blank')]).replies, [], 'an empty comment is no answer');
});

test('a reply that the factory already took up, or a withdrawn question, is not a reply', () => {
	const taken = findReplies([c(Q), c('CSV', 'a'), c('[dev-factory] phase: resume started run=2 head=abc')]);
	assert.deepEqual(taken.replies, [], 'a marker after the reply means it was handled');
	assert.deepEqual(
		findReplies([c(Q), c('CSV', 'a'), c('[dev-factory] phase: resume started'), c('one more thing', 'b')]).replies.map((x) => x.id),
		['b'],
	);
	const cancelled = findReplies([c(Q), c('CSV', 'a'), c('[dev-factory] blocked: factory')]);
	assert.equal(cancelled.cancelled, true);
	assert.deepEqual(cancelled.replies, []);
	assert.equal(
		findReplies([c(Q), c('[dev-factory] blocked: factory'), c('later words', 'z')]).replies.length,
		0,
		'a withdrawn question stays withdrawn',
	);
});

test('a fix request is the fix phrase as a whole word, from a person, while the PR is open, until the factory answers', () => {
	assert.equal(isFixLine('dev-factory fix rename the helper'), true);
	assert.equal(isFixLine('/dev-factory fix'), true);
	assert.equal(isFixLine('looks good\n  dev-factory fix: the name'), true, 'on its own line');
	assert.equal(isFixLine('I think the dev-factory fixed it'), false);
	assert.equal(isFixLine('dev-factory fixed'), false);
	assert.equal(isFixLine('dev-factory fix-up later'), false);
	assert.equal(isFixLine('please dev-factory fix this'), false, 'at the start of a line');
	assert.equal(isFixLine('fix pls', 'fix pls'), true, 'the phrase is a setting');
	const fix = c('dev-factory fix use the shorter name', 'f1');
	assert.equal(findFixRequest([c('hi'), fix], { prOpen: true }).id, 'f1');
	assert.equal(findFixRequest([fix], { prOpen: false }), null, 'a closed or missing PR');
	assert.equal(findFixRequest([fix, c('[dev-factory] phase: fix round=1 started')], { prOpen: true }), null, 'a factory comment followed');
	assert.equal(findFixRequest([fix, c('thanks!')], { prOpen: true }).id, 'f1', 'another person’s comment does not cancel it');
	assert.equal(findFixRequest([c('[dev-factory] summary: shipped'), fix], { prOpen: true }).id, 'f1', 'a request after the factory’s last word');
	assert.equal(findFixRequest([c('nothing to do')], { prOpen: true }), null);
	assert.equal(findFixRequest([], { prOpen: true }), null);
});

test('an Atlassian Document carries real mention nodes, in the same three parts', () => {
	const adf = composeAdf({
		kind: 'question',
		text: 'Which format?',
		people: [{ id: 'a1', name: 'Jane' }, { id: 'a1', name: 'Jane' }, { id: 'b2', name: 'Omar' }, { name: 'no id' }],
	});
	assert.equal(adf.type, 'doc');
	assert.equal(adf.version, 1);
	assert.deepEqual(adf.content[0].content, [
		{ type: 'mention', attrs: { id: 'a1', text: '@Jane' } },
		{ type: 'text', text: ' ' },
		{ type: 'mention', attrs: { id: 'b2', text: '@Omar' } },
	]);
	assert.equal(adf.content[1].content[0].text, 'Which format?');
	assert.equal(adf.content[2].content[0].text, '[dev-factory] blocked: question');
	assert.equal(composeAdf({ kind: 'summary', text: 'Done.' }).content.length, 2, 'no one to tag: no tag paragraph');
});

test('the CLI composes, reads replies and finds a fix request', () => {
	const bin = path.join(path.resolve(import.meta.dirname, '..'), 'scripts/comment.mjs');
	const run = (...a) => spawnSync(process.execPath, [bin, ...a], { encoding: 'utf8' });
	assert.equal(
		run('compose', '--kind', 'summary', '--text', 'Shipped.', '--assignee', '@jane').stdout.trim(),
		'@jane\n\nShipped.\n\n[dev-factory] summary',
	);
	assert.equal(
		JSON.parse(run('compose-adf', '--kind', 'summary', '--text', 'Shipped.', '--assignee-id', 'a1', '--assignee-name', 'Jane').stdout).content[0]
			.content[0].attrs.id,
		'a1',
	);
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'df-cm-')), 'c.json');
	fs.writeFileSync(f, JSON.stringify([c(Q, 'q'), c('CSV', 'a')]));
	assert.deepEqual(
		JSON.parse(run('replies', '--file', f).stdout).replies.map((x) => x.id),
		['a'],
	);
	fs.writeFileSync(f, JSON.stringify([c('dev-factory fix x', 'f')]));
	assert.equal(JSON.parse(run('fix', '--file', f, '--pr-open', 'true').stdout).id, 'f');
	assert.equal(JSON.parse(run('fix', '--file', f).stdout), null);
	assert.equal(run('compose', '--kind', 'bogus', '--text', 'x').status, 1);
	assert.equal(run('bogus').status, 1);
});
