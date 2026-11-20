# Per-agent run binding (F10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hooks resolve a factory agent's run through a binding keyed by the agent's own `agent_id`, so several agents can be alive at once, and an agent whose run cannot be resolved is refused instead of being treated as the scheduler.

**Architecture:** The agent's first command (`run-context.mjs bind --worktree <abs>`) is recognised by the Bash hook, which checks it and writes `$STATE/agents/<agent_id>.json`. `resolveRun` reads that binding; the pointer file is retired. Bindings are cleared when the scheduler writes a new role, and at the start of a pass.

**Tech Stack:** Node 20+ ESM, `node --test`, bash 3.2.

**Spec:** `docs/superpowers/specs/2026-11-20-per-agent-run-binding-design.md` (read it whole: the check, the resolution rule, when bindings go, and the rulings).

## Global Constraints

-   `AGENTS.md` applies. This plan edits enforcement files (`scripts/run-context.mjs`, `scripts/guard-bash.mjs`, `scripts/edit-guard.mjs`, `scripts/mcp-guard.mjs`, `scripts/stop-gate.mjs`, `scripts/guard-lib.mjs`): every behavioural change needs a test in `test/`; the vocabulary lint, Prettier 3.2.5 (tabs) and `claude plugin validate .` must pass; shell scripts work under bash 3.2; `test/packaging.test.mjs` fails on a hard-coded `dev-factory/` path (commands and agents run scripts as `node "${CLAUDE_PLUGIN_ROOT}/..."`).
-   A factory agent is an `agent_type` matching `FACTORY_AGENT` in `scripts/run-context.mjs` (`dev-factory:factory-builder` and the other five). The main session has no `agent_id` or `agent_type`: its behaviour must not change. An interactive session whose `cwd` holds `.dev-factory/run.json` must not change either.
-   Roles are `builder`, `reviewer`, `debugger`, `researcher`, `improver`, `promoter` (`ROLES`); an agent type's role comes from `agentRoleOf(agentType)` in `scripts/stop-gate-lib.mjs`.
-   Tests never touch the real state folder (`DF_STATE_DIR` points at a temp folder; `test/isolate-state.mjs` is imported where tests start processes), the real docker, or processes they did not start.
-   Run tests only through the sandbox runner: `bash /Users/francoiswolfaardt/.claude/jobs/399a4ef0/tmp/sandbox-test.sh <worktree> <command...>` (one file: `bash -c 'node --test test/x.test.mjs'`; the suite: `compare`, and `LOOPBACK=1 ... compare`; `lint`; `prettier <files>`). It works on a copy of the working tree. Baselines are current for the shipped 0.22.1 tree.
-   Git: plain single `git` commands from the worktree (no `&&`, `;`, pipes or `cd` in one command). No push, no merge. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

-   Two agents of the same role bound to two worktrees at once, each resolving only to its own run (the interleaved test the concurrency design asks for), including when their events arrive alternately.
-   An agent that never binds: every Bash, edit and MCP call is refused with the bind instruction, and the bind command itself is the one thing allowed; the refusal never leaks another run's data.
-   Bind refusals: missing `agent_id`; a non-factory `agent_type`; a relative path; a worktree with no run; a run whose role differs from the agent's role; a second same-role agent on a worktree that another is bound to; and the accepted cases (rebind by the same agent is idempotent).
-   `write` with a `role` clears that worktree's bindings only; a `write` without `role` clears nothing; `clear` clears all.
-   `workRoot`: the `cwd` run wins; exactly one binding is used; two or more bindings with no `--worktree` stop with a message that says to pass it; no bindings falls to the git root as before.
-   The Bash hook must not let the bind command smuggle anything else: `bind --worktree /w; rm -rf /`, `bind --worktree /w && ...`, a bind with extra flags, or a bind inside a pipeline is not "the bind command" and is evaluated as any other command (then refused for an unbound agent).

---

