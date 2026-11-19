// The factory runs on the machine that runs its tests, so a test must never reach the docker of that machine (it could list,
// stop or remove a real container). This folder holds a `docker` that refuses every call the way a stopped daemon does, and
// records the arguments in the file named by DF_FAKE_DOCKER_LOG when a test wants to see what was asked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let bin = null;

const SCRIPT = `#!/bin/sh
if [ -n "\${DF_FAKE_DOCKER_LOG:-}" ]; then
	echo "$@" >> "$DF_FAKE_DOCKER_LOG"
fi
echo "Cannot connect to the Docker daemon (fake docker of the test suite)" >&2
exit 1
`;

// The folder, created once per process.
export function noDockerBin() {
	if (bin) return bin;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-test-nodocker-'));
	fs.writeFileSync(path.join(dir, 'docker'), SCRIPT, { mode: 0o755 });
	fs.chmodSync(path.join(dir, 'docker'), 0o755);
	process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
	bin = dir;
	return bin;
}

// A copy of an environment with the fake docker first on PATH.
export function noDockerEnv(env = process.env) {
	return { ...env, PATH: [noDockerBin(), env.PATH].filter(Boolean).join(path.delimiter) };
}
