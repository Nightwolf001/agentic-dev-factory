# Concurrent task environments on OrbStack

Design, 2026-11-19. Written after slice 0 (`docs/superpowers/specs/2026-11-19-slice-0-safety-fixes-design.md`) and the mobile track; it depends on neither being finished except where it says so.

## Intent

The owner is moving the factory from Docker Desktop to OrbStack and wants each task to behave like an isolated machine of its own, so several tasks can run at once and each can use the same ports (3000, 5432 and so on) without colliding.

Today a task that needs the host to reach its stack (a Playwright browser for web QA) must use `--ports canonical`, which publishes the stack's ports on the Mac and takes one machine-wide lock (`$STATE/ports.lock`), so only one such environment can exist at a time. That lock is the reason `caps.maxConcurrent` is 1. `--ports none` already lets any number of stacks coexist, but nothing on the host can reach them.

## Goals

1. Two or more tasks with the same compose file are up at the same time, each reachable from the Mac at an address of its own on the same container ports, with no lock between them.
2. Web QA in a host browser works against such an environment.
3. The path to concurrent mobile QA is known, even if it is not built here.

## Non-goals

-   One OrbStack Linux machine per task, each with its own Docker. Heavy, rebuilds images per task, and shares the Mac's files by default.
-   Running the QA browser inside each task's network.
-   Changing the default of `caps.maxConcurrent`. It stays 1 until the owner raises it.
-   Publishing random host ports per task (the engine-neutral alternative). Kept as the fallback if the spike below fails.

## Anti-goals

-   A direct-address mode that silently falls back to `canonical` and takes the lock, or to a published port that collides.
-   Raising `maxConcurrent` while two runs can still read each other's `active-run.json`.
-   Any change that makes a test or the factory control the engine (see goal 8 of the slice 0 design).

## Constraints

-   `AGENTS.md` applies: a new setting goes in `config.json`, `scripts/config.mjs`, `settings/options.json` and `docs/reference.md`; behaviour in `scripts/e2e-env.sh` gets tests in `test/e2e-env.test.mjs`; shell scripts run under bash 3.2; nothing in the plugin names a company or host.
-   The factory is live on this machine: tests run only in the sandbox described in the slice 0 plan, and the spike below runs by hand, on the owner's machine, not from a pass.
-   OrbStack's behaviour is taken from its documented features (a container is reachable from the Mac by its IP and by a name of the form `<service>.<project>.orb.local`). None of it has been run here, so the spike comes first.

## Approaches

1. **Direct addresses through OrbStack.** Chosen by the owner. Keep compose's per-task network and publish no host ports; the host reaches each stack at its own address on the stack's own ports. Small change, uses what OrbStack does better than Docker Desktop. Fails for anything with `localhost:<port>` written into it.
2. **Random free host ports per task.** Engine-neutral and simple, but "the same ports" then exist only inside the stack, every client needs the URL injected, and ports are still a shared resource.
3. **One OrbStack Linux machine per task.** The closest to a VM per task, and the most expensive; needs `orb` allowed for the scheduler while denied to agents.

## Decided with the owner (2026-11-19)

-   Approach 1.
-   Assumed, not confirmed: the web base URL and the Expo app's API URL can be set per run (an environment variable or the `{apiBaseUrl}` placeholder of the mobile track), so nothing needs `localhost:3000` written in. If that is wrong for some project, that project stays on `--ports canonical` with one environment at a time.

## The design

### 0. A spike, before any code (by hand, by the owner or with the owner watching)

On the owner's OrbStack, with a project's compose file up under a name like `df-spike-1` and no published ports, check and write down:

-   Does `http://<service>.df-spike-1.orb.local:<port>` answer from the Mac, and from a Playwright browser?
-   Does the container's IP answer, and is the address stable for the life of the stack?
-   Does an iOS simulator reach it? Does an Android emulator (through the host's network)? This is the risky one.
-   With two projects up at once, do both answer on the same port?
-   What does the app's CORS, cookie domain and OAuth redirect need to accept to work from the new hostname?

The answers decide section 3. If the web checks fail, this design stops and approach 2 is designed instead.

### 1. A third ports mode, `direct`

`e2e-env.sh up --ports direct`:

-   Writes the same override as `none` (no published ports) and does not take `ports.lock`.
-   Records `webBaseUrl` in `env.json` as the stack's direct address: the scheme and port of `environment.webBaseUrl` with the host replaced by `environment.directHost` after `{service}` and `{project}` are filled in. The default of `environment.directHost` is `{service}.{project}.orb.local`; it is a setting because another engine names its addresses differently.
-   Waits for `environment.pingUrl` at the direct address from the host, not only inside the service. If the address does not answer, `up` fails with a message that says the engine did not make the stack reachable from the host (exit 1, not a silent fallback).
-   `verify` and `down` treat it like `none` for the lock (there is none), and the sweep treats it like any `df-*` project (owner labels from slice 0 apply).

The ranking of reuse in `up` (`isolated < canonical < device`) gains `direct`, ranked with `isolated`, so a `direct` environment is not reused for a device run.

### 2. The scheduler uses it

`commands/tick.md` step 3: with `caps.maxConcurrent` above 1, ask for `--ports direct` for a web ticket and keep `--ports canonical` (and the lock) only for a device ticket, until section 3 says otherwise. With `maxConcurrent` 1 nothing changes.

### 3. Mobile, decided by the spike

The spike ran on 2026-11-20 on OrbStack: the Mac and the iOS simulator reach the name, the Android emulator reaches only the container IP. So the first case below holds with an address per platform, which 0.24.0 builds (`--ports direct --device`, `directIp`, `{apiBaseUrl}`); per-task Metro ports, per-task devices and the per-device lock are still to do.

-   If the simulator and emulator both reach the direct address: a device run uses `--ports direct` too, the app is built with its API URL from `{apiBaseUrl}` (mobile track, M2), each concurrent task gets its own Metro port (`{port}` already exists) and its own device, and the device lock becomes a per-device lock. A device pool setting is then a separate small design.
-   If only the simulator does: iOS tasks run concurrently and Android tasks stay on one at a time.
-   If neither does: mobile stays on `canonical` and one at a time; web alone gets concurrency.

### 4. Prerequisite: the active-run pointer

Hooks find a subagent's run through one file per machine (`$STATE/active-run.json`), so two builders at once resolve each other's run. The run must be resolved from the worktree first, with the pointer as a fallback. This changes `scripts/run-context.mjs`, an enforcement file, so a person writes or reviews it, and it ships before anyone raises `caps.maxConcurrent`. It is a separate change from this design (the gap report calls it F10) and has its own test of two interleaved runs.

## What is left to the builder

-   The exact wording of the failure when a direct address does not answer, and the retry interval for it (reuse `environment.readyTimeout`).
-   Whether the direct address uses the name or the container IP when both answer (prefer the name; the IP only if names do not resolve in the spike).

## Order of work

1. The spike. 2. F10 (a person). 3. `--ports direct` and `environment.directHost` (minor release). 4. The tick change. 5. Mobile, per section 3, after the mobile track's M1 and M2.
