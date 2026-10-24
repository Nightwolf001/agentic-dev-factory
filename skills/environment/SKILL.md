---
name: environment
description: Start, verify and tear down the isolated e2e environment for a worktree. Use before building, before QA, and when a service looks unhealthy.
---

# Environment

`scripts/e2e-env.sh` starts the environment the config describes (`environment.*`). With `type` `none` (the default) there is nothing to start: tests run on the host and `up` only records that. With `type` `compose` it builds an isolated compose project named `df-<key>`, runs each `environment.setup` command inside `environment.service`, and polls `environment.pingUrl`.

| Command                                       | What it guarantees                                                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up --key KEY [--ports canonical] [--device]` | Environment started and `verify` passed. Exit 75 means a cap or the ports lock refused it: stop, a later pass retries.                                                                                          |
| `verify`                                      | Compose config renders, every service is running or healthy, `environment.processCheck` (when set) exits 0 inside the service, and `environment.pingUrl` (when set) answers from inside it. Prints what failed. |
| `down`                                        | `down -v` and forgets the environment.                                                                                                                                                                          |
| `sweep`                                       | Removes `df-*` projects with no live owner.                                                                                                                                                                     |
| `node scripts/cleanup.mjs --worktree DIR`     | After every run: `down`, stops the dev server and the simulator this run booted, closes Playwright and Maestro sessions, frees the ports lock; prints what it did and what it left.                             |

Facts you rely on:

-   A finished run leaves nothing running. `scripts/cleanup.mjs` stops only what the run started unless the owner set `cleanup.takeover` (or `DF_TAKEOVER=1` for one run): then it also stops the processes and containers holding the ports the run needs (`cleanup.ports` adds more) and the leftover browser and Maestro sessions. It never touches the shell, Claude, the terminal or system processes, and an agent cannot switch the toggle on for itself.

-   `.dev-factory/env.json` holds `project`, `composeFile`, `mode`. Every container command is `docker compose -f <composeFile> -f .dev-factory/compose.override.yml -p <project> exec -T [-u <environment.user>] <environment.service> <cmd>`.
-   Isolated mode (`--ports none`) publishes no host ports and has no web-QA path: the Playwright browser runs on the host. Use `--ports canonical` for any ticket that needs a browser walk; `webBaseUrl` in `env.json` is the address to open.
-   Canonical-ports mode (`--ports canonical`, implied by `--device`) keeps the published ports and is machine-wide exclusive.
-   Run `verify` again before QA starts and after any service restart. A failing verify is never a reason to skip QA; it is a reason to block.

## Mobile (device lane)

Only when `mobile.appDir` is set. `up --device` starts the backend with canonical ports under a machine-wide lock, then `scripts/mobile-env.sh up` prepares the host side: boots (or reuses) the simulator named in the mobile profile of `qa/profiles.yaml` (falls back to any available iPhone), runs `mobile.prepare`, `mobile.install` and `mobile.pods` when the app's dependencies are missing, starts the dev server with `mobile.start` from this worktree on `mobile.metroPort` (exit 75 if something else holds the port, never killed), runs `mobile.build` and installs the app only when a file matching `mobile.nativeInputs` changed since the last build on this machine, and warms the JS bundle. The udid and port are recorded under `device` in `.dev-factory/env.json`; pass that udid to every Maestro MCP call. `down` stops this worktree's dev server; `scripts/cleanup.mjs` also shuts the simulator down again when this run booted it.
