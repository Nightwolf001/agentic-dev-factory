---
name: qa
description: Author QA cases for a ticket and walk them through Playwright or Maestro MCP, recording each result with bin/qa.mjs. Use after the build is green and committed.
---

# QA

Everything is committed before you start. `qa.mjs start` refuses a dirty tree and binds the run to HEAD; a later commit invalidates it.

## 1. Decide

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" mark-na --key KEY --profile web|mobile --reason "..."`. If the diff touches no UI surface the tool accepts and you skip to ship. If it refuses, the ticket needs a walk.

## 2. Author cases

For each UI-facing acceptance criterion write one case under `.factory/qa/cases/<KEY>/`:

-   web: `<slug>.spec.ts` (Playwright steps with the assertion each step checks)
-   mobile: `<slug>.yaml` (Maestro flow; use the repository's own testID conventions, and add stable testIDs to the screens you touch)

Each case names its assertions up front (a testID, a text, an element). The walk checks those, not an impression. Commit the cases, then start.

## 3. Walk

1. `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" start --key KEY --profile web` prints the run number and the case list.
2. Web: use the `playwright` MCP tools; the first call is `browser_navigate` to `webBaseUrl` from `.dev-factory/env.json` (the profile's `baseUrl` when absent) (a relative `goto` has nothing to resolve against). Mobile: use the `maestro` MCP tools with the device from `.dev-factory/env.json`.
3. For each case, follow its declared steps and check its declared assertions. Take a screenshot of the state the case asserts (Playwright: `filename` under `.playwright-mcp/`; Maestro: `xcrun simctl io <udid> screenshot /tmp/<name>.png`). Screenshots live outside tracked paths.
4. Record: `qa.mjs record --run N --case SLUG --status pass|fail --assertion "what you observed in this walk" --screenshot <file>`.
   A pass needs an assertion of 8 or more characters and a fresh PNG or JPEG of at least 1 KB that is not byte-identical to another case's. If a capture is refused as a duplicate, frame a different state; never copy or edit a file to get past the check.
5. `qa.mjs done --run N` closes the run. Every case must be recorded, HEAD unmoved, tree clean.
6. Close what the walk opened: call `browser_close` on the `playwright` MCP, and let a Maestro flow finish (do not leave `maestro studio` or a recording running). A browser or flow left open holds the next run's ports and devices; `scripts/cleanup.mjs` stops any that remain, but the walk ends cleanly first.

## 4. Failures

-   App bug: fix the code, commit, start a new run.
-   Case bug (wrong selector, stale assertion): fix the case, commit, start a new run.
-   Environment (device or browser unreachable, expired login, stale build): `scripts/e2e-env.sh verify`; one restart of the MCP server or service is allowed; then block.
-   Five fix attempts per ticket at most, then `.dev-factory/blocked.json` naming the case, step and evidence.
