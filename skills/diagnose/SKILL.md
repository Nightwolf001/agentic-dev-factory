---
name: diagnose
description: Root cause before any fix, with a red-capable feedback loop and the dev-factory debug records. Use for a bug ticket, a stuck fix budget, or a post-merge validation.
---

# Diagnose

Builds on `superpowers:systematic-debugging`; read it, do not restate it. What this adds:

1. No fix and no fix plan before a feedback loop that can go red: a failing test in the ticket's environment, a curl against its stack, a replay of a captured Sentry event or Axiom log sample, a bisect over `git log`.
2. Run the loop through `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" debug run --id N -- <command>`. The record stores the command and the exit code observed there; a loop you did not run through it does not count.
3. One hypothesis, one change or check, one rerun. Write the hypothesis down before testing it.
4. Three failed hypotheses is an architecture signal, not a reason to try a fourth: `qa.mjs debug block --reason "<what was tried>"`.
5. The root cause is a sentence that names the mechanism, at least 40 characters, with at least one evidence item (`sentry`, `axiom`, `log` or `test`) that a person can open by its id or query.
6. The fix plan is for the builder to execute test-first. It names the seam, the first red test and the files, and a validation plan says which Sentry or Axiom aggregate should change after the merge.
7. Budgets are enforced by `qa.mjs debug open` (rounds per ticket, repeated fingerprint) and `qa.mjs debug record` (minutes). When either refuses, stop; do not work around it.
