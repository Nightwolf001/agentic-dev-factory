// Patterns the repository-wide sweeps share. Not a test file (node --test only runs *.test.mjs).

// Shapes of real credentials. A fake in a test fixture is deliberately written in a shape that does not match these.
export const TOKEN_SHAPES = [
	['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
	['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
	['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/],
	['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
	['OpenAI-style key', /\bsk-[A-Za-z0-9]{40,}\b/],
	['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
	['Atlassian API token', /\bATATT3[A-Za-z0-9_=-]{30,}\b/],
	['Notion token', /\b(?:secret_[A-Za-z0-9]{40,}|ntn_[A-Za-z0-9]{30,})\b/],
	['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
	['JWT', /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/],
];

// An address of a real tracker site: a subdomain of a hosted tracker that is not a placeholder
export const TRACKER_SITE = /\b(?!example\b|your[a-z-]*\b|acme\b|site\b|my-?company\b|test\b)[a-z0-9][a-z0-9-]{1,40}\.atlassian\.net\b/i;

// The anchor GitHub gives a heading
export const slug = (heading) =>
	heading
		.trim()
		.toLowerCase()
		.replace(/`/g, '')
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.replace(/\s/g, '-');
