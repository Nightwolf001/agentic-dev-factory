# Slice 0: safety fixes from a downstream fork's gap report

Design, 2026-11-19. A short design: each item below has a concrete fix and a named test, so there is no separate builder check.

## Intent

A downstream fork of this factory was compared with `main` on 2026-11-18 (a read-only gap report of 47 items). Seven of its findings are bugs or risks in this factory today, not missing features. Each was re-checked against the 0.20.0 code before it went in here; the report's claims are not taken on trust. They come first because three of them sit in the files that enforce the factory's limits (`scripts/guard-lib.mjs`, `scripts/config.mjs`, `scripts/stop-gate.mjs`) and one makes the test suite able to stop a live pass.

## Goals

1. A test never reaches the machine's real docker or a live pass's processes, and a sweep never removes a stack that something alive still owns.
2. A settings file that is not a JSON object is refused with the file named, never merged as if it were empty.
3. The shell guard judges a `gh` command the way the shell reads it: `-XPOST` is a write, and a quoted or escaped subcommand is the subcommand.
4. A builder whose hand-off was already taken is let go by the stop gate.
5. `improve --dry-run` does not run a real scan, and a pass script refuses an argument it does not know.
6. `learnings-scan` survives a large merged-PR list.
7. A comment posted through a tracker MCP server that takes HTML carries real mentions.

## Non-goals

-   The rest of the report. In particular the strict GraphQL exception for the scheduler, the `stack.mjs retarget|sync` refusal and the `GH_HOST` / `GH_TOKEN` refusal stay in a later guard slice; this slice fixes only the two spellings above.
-   Any new setting. Every item here is a behaviour fix.
-   Replacing the guard's module split or the auto-merge door. The fixes go into the existing `guard-lib.mjs` and `guard-paths.mjs`.

## Anti-goals

-   A fix that loosens a guard or a stop condition to make a test pass.
-   A test that passes only because the machine it ran on happens to have no docker.
-   Anything in the plugin that names the fork, its company, a tracker site or a ticket key.

## Constraints

-   `AGENTS.md` applies: every behavioural change in `scripts/guard-lib.mjs`, `scripts/config.mjs`, `scripts/stop-gate.mjs`, `scripts/stop-gate-lib.mjs`, `scripts/comment-lib.mjs`, `scripts/learnings-lib.mjs` and `bin/qa.mjs` needs a test in `test/`; shell scripts run under bash 3.2; Prettier, the vocabulary lint and `claude plugin validate .` stay green.
-   The factory is live on this machine. Tests, Prettier and the lint run only inside a sandbox on a throwaway clone outside `.claude/`, never against the checkout the scheduler uses, and a change is judged by failures that are not in a saved baseline of the same sandboxed run.
-   Each fix is test-first: the failing test is written and seen to fail on `main` before the fix, so a claim that turns out to be false (the report is not always right) shows up as a test that passes already.

## Approaches

1. **One pull request for all seven.** One review and one release. But it spans three enforcement files, the sweep and the comment tooling, so a reviewer cannot hold it in their head, and one doubtful item holds the rest back.
2. **One pull request per item.** Easiest to review and revert. Seven releases for seven small changes is more churn than the changes are worth.
3. **Three pull requests, grouped by what they touch.** Chosen (my call, since the way to build it was left to me). The groups are small enough to review, independent of each other (all three start from `main`, no stacking), and the first one makes every later test run safe.

## The three pull requests

### 1. Hermetic tests and a sweep that respects owners (patch, 0.20.1)

-   `scripts/e2e-env.sh`: `write_override` adds `dev-factory.owner=<pid>` and `dev-factory.worktree=<path>` labels next to the existing `dev-factory: "1"`. The sweep keeps today's live-owner-file check and also skips a stack whose labelled owner is alive or whose worktree has a fresh `run.json`, so a sweep started from another state folder cannot remove a live `df-<key>` stack. What counts as fresh is the builder's call, taken from the stall window the scheduler already uses.
-   `scripts/cleanup.mjs`: `cleanup()` passes its own state folder to the child processes it starts (today the `e2e-env.sh sweep` it runs reads the default state folder whatever `state` the caller gave).
-   `test/no-docker.mjs`: `noDockerEnv()` puts a fake `docker` first on `PATH`. `test/hermetic.test.mjs` fails when a test reaches the real one.
-   `test/cleanup.test.mjs`, "a real process holding a port is left by default and stopped with takeover": inject `run` and a process filter with a decoy process, so only the child the test started can be stopped. The default `run` shells out to `ps` and `docker`, which is what makes that test unsafe beside a live pass.
-   `AGENTS.md`: a rule that a test never talks to the machine's real docker or stops a process it did not start, with the reason.

### 2. Enforcement fixes (patch, 0.20.2; a person reviews it, as the enforcement files are guarded)

-   `scripts/config.mjs`: `readJson` becomes a layer reader that names the file and refuses anything but an object (`null`, an array, a number, a string) for the defaults, the user layer and the project layer. Test in `test/config.test.mjs`.
-   `scripts/guard-lib.mjs`, `ghApiWrites`: match an attached method (`-XPOST`, `-XDELETE`) as well as `-X POST` and `--method=POST`; `-XGET` stays allowed. The words of a segment already pass through `shellUnquote`; first write tests for `gh "pr" merge`, `gh 'pr' merge` and `gh p\r merge` and fix only the spellings that are judged differently from how the shell reads them. Tests in the guard suites.
-   `scripts/stop-gate.mjs` and `scripts/stop-gate-lib.mjs`: the hook input carries `agent_type`, which `resolveRun` already reads. Add `agentRoleOf(agentType)` and return early, before the refused-file move, the nudge count and the `blocked.json` write, when the stopping agent's role is not the role in `run.json` (the scheduler has moved the run on, for example to the debugger, after taking the builder's hand-off). Test in `test/stop-gate.test.mjs`, including that the 0.20.0 behaviours (a refused `build.done` is set aside; giving up writes `blocked.json`) are unchanged for the agent that owns the run.

