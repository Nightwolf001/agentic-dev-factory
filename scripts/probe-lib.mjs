// The request behind `qa.mjs probe`: an API case is walked by sending the request and keeping what came back as evidence.
// Written to be hard to misuse. It talks only to this machine or to a host the environment's env.json names, never follows
// a redirect, refuses credentials in the URL and control characters in a header, reads at most 64 KB of the answer, keeps 4 KB
// of it (with personal data and secrets replaced), stores the NAMES of the headers it sent and not their values, and keeps
// request values out of its error messages, which end up in logs.
import { redactText } from './scrub-lib.mjs';

export const LIMITS = { read: 64 * 1024, excerpt: 4 * 1024, requestBody: 64 * 1024, timeoutMs: 15_000 };

export class ProbeError extends Error {}

const LOCAL = ['localhost', '127.0.0.1', '[::1]'];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const hostOf = (value) => {
	try {
		return new URL(String(value)).hostname.toLowerCase();
	} catch {
		return null;
	}
};

// Hosts a probe may reach: this machine, and the hosts env.json names (`hosts`, and the hosts of its address fields).
export function allowedHosts(env = {}) {
	const out = new Set(LOCAL);
	for (const h of Array.isArray(env.hosts) ? env.hosts : []) if (typeof h === 'string' && h) out.add(h.toLowerCase().replace(/:\d+$/, ''));
	for (const k of ['webBaseUrl', 'apiBaseUrl', 'baseUrl', 'pingUrl']) {
		const h = hostOf(env[k]);
		if (h) out.add(h);
	}
	const remote = hostOf(env.remote?.url);
	if (remote) out.add(remote);
	return out;
}

// -> { url: URL, method, headers: [[name, value]] }; throws ProbeError without quoting any value it was given
export function checkRequest({ url, method = 'GET', headers = [], bodyBytes = 0, env = {} }) {
	let u;
	try {
		u = new URL(String(url));
	} catch {
		throw new ProbeError('the URL does not parse');
	}
	if (!['http:', 'https:'].includes(u.protocol)) throw new ProbeError('only http and https URLs can be probed');
	if (u.username || u.password) throw new ProbeError('the URL carries credentials; send them as a header');
	if (!allowedHosts(env).has(u.hostname.toLowerCase()))
		throw new ProbeError('that host is not this machine and not named in .dev-factory/env.json (hosts, webBaseUrl, apiBaseUrl)');
	const m = String(method).toUpperCase();
	if (!METHODS.includes(m)) throw new ProbeError(`method must be one of ${METHODS.join(', ')}`);
	if (bodyBytes > LIMITS.requestBody) throw new ProbeError(`the request body is over ${LIMITS.requestBody} bytes`);
	const out = [];
	for (const h of headers) {
		const text = String(h);
		const at = text.indexOf(':');
		const name = at > 0 ? text.slice(0, at).trim() : '';
		const value = at > 0 ? text.slice(at + 1).trim() : '';
		if (!HEADER_NAME.test(name)) throw new ProbeError('a header is not written as Name: value');
		if (/[\r\n\0]/.test(text)) throw new ProbeError('a header holds a line break or NUL');
		if (/^(host|content-length|connection|transfer-encoding)$/i.test(name))
			throw new ProbeError(`the ${name} header is set by the request itself`);
		out.push([name, value]);
	}
	return { url: u, method: m, headers: out };
}

async function readCapped(res, cap) {
	if (!res.body) return { buf: Buffer.alloc(0), truncated: false };
	const reader = res.body.getReader();
	const chunks = [];
	let size = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		chunks.push(Buffer.from(value));
		if (size >= cap) {
			truncated = true;
			await reader.cancel().catch(() => {});
			break;
		}
	}
	return { buf: Buffer.concat(chunks).subarray(0, cap), truncated };
}

// -> the record that is kept as evidence. `fetchImpl` is injectable for tests.
export async function probe({
	url,
	method,
	headers = [],
	body = null,
	expectStatus = null,
	env = {},
	secrets = [],
	extraPatterns = [],
	fetchImpl = fetch,
}) {
	const bodyBytes = body == null ? 0 : Buffer.byteLength(body);
	const req = checkRequest({ url, method, headers, bodyBytes, env });
	const started = Date.now();
	let res;
	let buf;
	let truncated;
	try {
		res = await fetchImpl(req.url, {
			method: req.method,
			headers: Object.fromEntries(req.headers),
			body: body != null && !['GET', 'HEAD'].includes(req.method) ? body : undefined,
			redirect: 'manual',
			signal: AbortSignal.timeout(LIMITS.timeoutMs),
		});
		// the same deadline covers the body: a server that sends the headers and then stalls ends here too
		({ buf, truncated } = await readCapped(res, LIMITS.read));
	} catch (e) {
		// never e.message or e.cause: they can quote the URL, the query and header values
		const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
		throw new ProbeError(
			timeout
				? `no answer within ${LIMITS.timeoutMs / 1000} seconds`
				: `the request failed (${e?.cause?.code ?? e?.code ?? e?.name ?? 'error'})`,
		);
	}
	const redacted = redactText(buf.subarray(0, LIMITS.excerpt).toString('utf8'), { secrets, extraPatterns });
	// redaction can make the text longer (a marker is longer than a short address): cut after, so the cap holds
	if (Buffer.byteLength(redacted.text) > LIMITS.excerpt) redacted.text = Buffer.from(redacted.text).subarray(0, LIMITS.excerpt).toString('utf8');
	const want = expectStatus == null ? null : Number(expectStatus);
	return {
		method: req.method,
		host: req.url.host,
		path: req.url.pathname,
		queryNames: [...new Set([...req.url.searchParams.keys()])],
		requestHeaderNames: req.headers.map(([n]) => n),
		requestBodyBytes: bodyBytes,
		status: res.status,
		expectStatus: want,
		ok: want == null ? res.status >= 200 && res.status < 300 : res.status === want,
		contentType: res.headers.get('content-type'),
		responseHeaderNames: [...res.headers.keys()],
		bodyBytes: buf.length,
		truncated: truncated || buf.length > LIMITS.excerpt,
		bodyExcerpt: redacted.text,
		redactions: redacted.redactions,
		ms: Date.now() - started,
		at: new Date().toISOString(),
	};
}
