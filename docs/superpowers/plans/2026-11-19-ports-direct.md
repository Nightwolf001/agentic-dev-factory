# `--ports direct` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third ports mode for `scripts/e2e-env.sh up`, `--ports direct`, that publishes no host ports, takes no lock, and gives the host an address of its own for the stack (OrbStack's `<service>.<project>.orb.local`), so several web-QA environments can run at once.

**Architecture:** `direct` is `none` (the override strips published ports) plus a recorded `webBaseUrl` whose host is built from a new setting `environment.directHost`, plus a probe of that address from the host. If the host cannot reach the stack, `up` fails (exit 1) and the existing trap tears the stack down; it never falls back to `canonical`. The tick asks for `direct` only for a web ticket when `caps.maxConcurrent` is above 1.

**Tech Stack:** bash 3.2 (macOS), Node 20+ (`node --test`), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-concurrent-task-environments-design.md` (sections 1 and 2). Its section 0 (the spike on the owner's OrbStack) has not been run: this plan builds only what fails closed when the address does not answer, and says so in the docs.

## Global Constraints

-   `AGENTS.md` rules apply. A new setting goes in `config.json`, `scripts/config.mjs` (validation), `settings/options.json` (group, title, type, scopeHint) and `docs/reference.md`. Behaviour of `scripts/e2e-env.sh` and `scripts/config.mjs` needs a test in `test/`.
-   Shell scripts must work with bash 3.2: no `mapfile`, no associative arrays.
-   Nothing in the plugin may name a company, tracker site, project key or host. The default `{service}.{project}.orb.local` is the engine's own naming, not an organisation's.
-   A test never talks to the machine's real docker and never stops a process it did not start. `test/e2e-env.test.mjs` already imports `./isolate-state.mjs`; a fake `curl` for the host probe goes in the test's own `bin/` folder, ahead of `PATH`.
-   Vocabulary: `bash scripts/lint-vocabulary.sh` must pass. Prettier: `npx prettier@3.2.5 --check` on changed `.md`, `.json`, `.mjs` files (tabs, as the repository config says). Do not run `npm install` on the host.
-   Run tests only through the sandbox runner: `bash /Users/francoiswolfaardt/.claude/jobs/399a4ef0/tmp/sandbox-test.sh <worktree> <command...>` (a single file: `bash -c 'node --test test/e2e-env.test.mjs'`; the full suite: `compare`, and `LOOPBACK=1 ... compare`; lint: `lint`; Prettier: `prettier <files>`). It works on a throwaway copy, so commit before you run it.
-   Git: this is a worktree; run plain single `git` commands from it (no `&&`, `;`, pipes or `cd` in the same command). Do not push, merge or touch any other checkout. End each commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
-   Mode order for reuse in `up`, replacing `isolated < canonical < device`: **`isolated` (0) < `direct` (1) < `canonical` (2) < `device` (3)**. A stack is reused when its recorded mode ranks at or above what the run asks for. (The spec says to rank `direct` with `isolated`; that would reuse an `isolated` stack, which has no recorded address, for a `direct` request. This order keeps the spec's intent that a `direct` stack is not reused for a device run.)

## Review Focus

-   A `webBaseUrl` with no port (`https://login.app.local`): the direct address keeps the scheme and has no port; the probe works.
-   A `directHost` with a placeholder other than `{service}` and `{project}`, or a character that is not valid in a host name, is a configuration error that names the setting.
-   The probe never times out silently: a stack that does not answer ends `up` with exit 1, the stack is torn down, and `ports.lock` was never created.
-   The probe path comes from `pingUrl` with its query dropped from every log line (a query can carry a token); when `pingUrl` is unset the probe is the direct `webBaseUrl` itself.
-   `--ports direct --device` in either order is refused before anything is written.
-   Two `direct` environments for different keys can be up at once with no lock between them (they still count against `DF_MAX_STACKS`).

---

### Task 1: The setting `environment.directHost`

**Files:**

