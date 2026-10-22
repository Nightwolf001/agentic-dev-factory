---
description: Check, after a merge, whether the problem behind a bug task actually stopped happening (usage /dev-factory:validate TASK-12; needs a telemetry MCP server)
argument-hint: '<TASK-KEY>'
---

Validate task $ARGUMENTS against telemetry, in this session, visibly. Needs the Sentry or Axiom MCP server (`node dev-factory/scripts/mcp.mjs enable sentry`); without one, say so and stop.

1. GET the task (`skills/task-source/SKILL.md`): its phase comments hold the triage evidence (Sentry issue id or Axiom query, counts before) and the merge. If there is no triage evidence, say so and stop.
2. Create a detached worktree off `origin/<base>` (`node dev-factory/scripts/worktree.mjs default-branch`) under `../.worktrees/validate-<KEY>`, write `.dev-factory/run.json` there with `{"key","role":"debugger","kind":"bug","debugBefore":<recordedAll from qa.mjs debug status>}`, and dispatch the `factory-debugger` agent with trigger `validate`, the evidence, the environment and the window since the release containing the merge (the release tag or label the task carries; merge time without one). Wait for the recorded round.
3. Report to the person: counts before and after, aggregates only. Draft the task comment, run `node dev-factory/bin/qa.mjs scrub --file <draft>`, and show it. Do not post it, add labels or reopen anything unless asked; the scheduled pass owns that.
4. Remove the worktree.
