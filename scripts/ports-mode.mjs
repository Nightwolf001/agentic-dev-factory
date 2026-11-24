// Which ports a task's stack starts with, so the pass and /dev-factory:build ask e2e-env.sh for the same thing.
//
//   ports-mode.mjs [--device]     prints canonical, direct or none
//
// environment.ports decides; `auto` (the default) picks the mode that lets this task build beside any other, in this repository or
// another, whenever the engine allows it:
//   direct     environment.webBaseUrl is set and the engine names each container (OrbStack), or caps.maxConcurrent is above 1
//              (the person said the engine can): the stack publishes nothing and takes no lock, and the host, the iOS simulator
//              and, through the container's IP, the Android emulator reach it at its own address
//   canonical  otherwise, while caps.maxConcurrent is 1, or for a device task: the compose file's host ports under the machine-wide
//              ports lock, so a second canonical task, here or in another repository, waits for the first
//   none       otherwise: a web task with no address to open, with caps.maxConcurrent above 1, publishes nothing
// A device task never runs `none`: the device lane needs the backend reachable from this machine.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get, load } from './config.mjs';
import { isMain } from './is-main.mjs';

export const PORTS_MODES = ['auto', 'canonical', 'direct', 'none'];

// OrbStack gives every container a name this machine resolves; Docker Desktop and the others do not. The Docker client's current
// context says which engine it talks to, read from its config file (DOCKER_CONTEXT, else currentContext in $DOCKER_CONFIG/config.json),
// which works inside the pass's sandbox where the engine's socket may not; `docker info` is the fallback when no context is named.
export function engineNamesContainers(run = spawnSync, env = process.env, read = (f) => fs.readFileSync(f, 'utf8')) {
	let context = env.DOCKER_CONTEXT || '';
	if (!context)
		try {
			context =
				JSON.parse(read(path.join(env.DOCKER_CONFIG || path.join(env.HOME || os.homedir(), '.docker'), 'config.json'))).currentContext || '';
		} catch {
			/* no config file */
		}
	if (context) return /orbstack/i.test(context);
	const r = run('docker', ['info', '--format', '{{.OperatingSystem}}'], { encoding: 'utf8', timeout: 15000 });
	return r.status === 0 && /orbstack/i.test(String(r.stdout ?? ''));
}

export function portsMode({ cfg, device = false, namesContainers = () => engineNamesContainers() } = {}) {
	const at = (k) => get(k, { config: cfg });
	const set = String(at('environment.ports') ?? 'auto');
	if (set === 'canonical' || set === 'direct') return set;
	if (set === 'none') return device ? 'canonical' : 'none';
	const max = Number(at('caps.maxConcurrent') ?? 1);
	const web = at('environment.webBaseUrl');
	if (web && (max > 1 || namesContainers())) return 'direct';
	if (device || max <= 1) return 'canonical';
	return 'none';
}

if (isMain(import.meta.url)) {
	const device = process.argv.includes('--device');
	console.log(portsMode({ cfg: load(), device }));
}