-   Modify: `config.json` (the `environment` block, after `webBaseUrl`), `scripts/config.mjs` (the `environment` validation near line 430), `settings/options.json` (after `environment.webBaseUrl`), `docs/reference.md` (the environment settings table, after the `environment.webBaseUrl` row)
-   Test: `test/config.test.mjs` (add; find the existing validation tests there and follow their style)

**Interfaces:**

-   Produces: `environment.directHost` as a string in the merged config, default `"{service}.{project}.orb.local"`. `node scripts/config.mjs get environment.directHost` prints it. Task 2 reads it through `cfg directHost` in `scripts/e2e-env.sh`.

-   [ ] **Step 1: Write the failing tests** in `test/config.test.mjs`: (a) the shipped default validates and equals `{service}.{project}.orb.local`; (b) these values each produce a problem that contains `environment.directHost`: `"{host}.x"` (unknown placeholder), `"bad host"` (space), `"a/b"`, `""`, `5` (not a string), `".leading.dot"`, `"{service}.{project}."` (trailing dot); (c) these are accepted: `"{service}.{project}.orb.local"`, `"stack.test"`, `"{project}.example.dev"`. Use the validation entry point the neighbouring tests use.
-   [ ] **Step 2: Run them** (`bash -c 'node --test test/config.test.mjs'` in the sandbox) and see them fail.
-   [ ] **Step 3: Implement.** Add the default to `config.json`. In `scripts/config.mjs` add a validation: when `environment.directHost` is present it must be a string that, after replacing `{service}` and `{project}` with `a`, matches `^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$` and contains no other `{` or `}`; otherwise push `environment.directHost must be a host name, with {service} and {project} where the stack's own names go`. Add the `settings/options.json` entry (`"group": "Environment"`, `"title": "Direct host (OrbStack)"`, `"type": "string"`, `"scopeHint": "project"`) and the table row in `docs/reference.md`: default `{service}.{project}.orb.local`, "The host name a `--ports direct` stack is reached at from this machine. `{service}` is `environment.service`, `{project}` the compose project (`df-<key>`). Another engine names its containers differently."
-   [ ] **Step 4: Run** the config tests, `test/settings-catalog.test.mjs` and `test/docs.test.mjs`; all pass.
-   [ ] **Step 5: Commit** (`feat: environment.directHost, the host name of a direct-ports stack`).

---

### Task 2: `e2e-env.sh up --ports direct`

**Files:**

-   Modify: `scripts/e2e-env.sh` (header comment lines 7-16, argument parsing line 59-62, `write_override` line 116, `do_verify`, `mode_rank` line 235, `do_up` lines 303-365, usage line 447)
-   Test: `test/e2e-env.test.mjs`

**Interfaces:**

