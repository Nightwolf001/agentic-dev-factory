# Slice 0 Safety Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the seven bugs and risks of the 2026-11-19 design in three pull requests, each with its own release, so the test suite can no longer touch a live pass, the enforcement files close three gaps, and the pass scripts and tracker comments behave as documented.

**Architecture:** Every change is small and local to an existing file. Each fix starts with a test that fails on `main`; a test that already passes (the report is not always right) stays as a regression test and the pull request says so. The three pull requests start from `main` and do not depend on each other; only the first makes the sandboxed runs below cheaper to trust.

**Tech Stack:** Node ESM with `node:test`, bash 3.2, Docker Compose, `gh`.

**Spec:** `docs/superpowers/specs/2026-11-19-slice-0-safety-fixes-design.md`. The mobile and remote QA track (M1 to M4) is a separate plan, written after this one, because M1 to M3 need a device to reproduce first.

## Global Constraints

-   The factory is live on this machine. Run tests, Prettier and the vocabulary lint only through the sandbox runner of Task 0, never bare `node --test`, never in the main checkout, never with `npx`, `gh`, `claude` or `docker` from the work itself.
-   Judge a change by failures that are not in the saved baseline of the same sandboxed run (about 14 failing and 25 cancelled tests are environment-only; `test/lock.test.mjs` "racing" tests flake under load).
-   Every behavioural change in a guarded file needs a test in `test/` (`AGENTS.md`). Shell scripts work under bash 3.2: no `mapfile`, no associative arrays.
-   Nothing in the plugin names a company, a tracker site, a project key or a host. Explain rules by their reason.
-   Formatting is the repository Prettier config (tabs, `singleQuote`, `printWidth` 150). `bash scripts/lint-vocabulary.sh` and `claude plugin validate .` stay green.
-   Versions: PR 1 is `0.20.1` (patch), PR 2 is `0.20.2` (patch), PR 3 is `0.21.0` (minor: a new `--format` option). Bump `version` in `.claude-plugin/plugin.json` and the marketplace entry together, in the last task of each pull request.
-   Each pull request is a branch from `origin/main` in its own worktree, pushed, opened as a draft with the attribution line from the session. Never merge, never push to `main`.
-   Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

Failure modes the design implies and no single task's happy path exercises. Each has a test in the task that owns the code.

1. A fake `docker` on every test's `PATH` changes tests that expected docker to be missing (doctor, preflight, e2e). Task 1 runs the whole suite against the baseline.
2. A stack with no labels (started before this release) or a `docker ps` that fails must still be swept by the old live-file rule, not kept forever and not swept blindly. Task 3.
3. A stop event with no `agent_type`, or one that is not a factory agent, must be gated exactly as today. Task 7.
4. `gh api -Xpost` (lower case) and `gh api repos/o/r -XPATCH` (method after the path) are writes; `-XGET` is not. Task 6.
5. `learnings-scan --since garbage` must not hand a malformed search to `gh`. Task 10.
6. Comment text containing HTML (`</p><script>`) cannot break out of the paragraph in `compose --format html`. Task 11.

---

### Task 0: The sandbox runner (not committed)

**Files:**

-   Create: `$CLAUDE_JOB_DIR/tmp/sandbox-test.sh` (outside the repository; the job folder is cleaned up with the job)

**Interfaces:**

-   Produces: `sandbox-test.sh <worktree> <command...>` runs `<command>` inside a macOS `sandbox-exec` profile in a throwaway copy of `<worktree>`, and prints its output. `sandbox-test.sh <worktree> baseline` writes the failing and cancelled test names of a full `node --test test/*.test.mjs` run to `$CLAUDE_JOB_DIR/tmp/baseline.txt`; `sandbox-test.sh <worktree> compare` runs the same and prints only names not in the baseline.