### Task 1: The binding store and resolution in `scripts/run-context.mjs`

**Files:**

-   Modify: `scripts/run-context.mjs`
-   Test: `test/run-context.test.mjs` (the existing pointer tests there change: see step 1)

**Interfaces:**

-   Produces (exports, used by Task 2 and Task 3):
    -   `bindingsDir(env = process.env): string` = `<state>/agents`.
    -   `bindAgent({ agentId, agentType, worktree, env }): { ok: true, binding } | { ok: false, reason: string }` applying the check in the spec (reasons are plain sentences naming the failed rule) and, when ok, writing `<state>/agents/<agentId>.json` as `{ worktree, role, at }` (write beside and rename; `agentId` must match `^[A-Za-z0-9_-]+$` or the bind is refused).
    -   `unbindWorktree(worktree, env)`: removes every binding for that worktree. `clearBindings(env)`: removes the whole `agents` folder.
    -   `resolveRun({ cwd, agentType = null, agentId = null, env }): { root, run, via, unbound? }`: `cwd` run first (`via: 'cwd'`); then for a factory agent with a binding whose worktree still holds a run.json: `via: 'binding'`; a factory agent with no usable binding: `{ root: gitRoot(cwd), run: null, via: 'none', unbound: true }`; anyone else as today (`via: 'none'`, no `unbound`).
    -   `workRoot({ cwd, env })`: `cwd` run, then the only binding's worktree, else throws `Error` whose message contains `--worktree` when there are two or more bindings, else the git root.
    -   `BIND_COMMAND`-style helper `parseBindCommand(command): { worktree } | null`, recognising exactly `node "<anything>/run-context.mjs" bind --worktree <path>` (path bare or in single or double quotes, absolute, no shell metacharacters `;|&<>$\`()` or newlines anywhere in the command; any other shape returns null).
-   `pointerFile`, `setPointer`, `clearPointer` stay exported for compatibility; `resolveRun` and `workRoot` no longer read the pointer.

-   [ ] **Step 1: Write the failing tests** in `test/run-context.test.mjs`. Replace the tests that assert pointer-based resolution with the binding equivalents; keep the `cwd` and `write` tests. New test names and assertions: `two agents of one role, bound to two worktrees, each resolve to their own run` (interleaved calls, both directions); `an unbound factory agent resolves to no run and is marked unbound; a non-factory agent and the main session are not`; `bindAgent accepts a matching role and refuses each failing rule with a reason` (the full refusal list from Review Focus, and idempotent rebind by the same agent); `a binding to a worktree that lost its run.json is treated as unbound`; `write with a role clears that worktree's bindings only`; `clear removes all bindings and a leftover pointer`; `workRoot: cwd run, one binding, two bindings throw naming --worktree, none falls to the git root`; `parseBindCommand accepts the exact form and rejects chains, pipes, extra flags, relative paths and command substitution`; and one CLI test: `run-context.mjs bind --worktree <abs>` exits 0 and prints a line saying the guard records the binding (it records nothing itself, so no file appears), while `bind` with no worktree exits 3 with a usage message. `set` exits 0 and prints that the pointer is no longer used.
-   [ ] **Step 2: Run** `bash -c 'node --test test/run-context.test.mjs'` in the sandbox and see them fail for the right reasons.
-   [ ] **Step 3: Implement** in `scripts/run-context.mjs`. Rewrite the header comment to describe binding and why the pointer is gone (hooks see `agent_id`, the scheduler's cwd is not the agent's). `write` clears the worktree's bindings when the patch contains a `role` key. CLI: add `bind --worktree DIR` (validate it is absolute; print one line), turn `set` into the no-op with a stderr note and exit 0, make `clear` call `clearBindings` and `clearPointer`; update the usage message.
-   [ ] **Step 4: Run** the file again (pass), then `test/guard.test.mjs`, `test/stop-gate.test.mjs`, `test/mcp-guard.test.mjs`, `test/lock.test.mjs`, `test/entry.test.mjs` for collateral breakage; failures that exist only because they use the retired pointer are fixed in Task 2 (note them in your report) except `test/lock.test.mjs` and `test/entry.test.mjs`, which must pass now.
-   [ ] **Step 5: Commit** (`feat: run binding keyed by the agent id, in place of the machine-wide pointer`).