### 3. Scheduler scripts and mentions (minor, 0.21.0)

-   `scripts/improve.sh`: parse the flags. An unknown one exits 2. A dry run skips the pause switch but still takes the lock, does not fetch, passes `--dry-run` to the command, and also writes to the terminal. `scripts/tick.sh`: refuse an argument it does not know (the builder checks what `tick.sh` documents as accepted). Tests in a new `test/pass-args.test.mjs` with a stand-in `claude`.
-   `scripts/learnings-scan.mjs`: set `maxBuffer` on the `gh pr list` call and ask only for PRs merged since the watermark (`--search "merged:>=<date>"`). Test with a stand-in `gh` that returns more than 1 MB.
-   `scripts/comment.mjs` and `scripts/comment-lib.mjs`: `compose --format html` writes mentions as `<span data-type="mention" data-user-id="…">` with `--assignee-name` and `--reporter-name`. `commands/tick.md` and `skills/task-source/jira.md` tell a session that posts through an MCP server taking HTML to use that form; `compose-adf` stays, for the REST token server only. New option, hence the minor release.
-   **Unverified, and to confirm before merging:** that the claude.ai Atlassian connector's comment tool accepts only markdown or HTML, and that a mention written as above notifies. This comes from the report and cannot be tested without the connector. If it cannot be confirmed in the pull request, the change is only the instruction text and the renderer behind the flag, and the pull request says so.

## Decided later or left to the builder

-   The freshness window for a `run.json` in the sweep (PR 1) and the exact shell-word cases that fail today (PR 2).
-   The order inside a pull request.

## After this slice: the mobile and remote QA track

Neither project that runs this factory today sets `mobile` or `environments`, but the owner is about to start mobile app projects, so the report's mobile and remote QA items are scheduled ahead of the first one, not on demand. They run as a track of four pull requests after PR 1 above (which makes every later test run safe), in this order.

The first mobile project is an Expo React Native app for iOS and Android, tested against a local compose stack (decided with the owner, 2026-11-19). That fixes two things. Both platforms matter from the start, so the iOS autofill flow and the Android GPU flag are both in M1. And QA signs in to a local stack, not a remote environment: today `qa-login.sh` refuses a run that has no remote account, so the local half of the accounts work (`mobile.account` and the local sign-in variables) moves out of M3 into M1, and the remote half of M3 and M4 waits for a project that tests against a deployed backend.

1. **M1, sign in through the Maestro MCP, with a local account (minor).** `scripts/qa-login.sh` signs in with the Maestro CLI. The report says that when that process exits it tears down the device's driver, so the Maestro MCP session QA uses next fails ("Device became unreachable"). That would hit the first mobile run, so this comes first. It adds `qa-login.sh --print-env` (starts nothing, prints the `env` for the MCP `run` tool), refuses a CLI sign-in while an MCP session owns the device (the CLI path stays as an opt-in for CI with no MCP), lets `qa/maestro/login.yaml` accept an app that is already signed in and gives `APP_ID` no default, adds a `driver` check to `mobile-env.sh`, ships a generic flow that turns iOS autofill off, boots the Android emulator on the host GPU (`DF_EMULATOR_GPU`), and signs a local mobile run in as `mobile.account` with `DF_LOCAL_<ACCOUNT>_USER` and `DF_LOCAL_<ACCOUNT>_PASSWORD`. The password passes through the MCP call, so the account must be a test account; the docs say so.
2. **M2, environment start-up (minor).** `up` waits for the process check and the service health checks (`environment.checkTimeout`) before it starts the mobile lane, stops waiting on exit 100 ("will never come up"), says why a step failed (exit meaning, the last lines of output, `docker compose ps -a`), fills `{environment}` and `{apiBaseUrl}` in the build command, exits 78 for a failed native build so the tick blocks the ticket at once, and puts a time limit on the ping.
3. **M3, QA accounts and devices per environment (minor; gets its own short design first, since it adds the most settings; waits for a project with a deployed backend).** `environments.<env>.accounts`, `devices` and `defaultAccount`, `qa.repoEnv` with a name check that refuses names that steer the shell, node, the factory or Maestro, `scripts/qa-env.sh`, and a device's own start command. `remote.accounts` stays readable as an alias for one release.
4. **M4, the QA engine, then remote QA (minor).** Not tied to a deployed backend, so these come with the first project: QA retries counted per pass instead of per worktree, evidence names that include the run and case, a per-capture assertion, `probe --expect-contains`, and the account password in the scrub. Waits for a deployed backend: unit tests in the project's container for a remote run (no host ports). This factory's stricter default stays: identifiers in remote evidence are redacted, and `qa.remoteKeepsIdentifiers` (default `false`) is an opt-in.

The report's claims about Maestro's behaviour were not tested by its author and cannot be tested here without a device. Each of M1 to M3 is reproduced on a real simulator or emulator with the Maestro MCP before its fix is written, and the pull request says what was and was not run on a device.

The remaining items follow in the report's order, none of them needing a mobile project: `qa.mjs bench`, frontier, stacked-PR and guard hardening (including the guard parts left out of PR 2), typed and threaded comments, the QA summary comment and report with a pluggable destination, MCP sync fidelity, run plumbing, and the docs split.

One item from the report is not to be ported at all: giving every role read access to Sentry and Axiom, because it widens each role's tools where the factory keeps them scoped; `telemetry.allowedRoles` already lets a person opt in per role.
