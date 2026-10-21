---
description: Check, after a merge, whether the issue behind a bug ticket actually stopped happening (usage /dev-factory:validate OAPP-1234)
argument-hint: '<JIRA-KEY>'
---

Validate ticket $ARGUMENTS against telemetry, in this session, visibly.

1. Read the issue through the Atlassian MCP: its phase comments hold the triage evidence (Sentry issue id or Axiom query, counts before) and the merge. If there is no triage evidence, say so and stop.
2. Create a detached worktree off `origin/develop` under `../.worktrees/validate-<KEY>`, write `.dev-factory/run.json` there with `{"key","role":"debugger","kind":"bug","debugBefore":<recordedAll from qa.mjs debug status>}`, and dispatch the `factory-debugger` agent with trigger `validate`, the evidence, the environment and the window since the release containing the merge (the `olarm-system-X.Y.Z` or `app-X.Y.Z` label; merge time without one). Wait for the recorded round.
3. Report to the person: counts before and after, aggregates only. Draft the Jira comment, run `node dev-factory/bin/qa.mjs scrub --file <draft>`, and show it. Do not post it, add labels or reopen anything unless asked; the scheduled pass owns that.
4. Remove the worktree.