---

### Task 2: The hooks use the binding and refuse an unbound factory agent

**Files:**

-   Modify: `scripts/guard-bash.mjs`, `scripts/edit-guard.mjs`, `scripts/mcp-guard.mjs`, `scripts/stop-gate.mjs` (pass `agentId: evt.agent_id` to `resolveRun`); `scripts/guard-lib.mjs` only if the Bash evaluation must know about the bind command (prefer not)
-   Test: `test/guard.test.mjs`, `test/mcp-guard.test.mjs`, `test/stop-gate.test.mjs`, and a new hook-level test file `test/agent-binding.test.mjs`

**Interfaces:**

-   Consumes: `resolveRun`, `bindAgent`, `parseBindCommand`, `FACTORY_AGENT` (Task 1).
-   Produces: the behaviour in the spec, as seen through the hook scripts run as processes with a JSON event on stdin (follow how the existing hook tests run `guard-bash.mjs` / `edit-guard.mjs`; their entry is `scripts/*.sh` wrappers, see `hooks/hooks.json`).

-   [ ] **Step 1: Write the failing tests** in the new `test/agent-binding.test.mjs`, driving the real hook scripts with `DF_STATE_DIR` pointing at a temp folder and `DF_ACTIVE=1`, using two temp worktrees each with a `.dev-factory/run.json` (`{"key","branch","role":"builder"}` and a second ticket). Names and assertions: `an unbound factory agent is refused by the Bash, edit and MCP hooks, with the bind command named` (exit 2; the message contains `run-context.mjs` and `bind --worktree`); `the bind command binds the agent and is allowed; the same agent's next command is judged by its own run` (e.g. a `git push` to another branch is refused with the first run's branch in the message, then the second agent bound to the second worktree is judged by the second branch: this is the interleaved test); `a refused bind is exited 2 with the reason and records nothing` (wrong role, relative path, missing agent_id, no run.json, same-role agent already bound); `a bind chained with another command is not the bind command` (`bind --worktree /w; echo x` is refused for an unbound agent); `the main session and a non-factory agent are unaffected` (no agent fields: allowed as before; `agent_type` of another plugin's agent: as before); `an unbound factory agent's stop is not held` (stop-gate exits 0). Update the existing tests in `test/guard.test.mjs`, `test/mcp-guard.test.mjs` and `test/stop-gate.test.mjs` that set a pointer to dispatch an agent so they bind instead (same assertions otherwise).
-   [ ] **Step 2: Run** the new file and see it fail.
-   [ ] **Step 3: Implement.** In `guard-bash.mjs`: after resolving the run, if the agent is a factory agent: when `parseBindCommand(command)` matches, call `bindAgent` with the event's `agent_id`, `agent_type` and the parsed worktree, exit 0 on ok and exit 2 with the reason on refusal, before `evaluate`; when the agent is `unbound`, exit 2 with a message that includes the exact command to run (`node "<plugin root>/scripts/run-context.mjs" bind --worktree <the absolute worktree path your dispatch names>`, the plugin root taken from this script's own location) and says why (the run must be known before any command runs). In `edit-guard.mjs` and `mcp-guard.mjs`: an unbound factory agent is refused the same way (the edit hook and the MCP hook have no bind command: the message says to bind with Bash first). In `stop-gate.mjs` pass `agentId` (an unbound agent already exits 0 through `ownsRun`). The scheduler's own session and non-factory agents take today's path.
-   [ ] **Step 4: Run** `test/agent-binding.test.mjs`, `test/guard.test.mjs`, `test/mcp-guard.test.mjs`, `test/stop-gate.test.mjs`, `test/run-context.test.mjs`, then the whole suite under `compare` and `LOOPBACK=1 ... compare`: no new failures against the baselines.
-   [ ] **Step 5: Commit** (`feat: the hooks resolve a factory agent through its binding and refuse one that has none`).

