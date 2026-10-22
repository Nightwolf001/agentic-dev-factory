// Where the plugin is installed. Commands, skills and agents get ${CLAUDE_PLUGIN_ROOT} substituted by Claude Code; scripts
// that need to name a path (hook messages, the CLI) use this instead, so they work from the marketplace cache, from a
// clone loaded with --plugin-dir, and from a vendored copy alike.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// `node "<root>/bin/qa.mjs" ...`, quoted because a cache path can contain spaces.
export const qaCommand = (args = '') => `node "${path.join(PLUGIN_ROOT, 'bin', 'qa.mjs')}"${args ? ` ${args}` : ''}`;
