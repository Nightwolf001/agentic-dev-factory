// Atlassian Document Format (what Jira stores comments and descriptions as) to plain text and back, for the pieces the factory
// needs: reading what a person wrote, and writing a comment with real mentions. Not a full ADF library: unknown nodes keep their
// text and lose their structure.

// ADF -> text. Mentions read as @name, a quote line starts with "> ", lists keep their markers, nodes are separated by blank lines.
export function adfToText(node) {
	const inline = (n) => {
		if (!n) return '';
		if (typeof n === 'string') return n;
		switch (n.type) {
			case 'text':
				return n.text ?? '';
			case 'mention':
				return n.attrs?.text ?? `@${n.attrs?.id ?? ''}`;
			case 'hardBreak':
				return '\n';
			case 'emoji':
				return n.attrs?.text ?? n.attrs?.shortName ?? '';
			case 'inlineCard':
			case 'blockCard':
				return n.attrs?.url ?? '';
			default:
				return (n.content ?? []).map(inline).join('');
		}
	};
	const block = (n, indent = '') => {
		if (!n) return '';
		switch (n.type) {
			case 'doc':
				return (n.content ?? [])
					.map((c) => block(c))
					.filter((t) => t !== '')
					.join('\n\n');
			case 'paragraph':
			case 'heading':
				return indent + inline(n);
			case 'blockquote':
				return (n.content ?? [])
					.map((c) => block(c))
					.join('\n')
					.split('\n')
					.map((l) => `> ${l}`)
					.join('\n');
			case 'codeBlock':
				return '```\n' + inline(n) + '\n```';
			case 'bulletList':
			case 'orderedList':
				return (n.content ?? [])
					.map(
						(li, i) =>
							`${indent}${n.type === 'bulletList' ? '-' : `${i + 1}.`} ${block({ type: 'doc', content: li.content }).replace(/\n\n/g, '\n')}`,
					)
					.join('\n');
			default:
				return (n.content ?? []).length ? (n.content ?? []).map((c) => block(c)).join('\n') : inline(n);
		}
	};
	return block(node).trim();
}

// Text -> ADF: blank lines separate paragraphs, a single newline is a hard break, and an @[id|Name] or [~accountid:id] token
// becomes a real mention node, which always notifies the person (a wiki token written through some Jira clients is shown as
// literal text instead).
const TOKEN = /\[~accountid:([A-Za-z0-9:_-]+)\]|@\[([A-Za-z0-9:_-]+)\|([^\]]*)\]/g;

export function textToAdf(text) {
	const paragraphs = String(text ?? '')
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean);
	const content = paragraphs.map((p) => {
		const nodes = [];
		p.split('\n').forEach((line, li) => {
			if (li) nodes.push({ type: 'hardBreak' });
			let at = 0;
			for (const m of line.matchAll(TOKEN)) {
				if (m.index > at) nodes.push({ type: 'text', text: line.slice(at, m.index) });
				const id = m[1] ?? m[2];
				nodes.push({ type: 'mention', attrs: { id, text: `@${m[3] || id}` } });
				at = m.index + m[0].length;
			}
			if (at < line.length) nodes.push({ type: 'text', text: line.slice(at) });
		});
		return { type: 'paragraph', content: nodes };
	});
	return { version: 1, type: 'doc', content: content.length ? content : [{ type: 'paragraph', content: [] }] };
}
