// Sends one QA screenshot to the upload URL that notion-create-file-upload handed out. The scheduler uses this
// instead of a hand-typed curl: the shape of a shell command is easy to get slightly wrong (a `;type=` suffix, a
// quoted URL), and the guard then refuses it. Everything the request may touch is checked here instead.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_BYTES = 20 * 1024 * 1024;
const UPLOAD_URL = /^https:\/\/api\.notion\.com\/v1\/(?:mcp\/)?file_uploads\/[0-9a-f-]{32,36}\/send$/i;
const EVIDENCE = /(^|\/)\.dev-factory\/evidence\/[\w.-]+\/run-\d+\/[\w.-]+\.(png|jpe?g|gif|webp)$/i;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// "Name: value" strings as printed in upload_headers. Content-Type is dropped: fetch sets the multipart boundary.
export function parseHeaders(list) {
	const headers = {};
	for (const h of list) {
		const i = h.indexOf(':');
		if (i < 1) throw new Error(`header is not "Name: value": ${h.slice(0, 20)}`);
		const name = h.slice(0, i).trim();
		if (!/^[\w-]+$/.test(name)) throw new Error(`bad header name: ${name.slice(0, 20)}`);
		if (name.toLowerCase() !== 'content-type') headers[name] = h.slice(i + 1).trim();
	}
	return headers;
}

export function checkTarget({ file, url }) {
	if (!UPLOAD_URL.test(url ?? ''))
		throw new Error('url must be the upload_url notion-create-file-upload returned (https://api.notion.com/v1/[mcp/]file_uploads/<id>/send)');
	const resolved = path.resolve(file ?? '');
	if (!EVIDENCE.test(resolved.split(path.sep).join('/'))) throw new Error('file must be an image under .dev-factory/evidence/<KEY>/run-<N>/');
	if (!EVIDENCE.test(fs.realpathSync(resolved).split(path.sep).join('/'))) throw new Error('file resolves outside .dev-factory/evidence');
	const size = fs.statSync(resolved).size;
	if (size > MAX_BYTES) throw new Error(`file is ${size} bytes; the single-part upload limit is ${MAX_BYTES}`);
	return resolved;
}

export async function upload({ file, url, headers = [] }, fetchImpl = fetch) {
	const resolved = checkTarget({ file, url });
	const ext = path.extname(resolved).slice(1).toLowerCase();
	const form = new FormData();
	form.append('file', new Blob([fs.readFileSync(resolved)], { type: TYPES[ext] }), path.basename(resolved));
	const r = await fetchImpl(url, { method: 'POST', headers: parseHeaders(headers), body: form });
	const body = await r.text();
	let parsed = null;
	try {
		parsed = JSON.parse(body);
	} catch {}
	return { ok: r.ok, status: r.status, id: parsed?.id ?? null, uploadStatus: parsed?.status ?? null, error: r.ok ? null : body.slice(0, 300) };
}
