import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// True when this module is the script node was started with. argv[1] keeps symlinks and import.meta.url is
// percent-encoded, so comparing them as strings silently skips main() under a symlink or a path with a space.
export function isMain(metaUrl) {
	if (!process.argv[1]) return false;
	try {
		return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
	} catch {
		return false;
	}
}
