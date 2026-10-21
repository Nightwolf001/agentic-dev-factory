---
description: Weekly self-improvement scan - cluster recurring factory problems, file Jira issues, open draft PRs for the safe ones (usage /dev-factory:improve [--dry-run])
argument-hint: '[--dry-run]'
---

You are the improvement pass of the factory. You hold the Jira and GitHub tools; the improver does not. Read `skills/improve` and follow it. Settings: `improvement.*` in `dev-factory/config.json` (`node dev-factory/scripts/config.mjs get improvement.<key>`).

1. Gather the inputs of the skill and cluster them. With `--dry-run`, print the findings and what you would file, and stop.
2. Deduplicate against open Jira issues labelled `dev-factory-improvement` and file the new ones (project `improvement.jiraProject`, type Improvement, status To Do, assigned to nobody, label `dev-factory-improvement` only). Scrub every body first.
3. For each new finding that qualifies for a PR (capped by `improvement.maxPrsPerScan`):

    1. `git worktree add ../.worktrees/<KEY> -b ai-tooling/<KEY>-<slug> origin/develop` (slug: at most 6 lowercase words).
    2. Write `<worktree>/.dev-factory/run.json`: `{"key","branch","startedAt","mode":"scheduled","runId":"<unix-seconds>","role":"improver","kind":"improvement"}`, then `node dev-factory/scripts/run-context.mjs set --worktree <absolute worktree path>` so the hooks find it.
    3. Dispatch `factory-improver` with the key, worktree, branch, symptom, evidence and proposed change. Wait with a foreground loop (never end your turn to wait):

        ```bash
        W=<worktree>/.dev-factory; end=$((SECONDS+540))
        until [ -f $W/improve.done ] || [ -f $W/blocked.json ] || [ $SECONDS -ge $end ]; do sleep 5; done
        [ -f $W/improve.done ] || [ -f $W/blocked.json ] && echo DONE || echo STILL_WAITING
        ```

        No progress for `caps.stallMinutes` means treat it as blocked.

    4. On `improve.done`: run the two-step review on that commit exactly as `commands/tick.md` section 4 step 6 does (dispatch `factory-reviewer` with `role` `reviewer` and the axis; Critical and High findings go back to the improver once, at most `caps.maxFixRounds` rounds), comment the PR URL and review counts on the Jira issue, and leave the PR as a draft. On `blocked.json`: comment the reason on the Jira issue and leave it for a person.
    5. Remove the worktree.

3b. Promote learnings: run `node dev-factory/scripts/learnings-scan.mjs candidates --since <watermark>`. A candidate is a lesson that recurred on at least `improvement.minEvidence` different tickets, or one a person confirmed with a `/dev-factory promote` comment on the PR. Take at most `improvement.maxPromotionsPerScan`, skip any that an `AGENTS.md` already states, and put them all in one worktree (`git worktree add ../.worktrees/<KEY> -b ai-tooling/<KEY>-agents-rules origin/develop`, `<KEY>` the improvement issue filed for it) with run.json `{"key","branch","startedAt","mode":"scheduled","runId","role":"promoter","kind":"improvement"}`. Dispatch `factory-promoter` with the candidates and wait with the same foreground loop over `promote.done` or `blocked.json`. Review the result with the same two-step review as for an improver PR; a person merges it. Lessons about the factory itself stay in the improvement flow above. 4. Update `dev-factory/IMPROVEMENT-PLAN.md`: inside the improver's PR when there is one, otherwise through one extra branch `ai-tooling/<KEY>-improvement-plan` off `origin/develop` that you commit and open as a draft PR yourself (title `Improvement: update improvement plan [<umbrella KEY or first KEY>]`, label `ai-tooling`). Never push to `develop`; never merge. 5. Post one comment `[dev-factory] improve scan <ISO date>: findings=<n> filed=<n> prs=<n> seen_again=<n>` on the first issue filed, or on the most recent open improvement issue; this is the next scan's watermark. 6. Print the same summary as one line and end the turn.

A person reviews and merges every PR. The factory never merges or approves.
