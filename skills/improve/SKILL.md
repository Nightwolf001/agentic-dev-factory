---
name: improve
description: Turn the factory's own run records, learnings and blocked tasks into deduplicated improvement tasks and draft PRs. Use for the weekly scan and /dev-factory:improve.
---

# Improve

Inputs, all read-only:

-   `node dev-factory/scripts/run-record.mjs clusters --since <last scan> --min <improvement.minEvidence>` for recurring causes across different tickets (same debug fingerprint, same blocked reason, repeated review Critical or High, repeated QA retries).
-   The `## Learnings` sections of PR bodies merged since the last scan: `node dev-factory/scripts/learnings-scan.mjs candidates --since <watermark>` (nothing is committed to the repository for learnings).
-   Comments of tasks labelled `tasks.blockedLabel` or `factory-regression` since the last scan.

Method:

1. The watermark is the date in the most recent `[dev-factory] improve scan` comment on the improvement umbrella task, or 14 days ago for the first scan.
2. A finding needs at least `improvement.minEvidence` occurrences across different tickets. One-off failures are not findings. A symptom with no evidence is not a finding.
3. Deduplicate: LIST the tasks labelled `improvement.label` that are not `done` (in Jira: `project = <improvement.project> AND labels = "<improvement.label>" AND statusCategory != Done`). A match is commented on with the new evidence count instead of filed again.
4. File at most `improvement.maxTicketsPerScan` new issues, highest evidence first. Each states the recurring symptom, the evidence (run ids, fingerprints, ticket keys and counts, scrubbed), and the proposed change to a skill, agent, hook, config or script. Labels: `dev-factory-improvement` only, never `dev-factory`, so the factory does not build changes to itself unattended.
5. A finding becomes a draft PR only when its change is confined to `dev-factory/` and avoids the enforcement files (`factory-improver`'s rules), and at most `improvement.maxPrsPerScan` per scan. Anything touching enforcement stays an improvement task for a person.
6. Keep `dev-factory/IMPROVEMENT-PLAN.md` current: one row per finding with symptom, evidence count, proposed change, task key, PR URL and status.
7. Run `node dev-factory/bin/qa.mjs scrub --file` on every issue body, PR body and comment before posting.

Promotion of learnings into `AGENTS.md`:

-   A learning is promoted when it recurred on at least `improvement.minEvidence` different tickets, or a person put `/dev-factory promote` on its PR. Everything else stays in the PR body and the preload index.
-   The target is the closest `AGENTS.md` to the learning's `scope`, in its `## Learned rules` section: one rule line of at most 200 characters ending with its evidence ticket keys, at most `improvement.agentsRuleCap` per section (merge or retire before adding). `factory-promoter` does it and `qa.mjs promote check` proves only that section changed.
-   Never `CLAUDE.md`, editor rule files or `dev-factory/AGENTS.md`. A person merges the draft PR.
