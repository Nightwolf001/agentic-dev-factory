import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { asString, clear, describe, read, record } from '../scripts/preflight-alert.mjs';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'df-alert-'));

test('one notification per distinct reason, none when alerts are off, and the record is kept either way', () => {
	const d = dir();
	const sent = [];
	const notify = (t) => sent.push(t);
	assert.equal(record({ dir: d, reason: 'no Jira API token', enabled: false, notify }).notified, false);
	assert.deepEqual(sent, []);
	assert.equal(read(d).reason, 'no Jira API token');
	assert.equal(record({ dir: d, reason: 'no Jira API token', enabled: true, notify }).notified, true, 'the first time it is seen with alerts on');
	assert.equal(record({ dir: d, reason: 'no Jira API token', enabled: true, notify }).notified, false, 'not again every tick');
	assert.equal(
		record({ dir: d, reason: '  no Jira   API token\n', enabled: true, notify }).notified,
		false,
		'whitespace does not make a new reason',
	);
	assert.equal(record({ dir: d, reason: 'gh is not logged in', enabled: true, notify }).notified, true, 'a different reason');
	assert.deepEqual(sent, ['no Jira API token', 'gh is not logged in']);
	assert.equal(record({ dir: d, reason: '', enabled: true, notify }).notified, true);
	assert.equal(read(d).reason, 'the preflight failed');
});

test('passing the preflight clears the record, so the same failure later is announced again', () => {
	const d = dir();
	const sent = [];
	record({ dir: d, reason: 'x broke', enabled: true, notify: (t) => sent.push(t) });
	clear(d);
	assert.equal(read(d), null);
	assert.equal(describe(d), null);
	record({ dir: d, reason: 'x broke', enabled: true, notify: (t) => sent.push(t) });
	assert.equal(sent.length, 2);
});

test('the first and the latest sighting are both kept, and show prints them', () => {
	const d = dir();
	record({ dir: d, reason: 'down', now: new Date('2026-10-01T10:00:00Z') });
	record({ dir: d, reason: 'down', now: new Date('2026-10-01T10:15:00Z') });
	const r = read(d);
	assert.equal(r.since, '2026-10-01T10:00:00.000Z');
	assert.equal(r.at, '2026-10-01T10:15:00.000Z');
	assert.match(describe(d), /last preflight failure: down \(since 2026-10-01T10:00:00\.000Z, last seen 2026-10-01T10:15:00\.000Z\)/);
});

test('a notification centre that is missing does not lose the record or fail the pass', () => {
	const d = dir();
	const r = record({
		dir: d,
		reason: 'down',
		enabled: true,
		notify: () => {
			throw new Error('no osascript');
		},
	});
	assert.equal(r.notified, false);
	assert.equal(read(d).reason, 'down');
	assert.equal(read(d).notifiedFor, null, 'so it is tried again next time');
});

test('the CLI records, shows and clears', () => {
	const d = dir();
	const run = (...a) =>
		spawnSync(process.execPath, [new URL('../scripts/preflight-alert.mjs', import.meta.url).pathname, ...a], {
			encoding: 'utf8',
			env: { ...process.env, DF_STATE_DIR: d },
		});
	assert.equal(run('record', '--reason', 'tracker unreachable').status, 0);
	assert.match(run('show').stdout, /tracker unreachable/);
	run('clear');
	assert.equal(run('show').stdout, '');
	assert.equal(run('bogus').status, 3);
});

test('doctor and scheduler status show the last failure', () => {
	const doctor = fs.readFileSync(new URL('../scripts/doctor.sh', import.meta.url), 'utf8');
	const sched = fs.readFileSync(new URL('../scripts/scheduler.sh', import.meta.url), 'utf8');
	assert.match(doctor, /preflight-alert\.mjs" show/);
	assert.match(sched, /preflight-alert\.mjs" show/);
});

test('the notification text is cut before it is escaped, so it never ends in a lone backslash', () => {
	for (const tail of ['\\', '"', '\\"', 'x']) {
		const s = asString('a'.repeat(199) + tail + 'zzz');
		assert.match(s, /^"(?:[^"\\]|\\.)*"$/, `a well-formed AppleScript string for tail ${JSON.stringify(tail)}`);
	}
	assert.equal(asString('line one\nline two\u0000'), '"line one line two "');
});
