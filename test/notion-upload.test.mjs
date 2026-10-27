import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkTarget, parseHeaders, upload } from '../scripts/notion-upload-lib.mjs';

const URL_OK = 'https://api.notion.com/v1/file_uploads/1f2e3d4c-0000-4000-8000-123456789abc/send';

function evidenceFile(name = 'home.png') {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nu-')));
	const sub = path.join(dir, '.dev-factory', 'evidence', 'TASK-1', 'run-2');
	fs.mkdirSync(sub, { recursive: true });
	const file = path.join(sub, name);
	fs.writeFileSync(file, 'png-bytes');
	return file;
}

test('headers keep their value, drop Content-Type, and reject a malformed line', () => {
	assert.deepEqual(parseHeaders(['Authorization: Bearer a:b', 'Content-Type: multipart/form-data', 'Notion-Version: 2022-06-28']), {
		Authorization: 'Bearer a:b',
		'Notion-Version': '2022-06-28',
	});
	assert.throws(() => parseHeaders(['no colon']));
	assert.throws(() => parseHeaders(['bad name: x']));
});

test('only an evidence image may go to a Notion file-upload URL', () => {
	const file = evidenceFile();
	assert.equal(checkTarget({ file, url: URL_OK }), file);
	assert.throws(() => checkTarget({ file, url: 'https://evil.example.com/send' }));
	assert.throws(() => checkTarget({ file, url: URL_OK + '/../../pages' }));
	assert.throws(() => checkTarget({ file: '/etc/passwd', url: URL_OK }));
	assert.throws(() => checkTarget({ file: evidenceFile('notes.txt'), url: URL_OK }));
});

test('a symlink out of the evidence folder is refused', () => {
	const file = evidenceFile('link.png');
	fs.rmSync(file);
	fs.symlinkSync('/etc/hosts', file);
	assert.throws(() => checkTarget({ file, url: URL_OK }));
});

test('upload posts multipart with the returned headers and reports the id', async () => {
	const file = evidenceFile();
	let seen;
	const fetchImpl = async (url, init) => {
		seen = { url, init };
		return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'abc', status: 'uploaded' }) };
	};
	const r = await upload({ file, url: URL_OK, headers: ['Authorization: Bearer x'] }, fetchImpl);
	assert.deepEqual(r, { ok: true, status: 200, id: 'abc', uploadStatus: 'uploaded', error: null });
	assert.equal(seen.url, URL_OK);
	assert.equal(seen.init.method, 'POST');
	assert.equal(seen.init.headers.Authorization, 'Bearer x');
	assert.equal(seen.init.body.get('file').name, 'home.png');
});

test('the MCP flavour of the upload URL, with a lower-case authorization header, is accepted', () => {
	const file = evidenceFile();
	const url = 'https://api.notion.com/v1/mcp/file_uploads/40682a3e-9a5b-81c4-814a-00b27bb31b58/send';
	assert.equal(checkTarget({ file, url }), file);
	assert.deepEqual(parseHeaders(['authorization: Bearer eyJ.a+b/c=']), { authorization: 'Bearer eyJ.a+b/c=' });
	assert.throws(() => checkTarget({ file, url: url.replace('/mcp/', '/mcp/x/') }));
});

test('a failed upload carries the status and a short error', async () => {
	const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'nope' });
	const r = await upload({ file: evidenceFile(), url: URL_OK }, fetchImpl);
	assert.equal(r.ok, false);
	assert.equal(r.status, 400);
	assert.equal(r.error, 'nope');
});
