---
name: qa
description: Author QA cases for a ticket and walk them through Playwright or Maestro MCP, recording each result with bin/qa.mjs. Use after the build is green and committed.
---

# QA

Repository skills: `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get repoSkills.qa` prints the skills this repository adds to this phase (an error or `[]` means none). Invoke each one with the Skill tool before you start; they are the repository's own rules for qa, and they add to the steps below, never replace them.

Everything is committed before you start. `qa.mjs start` refuses a dirty tree and binds the run to HEAD; a later commit invalidates it.

## 1. Decide

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" mark-na --key KEY --profile web|mobile|service --reason "..."` (at least 8 characters saying why). It is accepted only when every changed file is one the profile lists in `noBehaviourGlobs`: documentation, tests, formatting rules. A change to code that runs needs QA whether or not it is a screen: a backend or worker change is not "no UI", it is a `service` change. If the tool refuses, the ticket needs its cases walked.

## 2. Author cases

For each acceptance criterion write one case under `.factory/qa/cases/<KEY>/`. The file name says what kind of case it is:

-   web: `<slug>.spec.ts` (Playwright steps with the assertion each step checks)
-   mobile: `<slug>.yaml` (Maestro flow; use the repository's own testID conventions, and add stable testIDs to the screens you touch)
-   api: `<slug>.api.md` (the request, the answer it must get, and what must be true of the body)
-   worker: `<slug>.worker.md` (the job or message that starts it, what it must have done afterwards, and where to see that)

One run covers every case of the ticket, so a change with a screen and an endpoint lists both kinds; use `--profile service` when there is no screen.

Each case names its assertions up front (a testID, a text, an element). The walk checks those, not an impression. Commit the cases, then start.

## 3. Walk

1. `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" start --key KEY --profile web` prints the run number and the case list.
2. Web: use the `playwright` MCP tools; the first call is `browser_navigate` to `webBaseUrl` from `.dev-factory/env.json` (the profile's `baseUrl` when absent) (a relative `goto` has nothing to resolve against). Mobile: use the `maestro` MCP tools with the device from `.dev-factory/env.json`.
3. Remote ticket (`.dev-factory/env.json` has `mode` `remote`): sign the QA account in with `bash "${CLAUDE_PLUGIN_ROOT}/scripts/qa-login.sh" --worktree <worktree>` on a device, or, for a web case, have the `.spec.ts` read `process.env[<remote.userVar>]` and `process.env[<remote.passwordVar>]` (the names are in `env.json`; the values are never printed, typed into a command or put in a screenshot's filename). Never name a `DF_REMOTE_*` variable in a command: the guard refuses it.
    - 3b. For each case, follow its declared steps and check its declared assertions. Take a screenshot of the state the case asserts (Playwright: `filename` under `.playwright-mcp/`; Maestro: `xcrun simctl io <udid> screenshot /tmp/<name>.png`). Screenshots live outside tracked paths.
4. Record: `qa.mjs record --run N --case SLUG --status pass|fail --assertion "what you observed in this walk" --screenshot <file>`.
   A pass needs an assertion of 8 or more characters and evidence of the case's own kind. A **ui** case needs a fresh PNG or JPEG of at least 1 KB that is not byte-identical to another case's. An **api** case needs a probe or a screenshot: `qa.mjs probe --run N --case SLUG --url URL [--method POST] [--header 'Name: value'] [--body-file F] --expect-status 201` sends the request itself (only to this machine or a host `.dev-factory/env.json` names, never following a redirect) and keeps the answer, with the names of the headers sent and not their values, a short redacted excerpt of the body and the status; a probe that did not get the expected answer cannot pass the case. A **worker** case needs the worker's own output: `qa.mjs record ... --kind worker --evidence-file <file>` (what the job logged, the rows it wrote, the message it sent; at least 32 characters, redacted when kept). `--video <file>` (MP4, MOV or WebM) and `--log <file>` (the newest 8 KB, redacted) can be added to any case as support, but a video or a log alone never passes a case. If a capture is refused as a duplicate, frame a different state; never copy or edit a file to get past the check.
5. `qa.mjs done --run N` closes the run and counts the cases per kind (`caseSummary`). Every case must be recorded, HEAD unmoved, tree clean.
6. Close what the walk opened: call `browser_close` on the `playwright` MCP, and let a Maestro flow finish (do not leave `maestro studio` or a recording running). A browser or flow left open holds the next run's ports and devices; `scripts/cleanup.mjs` stops any that remain, but the walk ends cleanly first.

## 4. Failures

-   App bug: fix the code, commit, start a new run.
-   Case bug (wrong selector, stale assertion): fix the case, commit, start a new run.
-   Environment (device or browser unreachable, expired login, stale build): `bash "${CLAUDE_PLUGIN_ROOT}/scripts/e2e-env.sh" verify --worktree <worktree>`; one restart of the MCP server or service is allowed; then block.
-   Five fix attempts per ticket at most, then `.dev-factory/blocked.json` naming the case, step and evidence.
