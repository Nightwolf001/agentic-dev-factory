// Turns the dev-factory plugin on in one settings file. install.sh targets .claude/settings.local.json, which is
// not committed, so only the machine that runs the factory loads its hooks and MCP servers.
//
//   enable-plugin.mjs SETTINGS_FILE PLUGIN_DIR
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './is-main.mjs';

export function enablePlugin(settings, pluginDir) {
	return {
		...settings,
		extraKnownMarketplaces: { ...settings.extraKnownMarketplaces, 'dev-factory': { source: { source: 'directory', path: pluginDir } } },
		enabledPlugins: { ...settings.enabledPlugins, 'dev-factory@dev-factory': true },
	};
}

if (isMain(import.meta.url)) {
	const [file, pluginDir] = process.argv.slice(2);
	if (!file || !pluginDir) {
		console.error('usage: enable-plugin.mjs SETTINGS_FILE PLUGIN_DIR');
		process.exit(3);
	}
	let current = {};
	try {
		current = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		/* a new file */
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(enablePlugin(current, pluginDir), null, '\t') + '\n');
}