-   Consumes: `cfg directHost` (Task 1), `SERVICE`, `PING_URL`, `WEB_BASE_URL`, `READY_TIMEOUT`, `write_env`, `env_get`, `die`, `log` (all in the script).
-   Produces: `env.json` of a direct stack has `mode: "direct"`, `ports: "direct"`, `webBaseUrl` (the direct address) and `directProbe` (the URL probed). New functions `direct_url BASEURL PROJECT` (prints the base URL with its host replaced by `environment.directHost` after `{service}` → `$SERVICE` and `{project}` → the project; keeps scheme, port, path, query; exit 1 if the result is not a URL) and `direct_probe_url DIRECTURL` (prints the direct URL's origin plus the path and query of `$PING_URL`, or the direct URL itself when `$PING_URL` is empty or has no path), and `wait_direct URL` (polls `curl -ksf -m 10 -o /dev/null URL` every 5 seconds until `$READY_TIMEOUT`, like `wait_ping`).

Behaviour to implement (each line is pinned by a test below):

1.  `--ports` accepts `canonical`, `direct` and `none`; anything else: `die "--ports must be canonical, direct or none"`. The existing test that matches `--ports must be canonical or none` is updated.
2.  After argument parsing, `DEVICE=1` with `PORTS=direct`, in either order of the flags, is `die "--ports direct is not supported with --device yet: a device run keeps the canonical ports"`.
3.  With `environment.type` compose and `--ports direct`, an empty `environment.webBaseUrl` is `die "--ports direct needs environment.webBaseUrl (the address a browser would use, with its port)"`, before the override or `env.json` is written. With `environment.type` none, `up` behaves as before.
4.  `write_override` strips published ports for `none` and for `direct`.
5.  `direct` takes no `ports.lock`, makes no `busy_ports` check, and does not call `takeover.mjs`. Reusing a recorded direct stack (the idempotent path) does not write a lock either.
6.  `env.json`: `mode=direct ports=direct webBaseUrl=<direct url> directProbe=<probe url>`, written where the other modes' record is written.
7.  After `wait_ping` succeeds, `wait_direct "$probe"`. On timeout: `die "the engine did not make the stack reachable from this machine: <origin and path of the probe> did not answer within ${READY_TIMEOUT}s (environment.directHost is $(cfg directHost); an engine that does not name containers that way needs another value)"`. Exit 1; the existing `EXIT` trap tears the stack down. Every log line and message names the probe by origin and path only, never its query.
8.  `do_verify` for a recorded `mode` of `direct` also runs one `curl -ksf -m 10 -o /dev/null "$(env_get directProbe)"` from the host and adds the problem `direct address does not answer: <origin and path>` when it fails.
9.  `mode_rank` becomes isolated 0, direct 1, canonical 2, device 3, and the "what this run asks for" expression in `do_up` returns `device`, `canonical`, `direct` or `isolated`. The header comment and the usage line mention `--ports canonical|direct|none`.

-   [ ] **Step 1: Write the failing tests** in `test/e2e-env.test.mjs`. Add a helper `directFixture(config, { answers = true } = {})` that calls `fixture` and writes an executable fake `curl` into its `bin/` (it appends its arguments to `curl.log` and exits 0, or 22 when `answers` is false); the config is `{ environment: { type: 'compose', composeFile: '.devcontainer/docker-compose.yml', service: 'app', pingUrl: 'http://localhost:3000/api/health?token=SECRET', webBaseUrl: 'http://localhost:3000' } }`; tests run with `DF_READY_TIMEOUT=0` in the environment (the fixture's `env` is shared, so set it on the object the helper returns or pass it through). Tests, by name:
    -   `--ports accepts direct and the error names all three values` (the updated assertion `/--ports must be canonical, direct or none/` with `bogus`);
    -   `--ports direct with --device is refused in either order, before anything is written` (both orders; exit 1; no `compose.override.yml`);
    -   `--ports direct needs environment.webBaseUrl` (exit 1, message, no `.dev-factory/compose.override.yml`);
    -   `a direct start records the stack's own address, strips the published ports, takes no lock and asks the host to probe it`: after `up --key APP-1 --ports direct` with the fake `curl` answering and the fake `docker` as `fixture` defines it, `up` succeeds only if `do_verify` passes, and the fake docker's `ps` prints nothing, so this test asserts on what `up` wrote before verify and on `curl.log`: `env.json` has `mode: 'direct'`, `ports: 'direct'`, `webBaseUrl: 'http://app.df-app-1.orb.local:3000'`, `directProbe: 'http://app.df-app-1.orb.local:3000/api/health?token=SECRET'`; the override contains `ports: !reset []`; `curl.log` names `app.df-app-1.orb.local:3000/api/health`; no `ports.lock` directory exists in the state folder; stderr does not contain `SECRET`. (If the fake docker makes `up` fail before the probe, extend the fake docker in this helper's copy so `compose ... ps -a --format json` prints one running service line; do not change the shared `fixture`.)
    -   `a direct address that does not answer ends up with exit 1 and no lock, naming the engine problem` (`answers: false`: status 1, stderr matches `did not make the stack reachable`, no `ports.lock`, the log shows a `down`);
    -   `environment.directHost changes the address` (`directHost: '{project}.stack.test'` gives `http://df-app-1.stack.test:3000`);
    -   `a url with no port keeps none` (`webBaseUrl: 'https://login.app.local'` gives `https://app.df-app-1.orb.local`: the scheme kept and no port);
    -   `with no pingUrl the probe is the direct web address`;
    -   `two direct environments for different keys coexist with no lock` (two fixtures sharing one state folder: both `up` calls get past the lock stage; assert neither created `ports.lock`);
    -   `verify of a direct stack fails when the address stops answering` (change `answers` between `up` and `verify`: write `curl-answer` file the fake curl reads on each call);
    -   `reuse order: isolated < direct < canonical < device` (extends the logic of the existing "fewer ports" test at line 411: an isolated record is replaced by a `direct` request; a direct record is reused by `direct` and by an isolated request; a direct record is replaced by a `canonical` request and by `--device`).
-   [ ] **Step 2: Run** `bash -c 'node --test test/e2e-env.test.mjs'` in the sandbox and see the new tests fail for the right reason.
-   [ ] **Step 3: Implement** the nine behaviours above in `scripts/e2e-env.sh`. `direct_url` and `direct_probe_url` are `node -e` one-liners that take their values as arguments (not text in the program), as `env_get` and `write_env` do.
-   [ ] **Step 4: Run** the file again, then `bash -c 'bash -n scripts/e2e-env.sh'`, then `compare` and `LOOPBACK=1 compare` for the whole suite; no new failures against the recorded baselines.
-   [ ] **Step 5: Commit** (`feat: e2e-env up --ports direct, a stack the host reaches at its own address`).

---

### Task 3: The tick and the documentation

**Files:**

-   Modify: `commands/tick.md` (step 3 "Environment", line 69), `skills/environment/SKILL.md` (lines 12, 24, 25), `docs/reference.md` (the `e2e-env.sh` table row near line 952, the paragraphs near 971-977, and the "Web QA needs canonical ports" limitation near line 1179), `README.md` only if it lists the ports modes
-   Test: `test/commands.test.mjs` (add one test), `test/docs.test.mjs` runs unchanged

**Interfaces:**

-   Consumes: the `--ports direct` flag and `environment.directHost` from Tasks 1 and 2.

-   [ ] **Step 1: Write the failing test** in `test/commands.test.mjs`: `the tick asks for direct ports only for a web ticket when more than one task may run, and never falls back to canonical`: reads `commands/tick.md` and asserts that the Environment step mentions `--ports direct` together with `caps.maxConcurrent`, still says `--ports canonical` for the `maxConcurrent` of 1 case and `--device` for mobile, and contains the words `no fallback` (the exact phrase) in that step.
-   [ ] **Step 2: Run** it and see it fail.
-   [ ] **Step 3: Edit the tick step.** In `commands/tick.md` step 3: keep `--ports canonical` as the default and for any `--device` task; add that when `caps.maxConcurrent` is above 1 a web ticket uses `--ports direct` instead; a failure of `up --ports direct` (exit 1) is an environment failure handled like any other, with **no fallback** to `canonical` (that would take the machine-wide lock and defeat the point). Keep the paragraph's other content unchanged.
-   [ ] **Step 4: Edit the docs.** In `skills/environment/SKILL.md` and `docs/reference.md`: document `up --key KEY [--ports canonical|direct|none] [--device]`; say `direct` needs `environment.webBaseUrl` and an engine that names containers (OrbStack's `<service>.<project>.orb.local` by default, `environment.directHost` for another), takes no lock, is refused with `--device` for now (mobile waits for the engine spike), and that the reuse order is isolated, direct, canonical, device. State plainly in `docs/reference.md` that the host reachability of an OrbStack address has not been checked on a real engine yet (the spike in the design) and that `caps.maxConcurrent` must stay 1 until two runs can no longer read each other's `active-run.json` (the run-pointer change the design calls a prerequisite); `direct` alone is safe to use with `maxConcurrent` 1 for a single stack. Replace the limitation near line 1179 with the new facts rather than appending.
-   [ ] **Step 5: Run** `test/commands.test.mjs`, `test/docs.test.mjs`, `test/hygiene.test.mjs`, the vocabulary lint and Prettier on the changed files; all pass.
-   [ ] **Step 6: Commit** (`feat: the tick runs web tickets on direct ports when several may run at once`).
