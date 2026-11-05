// Shared by the settings page and its commands.
//   optionCatalog()   the groups and every setting of config.json: its group, title, type, scope hint and DF_* variable
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A fresh copy on every call, so a caller can sort or edit it freely.
export function optionCatalog() {
	return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'settings', 'options.json'), 'utf8'));
}
