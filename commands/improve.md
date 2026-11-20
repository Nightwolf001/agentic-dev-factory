---
description: Weekly self-improvement scan - cluster recurring factory problems, file improvement tasks, open draft PRs for the safe ones (usage /dev-factory:improve [--dry-run])
argument-hint: '[--dry-run]'
---

You are the improvement pass of the factory. You hold the task-source and GitHub tools (`skills/task-source/SKILL.md`); the improver does not. Read `skills/improve` and follow it. Settings: `improvement.*` in `config.json` (`node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get improvement.<key>`).

Every agent you dispatch with the Agent tool runs with the model and effort the settings name for its role: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" agent <role>` (role: `builder`, `reviewer`, `debugger`, `researcher`, `improver` or `promoter`), which prints `{"model","effort"}`, and pass both as the tool's `model` and `effort`. The agent's own frontmatter is only the fallback.

`<worktrees>` below is the folder worktrees live in: the output of `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.mjs" root` (`git.worktreeRoot`, by default a `.worktrees` folder beside the repository; point it at a writable folder in a cloud environment).

0. Find where the factory can be changed from here: `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory-target.mjs"` prints `{"mode","repo","prefix","reason"}`. `self` (this repository is the plugin's own), `clone` (`improvement.factoryRepo` or `DF_FACTORY_REPO` names a local checkout of it) and `vendored` (copied into this repository at `dev-factory/`) allow improvement PRs, made in `repo` with the folder `prefix`; `none` (an installed plugin lives in Claude's plugin cache) allows none and the findings stay improvement tasks, so say the `reason` in your report.
1. Gather the inputs of the skill and cluster them. With `--dry-run`, print the findings and what you would file, and stop. (`dev-factory improve --dry-run` runs this command through `improve.sh`: it still takes the lock, runs the doctor and refreshes the factory's generated settings files, does not fetch, ignores the pause switch, and prints this output on the terminal as well as in the log; no script stops you from filing, so filing nothing is this instruction, and you keep to it.)
2. Deduplicate against open tasks labelled `improvement.label` and CREATE the new ones (project or database `improvement.project` when the source needs one, type Improvement, state `ready` but without `tasks.label`, so the factory does not build its own changes, label `improvement.label` only). Scrub every body first.
3. For each new finding that qualifies for a PR (capped by `improvement.maxPrsPerScan`; none when step 0 said `none`):

    1. In the factory repository from step 0: `git -C <repo> fetch origin`, then `git -C <repo> worktree add <worktrees>/<KEY> -b ai-tooling/<KEY>-<slug> origin/<base>`, where `<base>` is `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.mjs" default-branch --repo <repo>` (slug: at most 6 lowercase words). A pull request opened from that worktree goes to the factory's own repository.
    2. Record the run in `<worktree>/.dev-factory/run.json` with `node "${CLAUDE_PLUGIN_ROOT}/scripts/run-context.mjs" write --worktree <absolute worktree path> --json '<the object>'` (the edit tools and the shell are refused on that file during a scheduled pass), the object being `{"key","branch","startedAt","mode":"scheduled","runId":"<unix-seconds>","role":"improver","kind":"improvement","factoryPrefix":"<prefix>"}` (`factoryPrefix` from step 0: the guards confine the improver to that folder, or to the whole repository when it is empty). The improver binds itself to this run first, as `commands/tick.md` section 4 step 2 says, and every dispatch below is preceded by a `write` of its `role`, even when unchanged.
    3. Dispatch `factory-improver` with the key, the absolute worktree path, branch, `prefix`, symptom, evidence and proposed change. Wait with a foreground loop (never end your turn to wait):

        ```bash
        W=<worktree>/.dev-factory; end=$((SECONDS+540))
        until [ -f $W/improve.done ] || [ -f $W/blocked.json ] || [ $SECONDS -ge $end ]; do sleep 5; done
        [ -f $W/improve.done ] || [ -f $W/blocked.json ] && echo DONE || echo STILL_WAITING
        ```

        No progress for `caps.stallMinutes` means treat it as blocked.

    4. On `improve.done`: run the two-step review on that commit exactly as `commands/tick.md` section 4 step 6 does (write `role` `reviewer` and the axis with `run-context.mjs write`, then dispatch `factory-reviewer` with the absolute worktree path and the axis; Critical and High findings go back to the improver once, at most `caps.maxFixRounds` rounds; before each re-dispatch of the improver, rewrite `role` `improver` in run.json (`run-context.mjs write`, as in step 2) and delete `improve.done`, so the stop gate holds it to its own finish line and the wait loop above is not satisfied by the old file), COMMENT the PR URL and review counts on the improvement task, and leave the PR as a draft. On `blocked.json`: COMMENT the reason on the task and leave it for a person.
    5. Remove the worktree.

3b. Promote learnings: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/learnings-scan.mjs" candidates --since <watermark>`. A candidate is a lesson that recurred on at least `improvement.minEvidence` different tickets, or one a person confirmed with a `/dev-factory promote` comment on the PR. Take at most `improvement.maxPromotionsPerScan`, skip any that an `AGENTS.md` already states, and put them all in one worktree (`git worktree add <worktrees>/<KEY> -b ai-tooling/<KEY>-agents-rules origin/<base>`, `<KEY>` the improvement task filed for it) with run.json written by `run-context.mjs write` (as in step 3.2) as `{"key","branch","startedAt","mode":"scheduled","runId","role":"promoter","kind":"improvement"}`. Dispatch `factory-promoter` with the absolute worktree path, the candidates and wait with the same foreground loop over `promote.done` or `blocked.json`. Review the result with the same two-step review as for an improver PR (before each re-dispatch of the promoter, rewrite `role` `promoter` in run.json (`run-context.mjs write`, as above) and delete `promote.done`, so the stop gate holds it to its own finish line and the wait loop is not satisfied by the old file); a person merges it. Lessons about the factory itself stay in the improvement flow above.

4. Update `<prefix>IMPROVEMENT-PLAN.md` (`prefix` from step 0; empty when the factory is its own repository): inside the improver's PR when there is one, otherwise through one extra branch `ai-tooling/<KEY>-improvement-plan` off `origin/<base>` that you commit and open as a draft PR yourself (title `Improvement: update improvement plan [<umbrella KEY or first KEY>]`, label `ai-tooling`). Never push to the base branch; never merge.
5. Post one comment `[dev-factory] improve scan <ISO date>: findings=<n> filed=<n> prs=<n> seen_again=<n>` on the first task filed, or on the most recent open improvement task; this is the next scan's watermark.
6. Print the same summary as one line and end the turn.

A person reviews and merges every PR. The improve pass never merges or approves, and auto-merge never takes its `ai-tooling/` branches.