---

### Task 3: Agents, dispatch sites, clearing and documentation

**Files:**

-   Modify: `agents/factory-builder.md`, `agents/factory-reviewer.md`, `agents/factory-debugger.md`, `agents/factory-researcher.md`, `agents/factory-improver.md`, `agents/factory-promoter.md`; `commands/tick.md`, `commands/build.md`, `commands/quick.md`, `commands/improve.md`, `commands/validate.md`; `scripts/tick.sh`, `scripts/improve.sh`, `scripts/lock.sh`; `bin/qa.mjs` (the help text about the pointer); `docs/reference.md` (the run-pointer paragraph near the state-folder section, the cap rows that name F10 as a prerequisite, the Environments "not settled" paragraph, and the Known-limits bullets); `README.md` only if it names the pointer
-   Test: `test/commands.test.mjs`, `test/lock.test.mjs`, `test/packaging.test.mjs`, `test/docs.test.mjs` (run unchanged unless they must change)

**Interfaces:**

-   Consumes: the CLI `run-context.mjs bind --worktree <abs>` and `clear` (Task 1).

-   [ ] **Step 1: Write the failing tests.** `test/commands.test.mjs`: `every factory agent's instructions start with the bind command` (each `agents/factory-*.md` body, after the front matter, mentions `run-context.mjs" bind --worktree` in its first section, before the phases); `every dispatch site names the worktree to the agent` (in `commands/tick.md`, `build.md`, `quick.md`, `improve.md`, `validate.md` each place that dispatches a `factory-*` agent says the prompt gives the absolute worktree path: assert the phrase `absolute worktree path` appears in each of those files). `test/lock.test.mjs`: acquiring and releasing the lock removes `agents/` as well as the pointer (extend the existing assertion at its line ~19-22 with an `agents/x.json` file).
-   [ ] **Step 2: Run** and see them fail.
-   [ ] **Step 3: Edit.** Each agent file: a short paragraph before the phases, in the file's own voice: your first command, before anything else, is exactly `node "${CLAUDE_PLUGIN_ROOT}/scripts/run-context.mjs" bind --worktree <the absolute worktree path the prompt names>`; until it succeeds every other tool call is refused; and the shell tools that read a run (`qa.mjs`) take `--worktree <that path>`. Dispatch sites: wherever the prompt of a dispatched factory agent is described, add that it names the absolute worktree path and (once, in `commands/tick.md` section 4, with the other commands referring to it) that the agent binds itself first. `commands/build.md` line ~14 and `commands/quick.md`: drop the `run-context.mjs set` step (the pointer is retired); `commands/tick.md` line ~40 likewise. `scripts/tick.sh`, `scripts/improve.sh`, `scripts/lock.sh`: wherever `active-run.json` is removed, also `rm -rf "$STATE/agents"`. `bin/qa.mjs` header and `docs/reference.md`: describe binding in place of the pointer; the prerequisite sentences now say the run pointer prerequisite is met: `caps.maxConcurrent` may rise only together with a tick that dispatches concurrently (not built), and say what a person sees when an agent is refused as unbound.
-   [ ] **Step 4: Run** the focused tests, `test/docs.test.mjs`, `test/hygiene.test.mjs`, `test/packaging.test.mjs`, the vocabulary lint, Prettier on every changed `.md`, `.json` and `.mjs` file (the repository's local Prettier 3.2.5 with `--write`, as earlier tasks did), `claude plugin validate .`, then both full-suite compares.
-   [ ] **Step 5: Commit** (`feat: agents bind their run first; the pointer is retired from the commands, scripts and docs`).
