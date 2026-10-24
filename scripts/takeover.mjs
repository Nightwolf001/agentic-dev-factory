// The takeover toggle: whether agents may stop, kill and quit whatever stands in the way of a run (processes and containers
// on its ports, browser and Maestro sessions, simulators). Off by default; on with cleanup.takeover in the config, or
// DF_TAKEOVER=1 for one run on one machine.
//
//   takeover.mjs        exit 0 when takeover is on, 1 when it is off (for shell scripts)
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';

export function takeoverOn({ cfg, env = process.env } = {}) {
	try {
		return get('cleanup.takeover', { config: cfg ?? load(), env }) === true;
	} catch {
		return false;
	}
}

if (isMain(import.meta.url)) process.exit(takeoverOn() ? 0 : 1);
