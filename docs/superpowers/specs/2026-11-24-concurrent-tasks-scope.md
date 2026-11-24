# Concurrent tasks: scope

Scope, 2026-11-24. Replaces the open ends of `2026-11-19-concurrent-task-environments-design.md` (environments) and `2026-11-20-per-agent-run-binding-design.md` (run binding), which are done: this is what is left before the intent is met.

## Goal

On one Mac, one factory pass builds several tasks at the same time. Each task has its own isolated stack on the same container ports, and QA passes for web, the iOS simulator and the Android emulator without any lock between tasks.

## Done when

On `factory-rnd` (a small React Native test project: an Expo app and a tiny Node HTTP API in compose), one pass builds two mobile tasks at the same time, one on iOS and one on Android. Each task has its own stack, its own API address, Metro port and device, and each ships a draft PR with QA evidence. Neither task waits on the other.

## Already done (not in scope)

-   Isolated stacks with no published ports and no lock: `--ports direct` (0.22.0), reachable by name (`{service}.{project}.orb.local`) from the Mac and the iOS simulator, by container IP from the Android emulator (0.24.0).
-   Per-agent run binding (0.23.0): two agents at once no longer read each other's run.
-   Telling a stack's app its own address: `environment.directEnv` (0.25.0, PR #40).

## Gaps (the work)

1. **Parallel dispatch.** Today the pass builds one task after another. It must build up to `caps.maxConcurrent` at once. The `tick.md` sentence "so web tickets can overlap" is wrong until then.
    - The pass always looks for every task it can start and fills each free slot, like several developers on one project. Tasks need not be related, and two tasks may touch the same files: each has its own worktree, branch and stack, so they cannot see each other while they are built.
    - The only reason not to start a task in parallel is the existing rules: a blocker not done and not stackable, the open-PR cap, the breaker.
    - The pass lock is per repository, not per machine. Today the state folder `~/.dev-factory` holds one lock for every project, so a pass in one project stops a pass in another (found 2026-11-24: a factory-rnd build exited 75 while a sa-weddings pass ran).
    - Overlap is settled at merge, as today: a PR whose base moved under it (`CONFLICTING`) becomes a fix item that merges the base in, and a conflict the factory cannot settle is blocked for a person.
2. **A per-task API address that every client can use.** Each task's API (the Node API here, Strapi in sa-weddings) must be reachable from the Mac, the iOS simulator and the Android emulator at the same time, for any engine, without the app hard-coding a host. Approach from the spike below: a host proxy that gives each task its own Mac port and forwards it to that task's container.
3. **Android reverse per task.** `mobile-env.sh` runs `adb reverse tcp:P tcp:P` for Metro and `mobile.androidReversePorts`. Two emulators then share the Mac's port P. Instead, each emulator gets `adb -s <serial> reverse tcp:P tcp:<its task's port>`, so the app keeps `localhost:P` and still reaches its own task.
4. **Per-task Metro port and device.** Each task's Metro starts on its own port, counting up from `mobile.metroPort`: 8081 for the first task, 8082 for the second, and so on, recorded in `env.json` and freed when the task is torn down. An Android emulator is reversed to its own task's Metro port. Each task also gets its own simulator or emulator, and a lock per device instead of one machine-wide lock.
5. **The tick asks for direct ports on device tasks** when `caps.maxConcurrent` is above 1. Today a device task still takes canonical ports and the machine-wide lock.
6. **A first real run.** 0.24.0 and 0.25.0 mobile paths have run only against stubs. Whatever a real run on factory-rnd finds goes on this list.

## Spike: reaching each task's API at the same time (2026-11-24, OrbStack)

Two stacks, `rnd-spike-a` and `rnd-spike-b`, each a Node API on container port 1337, no published ports, plus a host proxy (Node, 127.0.0.1 only): port 41001 to stack a, 41002 to stack b, and port 41000 routed by host name (`a.localhost`, `b.localhost`).

| Client                    | By name     | Container IP | Proxy port (41001/41002)          | Proxy by host name (41000)          | `adb reverse tcp:1337 tcp:41002` |
| ------------------------- | ----------- | ------------ | --------------------------------- | ----------------------------------- | -------------------------------- |
| Mac                       | yes         | yes          | yes                               | yes                                 | n/a                              |
| iOS simulator (Safari)    | yes         | not tried    | yes (`127.0.0.1` and `localhost`) | yes                                 | n/a                              |
| Android emulator (API 36) | no (no DNS) | yes          | yes (`10.0.2.2`)                  | only with a Host header set by hand | yes: `localhost:1337` reached b  |

Findings:

-   Every client reaches the proxy ports. A per-task proxy port is the one address form that works from all three clients and does not depend on the engine naming containers.
-   Android: the emulator's `localhost` is its own; `10.0.2.2` is the Mac's loopback. `adb reverse` is set per emulator, so an app that calls `localhost:1337` reaches whichever task that emulator is reversed to. No URL needs to be injected for Android.
-   The iOS simulator shares the Mac's loopback, so `localhost:1337` cannot point at two tasks at once. iOS uses the task's proxy port (or the name on OrbStack), injected through `{apiBaseUrl}`.
-   Routing by host name on one port is not usable from Android (`*.localhost` resolves to the emulator itself).
-   Not tried: two emulators at once (adb reverse is per serial by design), a physical device (would need the proxy on the LAN address).

## Order of work

1. factory-rnd test bed and one mobile task built one at a time (gap 6).
2. Gaps 2 to 5 in the factory, each its own PR, each with tests.
3. Gap 1, parallel dispatch.
4. The done-when run.

Factory changes are made in an interactive session as PRs, never by a ticket run. factory-rnd tasks are built by the factory.