-   [ ] **Step 1: Write the runner.** Per call: make a scratch folder under `/private/tmp` (never under a `.claude/` path: the shell guard denies such paths and guard tests would fail for the wrong reason); `rsync -a --exclude node_modules --exclude .git` the worktree into `scratch/src`; inside it run `git init -q`, `git add -A`, `git commit -qm snapshot` with a fixed identity (the hygiene tests sweep tracked files); run the command under `sandbox-exec -f <profile>` with `env -i`, `HOME=scratch/home`, `PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`, `DF_STATE_DIR=scratch/state`.
-   [ ] **Step 2: Write the profile** so that: writes are allowed only under the scratch folder (plus `/dev/null`, `/dev/tty`, `/private/var/folders` for node's temp files); the network is denied; `signal` to other processes is denied (`(deny signal (target others))`); reads of `~/.dev-factory`, `~/.claude/plugins`, `~/.claude.json` and `~/.ssh` are denied.
-   [ ] **Step 3: Prove the sandbox holds.** Run, through the runner: `touch "$HOME_REAL/df-sandbox-probe"` (must fail), `kill -TERM <pid>` against a `sleep 100` started outside the sandbox must fail, `cat ~/.dev-factory/config.json` must fail, `curl -sS -m 3 https://example.com` must fail. Record the four outcomes in the job notes. Do not continue until all four are refused.
-   [ ] **Step 4: Record the baseline** on a fresh `origin/main` worktree: `sandbox-test.sh <worktree> baseline`. Keep `baseline.txt` for every later comparison. Expected: roughly 800 pass, about 8 fail, about 25 cancelled.

---

## Pull request 1: hermetic tests and a sweep that respects owners (0.20.1)

Branch `fix/hermetic-tests-owner-sweep`, from `origin/main`.

### Task 1: A fake docker for every test

**Files:**

-   Create: `test/no-docker.mjs`, `test/hermetic.test.mjs`
-   Modify: `test/isolate-state.mjs`

**Interfaces:**

-   Produces: `noDockerBin(): string` returns a folder (created once per process under `os.tmpdir()`) holding an executable `docker` that appends its arguments to the file named by `DF_FAKE_DOCKER_LOG` when that is set, prints `Cannot connect to the Docker daemon` on stderr, and exits 1. `noDockerEnv(env = process.env): NodeJS.ProcessEnv` returns a copy of `env` with that folder first on `PATH`.
-   `test/isolate-state.mjs` (imported first by every test that loads configuration or runs a script) puts the same folder first on `process.env.PATH`. A test that needs a working docker prepends its own folder, as `test/e2e-env.test.mjs` already does, so its fake wins.

-   [ ] **Step 1: Write the failing test** `test/hermetic.test.mjs` (imports `./isolate-state.mjs` first): `docker on the PATH of a test is the fake` runs `spawnSync('docker', ['ps'])` and asserts status 1 and stderr matching `/Cannot connect to the Docker daemon/`; `a script a test runs sees the fake too` runs `spawnSync('bash', ['-c', 'command -v docker'])` and asserts the path starts with `noDockerBin()`; `the default runner of cleanup reaches the fake` imports `defaultRun` from `../scripts/cleanup.mjs` and asserts `defaultRun('docker', ['ps']).status === 1`.
-   [ ] **Step 2: Run** `sandbox-test.sh <wt> node --test test/hermetic.test.mjs` → FAIL (`no-docker.mjs` missing).
-   [ ] **Step 3: Write `test/no-docker.mjs`** with the two functions above, and import it from `test/isolate-state.mjs` to prepend the folder to `process.env.PATH` after the state folder is set.
-   [ ] **Step 4: Run the new test** → PASS. Then run the whole suite with `sandbox-test.sh <wt> compare`. Any test newly failing because it expected docker to be absent (look in `doctor`, `preflight`, `e2e-env`, `scheduler`) gets its own `PATH` set explicitly in that test; do not weaken the fake.
-   [ ] **Step 5: Commit** `Put a fake docker first on the PATH of every test`.

### Task 2: cleanup() keeps to its own state folder, and its takeover test touches only its own process

**Files:**

-   Modify: `scripts/cleanup.mjs` (`defaultRun` near line 45, `cleanup` near line 205)
-   Modify: `test/cleanup.test.mjs` (the test at line 219, "a real process holding a port is left by default and stopped with takeover")

**Interfaces:**

-   Consumes: `defaultRun(cmd, args, opts)` where `opts` is `{ timeout?, env? }`.
-   Produces: every command `cleanup()` starts runs with `env = { ...env, DF_STATE_DIR: state }` (the `env` and `state` arguments `cleanup` already takes), so the `e2e-env.sh sweep` it runs reads the state folder the caller named, never the machine's default.

-   [ ] **Step 1: Write the failing test** `cleanup passes its own state folder to the commands it runs`: call `cleanup({ takeover: false, ports: [], state, cfg: load(), run })` with a `run` that records `(cmd, args, opts)`; assert the recorded call whose `args[0]` ends in `e2e-env.sh` and `args[1] === 'sweep'` has `opts.env.DF_STATE_DIR === state`.
-   [ ] **Step 2: Run** `sandbox-test.sh <wt> node --test test/cleanup.test.mjs` → the new test FAILS (`opts.env` undefined).
-   [ ] **Step 3: Implement.** `defaultRun` passes `env: opts.env ?? process.env` to `spawnSync`. In `cleanup()` wrap the received `run` at the top: `const baseRun = run; run = (cmd, args, opts = {}) => baseRun(cmd, args, { ...opts, env: { ...env, DF_STATE_DIR: state } })`.
-   [ ] **Step 4: Rewrite the real-process takeover test** so it cannot reach the machine: pass `run` built from `defaultRun` with three overrides: `docker` returns `{ status: 1, stdout: '', stderr: '' }`; the `bash …e2e-env.sh sweep` call returns status 0 without running; `ps` output is filtered to the rows whose pid is in an allow-list holding only the pid of the child the test spawned and the test process itself. Spawn a second child whose command line contains `maestro-driver-ios` (a decoy that the default scope would stop on a real machine) and assert after the takeover cleanup that the decoy is still running and the test's own child is stopped. Kill the decoy in `finally`.
-   [ ] **Step 5: Run** `node --test test/cleanup.test.mjs` → PASS. Check the first test of Step 4 fails if the filter is removed (temporarily drop it, see the decoy die, restore it).
-   [ ] **Step 6: Commit** `Run cleanup's commands in its own state folder and keep its takeover test to its own process`.

### Task 3: Owner labels, and a sweep that reads them

**Files:**

-   Modify: `scripts/e2e-env.sh` (`write_override` line 100, `fresh_stray` line 393, `do_sweep` line 398)
-   Modify: `test/e2e-env.test.mjs` (the `fixture()` fake docker, and new tests)

**Interfaces:**

-   Produces: every service in the compose override carries `dev-factory.owner: "<pid>"` (the value `mark_live` records: `${DF_OWNER_PID:-$PPID}`) and `dev-factory.worktree: "<path>"` (`$WORKTREE`, with `\` and `"` escaped), beside the existing `dev-factory: "1"`. A shell function `labelled_in_use <project>` returns 0 when the project's first container has an owner label whose pid is alive, or a worktree label naming a worktree whose `.dev-factory/run.json` changed within `SPARE_MINUTES`; it returns 1 when the labels are missing or `docker` fails. `fresh_stray` and `labelled_in_use` share one helper `fresh_worktree <path>` for the run.json test.

-   [ ] **Step 1: Write the failing tests** in `test/e2e-env.test.mjs`. Extend `fixture()` so its fake docker answers `ps -a --filter label=com.docker.compose.project=… --format …` with the text in a new option `labels` (default empty output, status 0), before the existing `*"ps -aq"*` clause. Tests: `the override labels every service with its owner and worktree` (read the override the existing test reads; assert both labels, owner equal to `DF_OWNER_PID`); `a sweep from another state folder keeps a stack whose labelled owner is alive` (no `live/` file, labels `"<process.pid>|<worktree>"`, assert `docker.log` has no `rm -f`); `a sweep keeps a stack whose worktree has a fresh run.json even when its owner is dead` (owner a pid that has exited, worktree the fixture's, run.json just written); `a sweep removes a stack whose owner is dead and whose worktree is gone` (labels `"<dead pid>|/nonexistent"`, assert `rm -f` is in the log); `a stack with no labels is swept by the live-file rule as before` (labels empty, no live file → swept; with a live file for the fake project and a live pid → kept).
-   [ ] **Step 2: Run** `sandbox-test.sh <wt> node --test test/e2e-env.test.mjs` → the label and owner tests FAIL, the unlabelled test passes already.
-   [ ] **Step 3: Implement** the labels and `labelled_in_use`, and extend the `do_sweep` condition to `! live && ! fresh_stray "$p" && ! labelled_in_use "$p"`. Read the labels with `docker ps -a --filter "label=com.docker.compose.project=$p" --format '{{.Label "dev-factory.owner"}}|{{.Label "dev-factory.worktree"}}'` and take the first line.
-   [ ] **Step 4: Run** `node --test test/e2e-env.test.mjs test/cleanup.test.mjs test/hermetic.test.mjs` → PASS.
-   [ ] **Step 5: Commit** `Label each environment service with its owner and keep the sweep from removing a live one`.

### Task 4: The rule, the docs, the release

**Files:**

-   Modify: `AGENTS.md` (the `## Rules` list), `docs/reference.md` (the environment section that describes the sweep), `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`

-   [ ] **Step 1: Add to `AGENTS.md` Rules**: a test never talks to the machine's real docker or stops a process it did not start, because the suite runs beside the scheduler's live passes; `test/isolate-state.mjs` puts a fake `docker` first on `PATH`, and a test of `cleanup()` injects `run`.
-   [ ] **Step 2: Document in `docs/reference.md`** the two new labels and that the sweep keeps a stack whose labelled owner is alive or whose worktree changed recently; keep the wording by reason.
-   [ ] **Step 3: Bump to `0.20.1`** in both manifests.
-   [ ] **Step 4: Run** `sandbox-test.sh <wt> compare`, the Prettier check on the changed files, `bash scripts/lint-vocabulary.sh` and `claude plugin validate .` (through the runner) → no failure outside the baseline.
-   [ ] **Step 5: Commit** `Release 0.20.1`, push, open the draft pull request. In the body: patch release because there is no new setting and no new behaviour a person sees; say that the stack sweep now reads labels.

---

## Pull request 2: enforcement fixes (0.20.2)

Branch `fix/enforcement-gaps`, from `origin/main`. A person reviews this one: it changes `scripts/config.mjs`, `scripts/guard-lib.mjs` and `scripts/stop-gate*.mjs`.

### Task 5: A settings layer must be a JSON object

**Files:**

-   Modify: `scripts/config.mjs` (`readJson` line 154; its callers at lines 166, 168 and 258)
-   Test: `test/config.test.mjs`

**Interfaces:**

-   Produces: `readLayer(file: string): object` (module-private) reads and parses `file` and throws `Error(`${file}: a settings file must be a JSON object`)` when the result is `null`, an array or a primitive. Parse errors keep today's `${file}: ${message}`. `layers()` and the writer at line 258 use it; `load(file)` with an explicit path is unchanged.

-   [ ] **Step 1: Write the failing test** `a settings layer that is not a JSON object is refused and names the file`: for each of `null`, `[]`, `3`, `"text"`, write it as the user layer (`<DF_STATE_DIR>/config.json`) and, separately, as the project layer (`DF_CONFIG` pointing at a temp file), call `layers({ from: dir, env })`, and assert it throws with a message containing the file path and `a settings file must be a JSON object`. Add `an empty object layer still loads`.
-   [ ] **Step 2: Run** `sandbox-test.sh <wt> node --test test/config.test.mjs` → FAIL for the four values (no throw), PASS for the empty object.
-   [ ] **Step 3: Implement** `readLayer` and use it at the three call sites (the defaults file included).
-   [ ] **Step 4: Run** `node --test test/config.test.mjs test/settings.test.mjs test/project-dir.test.mjs` → PASS.
-   [ ] **Step 5: Commit** `Refuse a settings file that is not a JSON object`.

### Task 6: `gh api -XPOST` is a write

**Files:**

-   Modify: `scripts/guard-lib.mjs` (`ghApiWrites`, line 329), possibly `scripts/guard-paths.mjs` (`unquote`, line 133)
-   Test: `test/guard-hardening.test.mjs` (its `denied`, `allowed` helpers)

**Interfaces:**

-   Produces: `ghApiWrites(args: string[]): boolean` also returns true for an attached method token `-X<METHOD>` (`-XPOST`, `-XDELETE`, `-Xpost`) whose method is not `GET`, wherever it sits among the arguments.

-   [ ] **Step 1: Write the tests** `an attached -X method on gh api is a write`: `denied` for `gh api -XPOST repos/o/r/issues`, `gh api -XDELETE repos/o/r/issues/1`, `gh api repos/o/r/issues -XPATCH`, `gh api -Xpost repos/o/r/issues`, `gh api '-XPOST' repos/o/r/issues`, `gh -R o/r api -XPOST x`; `allowed` for `gh api -XGET repos/o/r/pulls`, `gh api repos/o/r/pulls`, `gh api -X GET repos/o/r/pulls`. And `quoted and escaped gh subcommands are judged as the shell reads them`: `denied` for `gh 'pr' merge 1`, `gh "pr" merge 1`, `gh p\r merge 1`, `gh pr 'merge' 1`.
-   [ ] **Step 2: Run** `sandbox-test.sh <wt> node --test test/guard-hardening.test.mjs` → the `-X` test FAILS. Note which of the quoting cases fail: the design expects `'pr'` and `"pr"` to pass already (the file has `gh "pr" merge 1` today), and the backslash case is the one to check.
-   [ ] **Step 3: Implement** the attached form in `ghApiWrites`: a token matching `/^-X(?!=)(.+)$/` is a write unless its method is `GET` (case-insensitive). If a quoting case failed in Step 2, make `unquote` in `guard-paths.mjs` drop an unquoted backslash and keep the next character, and nothing more. If none failed, the quoting test stays as a regression test and the pull request says it passed before the change.
-   [ ] **Step 4: Run** `node --test test/guard.test.mjs test/guard-hardening.test.mjs test/guard-machine.test.mjs test/guard-writers.test.mjs` → PASS.
-   [ ] **Step 5: Commit** `Treat an attached -X method on gh api as a write`.

### Task 7: The stop gate lets go an agent that no longer owns the run

**Files:**

-   Modify: `scripts/stop-gate-lib.mjs`, `scripts/stop-gate.mjs` (after the `if (!run)` line), the header comment of `stop-gate.mjs`
-   Test: `test/stop-gate.test.mjs`

**Interfaces:**

-   Consumes: `FACTORY_AGENT` from `scripts/run-context.mjs` (`/(^|:)factory-(builder|reviewer|debugger|researcher|improver|promoter)$/`).
-   Produces: `agentRoleOf(agentType: string | null | undefined): string | null` returns the role named by a factory agent type (`'dev-factory:factory-builder'` gives `'builder'`), else `null`. `ownsRun(agentType: string | null | undefined, run: { role?: string }): boolean` is true when `agentRoleOf` is `null` (unknown, so gated as today) or equals `run.role ?? 'builder'`.

-   [ ] **Step 1: Write the failing tests.** Unit: `agentRoleOf` for `dev-factory:factory-builder`, `factory-debugger`, `general-purpose`, `undefined`; `ownsRun` for a matching role, a differing role, no agent type, and a run with no `role` (a builder). Integration, with a helper `gateAs(root, agentType, env = {})` beside the existing `gate()` that sends `{ cwd: root, agent_type }`: a worktree whose `run.json` role is `debugger` with nothing recorded, stopped by a `dev-factory:factory-builder` agent, exits 0 and leaves no `stop-nudges` and no `blocked.json`; the same worktree stopped by `dev-factory:factory-debugger` exits 2 with `not finished` on stderr; a builder run with a refused `build.done` stopped by a `factory-builder` still exits 2 and moves the file to `build.refused` (the 0.20.0 behaviour is unchanged for the owner); the existing no-`agent_type` tests are untouched and still pass.
-   [ ] **Step 2: Run** `sandbox-test.sh <wt> node --test test/stop-gate.test.mjs` → the new tests FAIL.
-   [ ] **Step 3: Implement** both functions in `stop-gate-lib.mjs`, and in `stop-gate.mjs` exit 0 straight after `if (!run) process.exit(0)` when `!ownsRun(evt.agent_type, run)`: before the counter, the `build.refused` move and the `blocked.json` write. Add a line to the header comment saying why (the scheduler has already moved the run to another role).
-   [ ] **Step 4: Run** `node --test test/stop-gate.test.mjs test/run-context.test.mjs test/agents.test.mjs` → PASS.
-   [ ] **Step 5: Commit** `Let the stop gate go an agent whose hand-off was taken`.

### Task 8: Release 0.20.2

-   [ ] **Step 1: Bump** both manifests to `0.20.2`. No setting or documented behaviour changes, so no `docs/reference.md` edit beyond one sentence in the stop-gate paragraph (line 939) that an agent whose role is no longer the run's is released.
-   [ ] **Step 2: Run** the whole suite with `compare`, Prettier, the lint and plugin validation, as in Task 4.
-   [ ] **Step 3: Commit** `Release 0.20.2`, push, open the draft pull request. Body: patch release (bug fixes in enforcement files, no new setting); list the quoting test as passing before the change if Task 6 found that.

---

## Pull request 3: pass arguments, the learnings scan, HTML mentions (0.21.0)

Branch `feat/pass-args-and-html-mentions`, from `origin/main`.

### Task 9: Pass scripts refuse what they do not know, and `improve --dry-run` is a dry run

**Files:**

-   Create: `scripts/pass-args.sh`, `test/pass-args.test.mjs`
-   Modify: `scripts/tick.sh`, `scripts/improve.sh`, `commands/improve.md`, `docs/reference.md` (where `dev-factory improve` is described)

**Interfaces:**

-   Produces: `df_pass_args <script-name> <allowed-flags> -- "$@"` (sourced; bash 3.2). Sets `DF_DRY_RUN` to `1` when `--dry-run` is among the arguments, else `0`; on any argument not in the space-separated `<allowed-flags>` prints `<script-name>: unknown argument '<arg>' (accepted: <allowed-flags or none>)` to stderr and exits 2.

-   [ ] **Step 1: Write the failing tests** in `test/pass-args.test.mjs`: `improve.sh --bogus exits 2 and names the argument` and `tick.sh takes no arguments` (run each from a non-repository temp folder with `DF_STATE_DIR` set; assert status 2, not 1, so the parse happens before the repository check); `df_pass_args sets DF_DRY_RUN` through `bash -c '. scripts/pass-args.sh; df_pass_args improve.sh "--dry-run" -- "$@"; echo $DF_DRY_RUN'` for no arguments (`0`) and `--dry-run` (`1`) and `--dry-run=1` (exit 2). A dry-run test that runs `improve.sh --dry-run` end to end reuses the fixture of `test/scheduler.test.mjs` (its repository, stand-in `claude`, `gh` and `git`, and environment), asserts the stand-in `claude` received a prompt ending `/dev-factory:improve --dry-run`, the stand-in `git` saw no `fetch`, a paused scheduler (`DF_SCHEDULED=1` with the pause switch on) does not stop it, and its output also reached stdout.
-   [ ] **Step 2: Run** `sandbox-test.sh <wt> node --test test/pass-args.test.mjs` → FAIL.
-   [ ] **Step 3: Implement.** `pass-args.sh` as specified. `tick.sh`: right after the `DIR=` line, `. "$DIR/scripts/pass-args.sh"; df_pass_args tick.sh "" -- "$@"`. `improve.sh`: the same with `"--dry-run"`, then use `DF_DRY_RUN`: skip the pause check when it is 1; skip the `git fetch`; build the prompt as `/dev-factory:improve` plus ` --dry-run` when it is 1; send the `claude` output through `tee -a "$LOG"` instead of `>> "$LOG"` when it is 1 (`pipefail` is already set, so `rc` stays `claude`'s). The lock is taken as today.
-   [ ] **Step 4: Update docs.** `commands/improve.md` and `docs/reference.md`: a dry run prints findings and what it would file, takes the lock, does not fetch, ignores the pause switch; an unknown argument exits 2.
-   [ ] **Step 5: Run** `node --test test/pass-args.test.mjs test/scheduler.test.mjs test/cloud.test.mjs test/docs.test.mjs` → PASS (`scheduler.test.mjs` line 565 to 569 reads these scripts' text; keep what it matches).
-   [ ] **Step 6: Commit** `Refuse unknown pass arguments and make improve --dry-run read-only`.

### Task 10: `learnings-scan` survives a large merged-PR list

**Files:**

-   Modify: `scripts/learnings-scan.mjs`
-   Create: `test/learnings-scan.test.mjs`

**Interfaces:**

-   Produces: the `gh pr list` call runs with `maxBuffer: 256 * 1024 * 1024`, and when `--since` starts with `YYYY-MM-DD` adds `--search "merged:>=YYYY-MM-DD"`. The existing in-process filter on `mergedAt` stays (the search is day-granular).

-   [ ] **Step 1: Write the failing tests** with a stand-in `gh` (a shell script in a temp folder first on `PATH`) that appends its arguments to a log and prints a JSON array holding one PR whose `body` is a 3 MB string: `a merged-PR list over 1 MB does not crash the scan` (status 0, stdout parses as `{ entries, candidates }`); `--since 2026-11-01T00:00:00Z asks gh only for PRs merged since that day` (the logged arguments contain `--search` followed by `merged:>=2026-11-01`); `no --since sends no search`; `a --since that is not a date sends no search` (`--since garbage`, no `--search`, status 0).
-   [ ] **Step 2: Run** `sandbox-test.sh <wt> node --test test/learnings-scan.test.mjs` → the first two FAIL (`ENOBUFS`, no search).
-   [ ] **Step 3: Implement** the two changes in `learnings-scan.mjs`.
-   [ ] **Step 4: Run** `node --test test/learnings-scan.test.mjs test/improve.test.mjs` → PASS.
-   [ ] **Step 5: Commit** `Keep learnings-scan inside its buffer and ask only for recent merges`.

### Task 11: Real mentions for an MCP server that takes HTML, and the release

**Files:**

-   Modify: `scripts/comment-lib.mjs` (after `composeAdf`), `scripts/comment.mjs`, `commands/tick.md` (line 170), `skills/task-source/jira.md` (line 3), `docs/reference.md` (the comments section, near line 815), both manifests
-   Test: `test/comment.test.mjs`

**Interfaces:**

-   Produces: `composeHtml({ kind, text, detail = '', people = [] }): string` with `people` as `[{ id, name }]`, deduplicated by `id`, mirroring `composeAdf`. The result is, in order, an optional `<p>` of mentions separated by a space, each `<span data-type="mention" data-user-id="ID">@NAME</span>`; `<p>` with the escaped, `paragraph()`-limited text; `<p>` with the marker line as plain escaped text. `&`, `<`, `>` and `"` are escaped in the text, names and ids. Throws `a comment needs some text` when the text is empty, as `composeAdf` does.
-   `comment.mjs compose --format text|html` (default `text`, unchanged output). With `html` it takes `--assignee-id`, `--assignee-name`, `--reporter-id`, `--reporter-name` as `compose-adf` does and prints `composeHtml`'s string. Any other format exits with `comment: --format must be text or html`.

-   [ ] **Step 1: Write the failing tests.** `composeHtml` renders mentions, the paragraph and the marker line in that order (assert the exact string for one assignee and one reporter, then for none); `composeHtml` deduplicates a person tagged twice; `composeHtml` escapes `</p><script>x</script>` in text and `"` in a name; `composeHtml` keeps the marker line last and defanged text cannot forge one; `composeHtml` throws without text. CLI: `compose --format html …` prints the HTML; `compose` without `--format` prints what it printed before; `compose --format bogus` exits non-zero with the message above.
-   [ ] **Step 2: Run** `sandbox-test.sh <wt> node --test test/comment.test.mjs` → FAIL.
-   [ ] **Step 3: Implement** `composeHtml` and the `--format` option.
-   [ ] **Step 4: Update the instructions.** `commands/tick.md` line 170: for a Jira task, a session that posts through an MCP server that accepts HTML composes with `compose --format html` (account ids and names as above) and posts with `contentFormat: "html"`; through the token server it keeps `[~accountid:ID]` or `compose-adf`. `skills/task-source/jira.md` and `docs/reference.md` say the same in one sentence each, with the reason: a wiki token can arrive as literal text through a server that renders markdown or HTML, and a mention element always notifies.
-   [ ] **Step 5: Confirm or flag the connector claim.** If the Atlassian MCP server is connected in the session, read its comment tool's description and check it takes `contentFormat` with `html`. If it cannot be checked, the pull request body says: the HTML mention form is taken from a third-party report and is untested against the connector.
-   [ ] **Step 6: Release.** Bump both manifests to `0.21.0` (minor: a new option). Run the whole suite with `compare`, Prettier, the lint and plugin validation. Commit `Release 0.21.0`, push, open the draft pull request.

---

## Self-review

-   **Spec coverage:** goal 1 (hermetic tests, owner-aware sweep) is Tasks 1 to 3; goal 2 is Task 5; goal 3 is Task 6; goal 4 is Task 7; goal 5 is Task 9; goal 6 is Task 10; goal 7 is Task 11. The three releases are Tasks 4, 8 and 11. The sandbox and baseline the design requires are Task 0. Non-goals (graphql exception, stack-move refusal, `GH_TOKEN` refusal, any new setting) have no task, by design.
-   **Type consistency:** `readLayer` (Task 5), `agentRoleOf` and `ownsRun` (Task 7), `df_pass_args` and `DF_DRY_RUN` (Task 9), `composeHtml` and the `--format` option (Task 11) each have one definition and the later steps use the same names. `labelled_in_use` and `fresh_worktree` (Task 3) are used only inside `e2e-env.sh`.
-   **Open calls left to the builder:** the exact `sandbox-exec` rules (Task 0, constrained by the four refusals of Step 3), the owner-label escape for odd worktree paths (Task 3), and which quoting cases fail today (Task 6).
