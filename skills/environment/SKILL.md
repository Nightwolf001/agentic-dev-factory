---
name: environment
description: Start, verify and tear down the isolated e2e environment for a worktree. Use before building, before QA, and when a service looks unhealthy.
---

# Environment

`scripts/e2e-env.sh` runs the same sequence the CI e2e workflows run (compose up, `startup.sh --use-npmci`, `startup-pm2.sh`, readiness poll) against an isolated compose project named `df-<key>`.

| Command                                       | What it guarantees                                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up --key KEY [--ports canonical] [--device]` | Environment started and `verify` passed. Exit 75 means a cap or the ports lock refused it: stop, a later pass retries.                                                                                        |
| `verify`                                      | Compose config renders, every service is running or healthy, pm2 processes match `ecosystem.config.js`, `https://api.olarm.local/api/v4/ping` answers from inside the devcontainer. Prints a diff on failure. |
| `down`                                        | `down -v` and forgets the environment.                                                                                                                                                                        |
| `sweep`                                       | Removes `df-*` projects with no live owner.                                                                                                                                                                   |

Facts you rely on:

-   `.dev-factory/env.json` holds `project`, `composeFile`, `mode`. Every container command is `docker compose -f <composeFile> -f .dev-factory/compose.override.yml -p <project> exec -T -u node devcontainer <cmd>`.
-   Isolated mode (`--ports none`) publishes no host ports and has no web-QA path: the Playwright MCP server runs on the host. Use `--ports canonical` for any ticket that needs a browser walk; `webBaseUrl` in `env.json` is the address to open.
-   Canonical-ports mode (`--ports canonical`, implied by `--device`) keeps the published ports and is machine-wide exclusive.
-   Run `verify` again before QA starts and after any service restart. A failing verify is never a reason to skip QA; it is a reason to block.

## Mobile (device lane)

`up --device` starts the backend with canonical ports under a machine-wide lock, then `scripts/mobile-env.sh up` prepares the host side: boots (or reuses) the simulator named in `qa/profiles.yaml` (falls back to any available iPhone), points `clients/mobile/.env` at the local backend, starts Metro from this worktree on `DF_METRO_PORT` (default 8081; exit 75 if something else holds it, never killed), builds and installs the app only when `ios/Podfile.lock` or the Xcode project changed since the last build on this machine, and warms the JS bundle. The udid and Metro port are recorded under `device` in `.dev-factory/env.json`; pass that udid to every Maestro MCP call. `down` stops this worktree's Metro and leaves the simulator booted.
