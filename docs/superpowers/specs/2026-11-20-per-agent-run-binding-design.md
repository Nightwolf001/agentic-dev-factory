# Per-agent run binding (F10)

Design, 2026-11-20. The last prerequisite of raising `caps.maxConcurrent` above 1 (`docs/superpowers/specs/2026-11-19-concurrent-task-environments-design.md`, section 4).

## The problem

A factory agent (builder, reviewer, debugger, researcher, improver, promoter) is dispatched by the scheduler's own session, so its hook events carry the scheduler's `cwd`, never its worktree. Hooks therefore find "the run this agent belongs to" through one file per machine, `$STATE/active-run.json`, which the scheduler points at the worktree it is dispatching into (`scripts/run-context.mjs`).

Two things are wrong with that:

1. **Concurrency.** Two agents alive at once resolve to the same pointer, so each is judged by the other's run: wrong branch, wrong role, wrong key.
2. **Failing open.** The Bash hook is active in the scheduler's session (`DF_ACTIVE=1`), and an agent whose run is not found gets `run: null`, which the guard reads as the scheduler itself: no role limits. A lost or stale pointer widens an agent's rights instead of stopping it.

## What a hook can know

From the hooks reference (checked 2026-11-20 against the docs; the CLI here is 2.1.328):

-   Every tool hook inside a subagent carries `agent_id` (unique to that subagent) and `agent_type` (`dev-factory:factory-builder`, ...). The main session carries neither.
-   `cd` does not persist between a subagent's Bash calls, and the hook `cwd` is the session's, not the subagent's.
-   `SubagentStart` carries `agent_id` and `agent_type` and no prompt, path or worktree. Starts of parallel or background subagents have no documented order, so the Nth start cannot be matched to the Nth dispatch.
-   There is no per-subagent environment variable, and a plugin subagent's own `hooks` frontmatter is ignored (hooks from the plugin's `hooks/hooks.json` do fire).

So the identity exists (`agent_id`), and the worktree has to come from the agent.

## Goals

1. Each factory agent's hook events resolve to the worktree it was dispatched into, with any number of agents alive at once.
2. A factory agent whose run cannot be resolved is refused, with a message that says how to fix it, and is never treated as the scheduler.
3. The scheduler's own session, an interactive session in a worktree, and every non-factory agent behave exactly as today.

## Non-goals

-   Concurrent dispatch itself (the tick still runs one ticket at a time; this removes the blocker, it does not raise `caps.maxConcurrent`).
-   Authenticating a malicious agent. The guard constrains a model that follows its instructions and resists text it reads; it is not a sandbox. The binding is checked (below) so that a confused or injected agent cannot adopt a different run by accident, not against code run outside the guard.

## The design

**Binding.** A factory agent's first command names its worktree: `node "${CLAUDE_PLUGIN_ROOT}/scripts/run-context.mjs" bind --worktree <absolute path>`. The Bash hook recognises that exact form for a factory agent, checks it, and records `$STATE/agents/<agent_id>.json` = `{ worktree, role, at }`. The command then runs as a no-op that says the guard records the binding. (The hook is the only place that sees `agent_id`, so it, not the command, writes the record.)

**The check.** A bind is accepted only when all hold: the agent type is a factory agent and `agent_id` is present; the worktree is absolute and holds `.dev-factory/run.json`; that run's `role` equals the role of the agent's type (the scheduler wrote the role; an agent cannot change it, since `run-context.mjs write` is refused to every factory role); and no other agent of the same role is bound to that worktree. A refused bind says which rule failed.

**Resolution.** `resolveRun({ cwd, agentType, agentId })`: a `run.json` in `cwd` still wins (an interactive session in a worktree). Otherwise a factory agent resolves through its own binding. A factory agent with no binding resolves to `{ run: null, unbound: true }`, and the Bash, edit and MCP hooks refuse its calls with: bind first (the exact command, the worktree being the absolute path the dispatch names), except the bind command itself. The pointer file is no longer read.

**When bindings go.** `run-context.mjs write` with a `role` clears the worktree's bindings (a new stage is a new agent, and the scheduler writes the role before every dispatch), the stop gate removes a stopping agent's, and a binding expires after 12 hours. A re-dispatch therefore never meets its predecessor's, and a binding left by an agent that died stops counting on its own.

**Tools that run inside an agent** (`qa.mjs`, `coverage.mjs`: `workRoot`) have no agent identity. Without `--worktree` they use the `cwd` run, then the only live binding if there is exactly one (today's sequential flow keeps working unchanged), and with two or more bindings they stop and say to pass `--worktree`. Agent instructions already name the worktree; the dispatch prompts and agent files are updated to pass it.

**`set` and `clear`.** `set` stays for one release as a no-op that says it is no longer used; `clear` clears the bindings and removes a leftover pointer.

## Approaches considered

1. **Agent declares its worktree; the hook binds (chosen).** Needs one new first command per agent, enforced by the hook (an unbound agent is refused), so the failure of an agent that forgets is a clear message, not silent misbehaviour. Depends only on documented fields.
2. **`SubagentStart` binds from the pointer.** The scheduler sets the pointer, dispatches, and the start hook consumes it. Rejected: it needs dispatches to be strictly sequential and start events to be ordered, which the docs do not promise, and the docs do not say whether the agent waits for the hook.
3. **One `claude -p` process per worktree.** Each process has its own `cwd` in every hook event, so nothing needs binding. Rejected for now: it replaces the tick's single-session design and its dispatch, review and ship stages; a far larger change than the problem needs. It remains the fallback if the binding proves unreliable.
4. **A token in `run.json` and in the prompt.** More plumbing for protection the model cannot keep (an agent can read other worktrees' files), so rejected: the role and same-role checks stop the accidental case.

## Rulings made while designing

-   No token (approach 4): costs a determined, injected agent being able to try to adopt a run of its own role that no live same-role agent holds. Cheap to add later.
-   The pointer is retired, not kept as a fallback: a fallback would be the fail-open path again. Cost: every dispatch site and agent file gains the bind line, and an agent that forgets is refused until it binds (the message says how).
-   The sole-binding fallback for `workRoot` keeps the sequential flow working without touching every `qa.mjs` call.
-   A pass does not clear bindings, because interactive sessions share the state folder: they take no lock, so a pass that wiped the folder would unbind their live agents. A binding left by an agent that died expires after 12 hours instead.

## What is left to the builder

The exact refusal wording; whether the bind command's no-op prints one line or two; the file mode of the `agents/` folder (state folder permissions apply).

## Order of work

1. `scripts/run-context.mjs`: the binding store, rules, `resolveRun`, `workRoot`, `write` clearing, CLI.
2. The hooks (`guard-bash`, `edit-guard`, `mcp-guard`, `stop-gate`) pass `agent_id`, intercept the bind command, and refuse unbound factory agents.
3. Plumbing: agent files and dispatch sites, `tick.sh`/`improve.sh`/`lock.sh` clearing, docs.
4. Afterwards, separately: the tick can dispatch concurrently, and `caps.maxConcurrent` can be raised.
