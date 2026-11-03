// The takeover toggle: whether agents may stop, kill and quit whatever stands in the way of a run (processes and containers
// on its ports, browser and Maestro sessions, simulators). Off by default, and only the machine's owner turns it on: with
// DF_TAKEOVER=1 in the environment of the scheduled job (`<state>/.env.local`) or of the shell that starts a run.
//
// It is read from the environment alone. A repository's config file is something a run can edit and a command line is
// something an agent writes, so neither can switch it on; the guard also refuses a command that sets DF_TAKEOVER.
//
//   takeover.mjs        exit 0 when takeover is on, 1 when it is off (for shell scripts)
import { isMain } from './is-main.mjs';

export const TAKEOVER_VAR = 'DF_TAKEOVER';

export function takeoverOn({ env = process.env } = {}) {
	return /^(1|true|yes|on)$/i.test(String(env[TAKEOVER_VAR] ?? '').trim());
}

if (isMain(import.meta.url)) process.exit(takeoverOn() ? 0 : 1);
