---
description: One unattended pass - pick up labelled tasks from the configured task source, build each to a draft PR, advance finished ones. Scheduled by scripts/tick.sh.
---

You are the scheduler pass of the factory. You hold the task-source and GitHub tools; the builder does not. Be mechanical. Never ask a question: a situation you cannot resolve becomes a `factory-blocked` label and a comment, then you move on. Read state from the task source and GitHub, never from a builder's narrative.

`<worktrees>` below is the folder worktrees live in: the output of `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.mjs" root` (`git.worktreeRoot`, by default a `.worktrees` folder beside the repository; point it at a writable folder in a cloud environment).

Read `skills/task-source/SKILL.md` and the file for the active source (`node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get tasks.source`) before anything else: it defines the operations used below (LIST, GET, SET, COMMENT, BLOCK) and how to perform them. Settings come from `config.json` merged with the repository's `dev-factory.config.json` (read with `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get <path>`; `DF_*` variables override it). Logical states are `ready`, `inProgress`, `inReview`, `reviewed`, `done`, with the source's own names in `source.states.*`; the label names are `tasks.label` and `tasks.blockedLabel`; always use the configured values. Caps come from `caps.*`, branch types from `git.branchTypes` (matched case-insensitively against the task type; an unlisted type is `task`).

Phase comments: every phase exit writes one COMMENT `[dev-factory] phase: <name> <state> run=<run-id> head=<sha>`. The latest such comment is the resume position. Phase names: claim, environment, prepare, build, qa, review, ship, resume, validate.

## 0. Housekeeping

1. `bash "${CLAUDE_PLUGIN_ROOT}/scripts/e2e-env.sh" sweep`.
2. Advance finished work first (section 5), so capacity frees before new claims.

## 1. Caps

Stop claiming (still do section 5) when any holds:

-   Open factory PRs: `gh pr list --author @me --state open --json number | jq length` is at least `DF_MAX_OPEN_PRS`.
-   Breaker: tasks labelled `tasks.blockedLabel` and updated within `caps.breakerWindowHours` number `caps.breakerThreshold` or more (`node "${CLAUDE_PLUGIN_ROOT}/scripts/tasks.mjs" list --label <blockedLabel> --updated-within-minutes <hours*60>` for local and github; the breaker search in `skills/task-source/jira.md` for jira).
-   Canonical-ports environment busy: `ls ~/.dev-factory/ports.lock` exists (every ticket while `caps.maxConcurrent` is 1).

## 1b. Strays (orphaned work)

A session killed mid-build leaves a task `inProgress` with nothing driving it. This pass is the only one running (single flight), so any `inProgress` task with the label whose last update is older than `caps.stallMinutes` is a stray (LIST stale). Section 5 runs first, so a task whose worktree already holds `build.done`, `ship.done` or `blocked.json` is advanced there and is not a stray any more.

For each stray, in queue order:

-   Count its comments of the form `[dev-factory] phase: resume started`. At `caps.maxResumes` (`DF_MAX_RESUMES`) or more: section 6 with reason `stalled after <n> resumes`.
-   Worktree `<worktrees>/<KEY>` exists: comment `[dev-factory] phase: resume started run=<run-id> head=<sha>`, rewrite `role`, `until` and `kind` in its run.json, delete `.dev-factory/stop-nudges`, run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/e2e-env.sh" up --worktree <worktree> --key <KEY> --ports canonical` first, whatever the phase (it reuses a stack that is still healthy and rebuilds one that is gone), then continue from the phase after the latest phase comment (section 4's numbered step that follows it). A resume counts against the same `DF_MAX_CONCURRENT` slots as a claim.
-   No worktree: comment `[dev-factory] phase: resume started (no worktree)`, SET it back to `ready` so section 3 picks it up fresh. It counts as a resume.

## 2. Frontier

LIST `ready`, in the source's order (rank, or oldest first). GET each and drop it if any blocker is not `done` (a `Blocked by:` line in the description counts the same as a native link). Take at most `DF_MAX_CONCURRENT` of what remains.

## 3. Claim

Readiness first: write the task description to a temp file and run `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" ticket lint --file <file>`. If it fails, do not claim: BLOCK it with reason `needs acceptance criteria` and decision `<the lint's message>`, and move on. Count it as blocked in the exit line.

Base branch next, from the same temp file: `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" ticket base --file <file>` prints `{"base": "<branch>"}` when the description has a `Base branch:` line and `null` otherwise. Then `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.mjs" resolve` (add `--base <branch>` when one was named). With no named base the run builds on `git.baseBranch`, or the repository's default branch when that is unset; a named base is used as given. Exit 2 or 3 means the base cannot be used (unknown, not on origin, or the local copy is ahead of origin): do not claim: BLOCK it with the message as the reason and decision `push the base branch, or correct the Base branch line`, and move on. Keep the resolved `name` as `<base>` for this task.

For each chosen task: SET it `inProgress`. If the source refuses (its status changed under you), skip it; that is the lost race. COMMENT the phase `claim started`.

Decide fix versus fresh: if the latest phase comment is `ship done` (or `fix started`) and an open PR exists for its branch, this is a fix pass on that branch (carry the reviewer's comments from the PR and the task into the builder prompt). Otherwise it is fresh.

Fix pass hygiene: read the PR's review threads verbatim (`gh api repos/{owner}/{repo}/pulls/<N>/comments --jq '.[] | {path,line,body,user: .user.login}'` and `gh pr view <N> --json comments,reviews`) and pass them to the builder with the task's `tasks.fixComment` comment. A fix pass keeps the PR's own base: `<base>` is `baseRefName` from `gh pr view <N> --json baseRefName`, whatever the ticket says now. After checking out the branch, merge the base into it before any build: `git -C <worktree> merge --no-edit origin/<base>`. A conflict is not resolved by the factory: `git merge --abort`, then section 6 with reason `merge conflict with <base>` and the conflicting file names from `git diff --name-only --diff-filter=U` taken before the abort.

## 4. Build

Per claimed task, sequentially when `DF_MAX_CONCURRENT` is 1:

1. Worktree: fresh pass, `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.mjs" add --branch <type>/<KEY>-<slug> --path <worktrees>/<KEY>` (add `--base <base>` when the task named one; it branches off `origin/<base>` and keeps `.dev-factory/` out of git); fix pass, `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.mjs" attach --branch <branch> --path <worktrees>/<KEY>`. `type` from `git.branchTypes` for the task type (an unlisted type is `task`); `slug` is lowercase words from the summary, at most 6, joined by `-`. If the repository's CI enforces a branch-name pattern (look under `.github/workflows`), confirm the branch matches it.
2. Write `<worktree>/.dev-factory/run.json`: `{"key","branch","base":"<base>","startedAt","mode":"scheduled","runId":"<unix-seconds>","role":"builder","until":"build","kind":"<bug|story|task|improvement>"}` (`base` is what `qa.mjs` measures the diff against and what the PR targets). `kind` comes from the task type, case-insensitively (a type listed in `tasks.bugTypes` is `bug`; story, epic and feature are `story`; improvement is `improvement`; everything else is `task`); only you write it, it makes the stop gate refuse `build.done` on a bug without a recorded root cause. Right after writing it, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/run-context.mjs" set --worktree <absolute worktree path>`: the hooks learn the worktree of a dispatched agent from that pointer (a hook's `cwd` is this session's directory, never the worktree), and apply the agent's role rules only to events raised by a factory agent, so your own commands and wait loops are never judged as the builder's or reviewer's. Dispatch into one worktree at a time. Every later dispatch rewrites `role`, `until` and `axis` here and deletes `.dev-factory/stop-nudges`; the hooks read it.
3. Environment: `bash "${CLAUDE_PLUGIN_ROOT}/scripts/e2e-env.sh" up --worktree <worktree> --key <KEY> --ports canonical` (`--ports canonical` whenever `caps.maxConcurrent` is 1, which is what lets the host browser reach the stack; `--device` instead when the task is mobile and `mobile.appDir` is set: a `mobile.hints` entry appears in the labels or description). Exit 75: undo the claim (SET the task back to `ready`), COMMENT `environment busy, retrying next pass`, continue. With `environment.type` `none` there is nothing to start and this step only records that. Other failure: section 6 with the script's output. Comment `environment done`.
4. Prepare (only when it applies; otherwise skip to the build).

    - Triage: when `kind` is `bug`, or the description links a Sentry task (`sentry.io/issues/`) or an Axiom query, dispatch the `factory-debugger` agent with trigger `triage` before any build. Environment: the task's `env:<name>` label, else the Sentry issue's environment tag, else the first non-`dev` name in `environments`, else `dev`. Telemetry is optional: when neither the Sentry nor the Axiom MCP server is enabled, the debugger works from the task text and a reproduction. Set run.json `role` `debugger`, `debugBefore` to `recordedAll` from `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" debug status --worktree <worktree>`, pass the key, task text, environment, links and worktree, and wait:

        ```bash
        W=<worktree>/.dev-factory; B=<debugBefore>; end=$((SECONDS+540))
        until [ -f $W/blocked.json ] || [ "$(grep -l '"status": "recorded"' $W/debug/*.json 2>/dev/null | wc -l)" -gt "$B" ] || [ $SECONDS -ge $end ]; do sleep 5; done
        [ -f $W/blocked.json ] || [ "$(grep -l '"status": "recorded"' $W/debug/*.json 2>/dev/null | wc -l)" -gt "$B" ] && echo DONE || echo STILL_WAITING
        ```

        Same stall rule as the build wait. `blocked.json` goes to section 6 (a bug with no reproduction and no telemetry signal is blocked with `needs reproduction`). On a recorded round, comment `prepare done` and set `role` back to `builder`; the builder starts from `.dev-factory/debug/*.json`.

    - Research: a ticket labelled `needs-research` or whose description holds a `Research:` block gets one dispatch of the `factory-researcher` agent first. Set `role` `researcher` in run.json, dispatch it with the key, the questions and the worktree, and wait with the same foreground loop over `<worktree>/docs/plans/<KEY>/research.md` or `blocked.json`. Commit the file (`Add research notes [<KEY>]`, no trailer), comment `prepare done`, then set `role` back to `builder`. A researcher block goes to section 6.

5. Build: first write the task text to a temp file and run `node "${CLAUDE_PLUGIN_ROOT}/scripts/run-record.mjs" preload --text-file <file>`; its output (at most five short lines of recent learnings that match the paths the ticket mentions) goes into the prompt. Dispatch the `factory-builder` agent (Agent tool) with the key, worktree, branch, task text, acceptance criteria, those learnings, any fix-pass comments, and `.dev-factory/env.json`, telling it to do the environment, implement and qa phases only. The Agent tool returns at once, so wait with a foreground loop, re-issued until it prints DONE (never end your turn to wait):

    ```bash
    W=<worktree>/.dev-factory; end=$((SECONDS+540))
    until [ -f $W/build.done ] || [ -f $W/blocked.json ] || [ $SECONDS -ge $end ]; do sleep 5; done
    [ -f $W/build.done ] || [ -f $W/blocked.json ] && echo DONE || echo STILL_WAITING
    ```

    On STILL_WAITING check for progress (`git -C <worktree> log -1 --format=%cr`, new files under `.dev-factory/`); no progress for `caps.stallMinutes` means treat it as blocked. If `.dev-factory/needs_debug.json` appears instead (the builder hit its fix budget on a bug ticket), unstick it: check `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" debug status --worktree <worktree>` for budget left; none left means section 6 with reason `debug budget spent`. Otherwise set `role` `debugger`, `debugBefore` as above, dispatch `factory-debugger` with trigger `unstick` and the contents of `needs_debug.json`, wait as in the triage loop, then delete `needs_debug.json` and `build.done`, set `role` `builder`, and re-dispatch the builder with the new root-cause record and the instruction to continue from it. A `blocked.json` from the debugger (a repeated fingerprint or spent budget) goes to section 6. Comment `build done` and `qa done` once the builder finishes.

6. Review, two steps, up to `caps.maxFixRounds` fix rounds. Round `r` starts at 1:
    1. Step 1: set `role` to `reviewer` and `axis` to `spec` in run.json, dispatch the `factory-reviewer` agent with the axis, task text, acceptance criteria, `origin/<base>`, the commit (`git -C <worktree> rev-parse HEAD`), and the previous round's findings when `r` is above 1. Wait with the same foreground loop over `<worktree>/.dev-factory/review/<HEAD>-spec.json`.
    2. If `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" review status --worktree <worktree>` shows blocking findings for `spec`, go to the fix step. Otherwise do step 2 the same way with `axis` `standards` (the recorder refuses it until step 1 is clean). After standards is clean, read `triggered` from `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" review status --worktree <worktree>` and run each triggered specialist axis (`data`, `infra`, `security`) the same way, one at a time.
    3. All required steps clean: keep the Medium and Low findings from `.dev-factory/review/*.json` for the PR body, comment `review done`, and continue to step 7.
    4. Fix step: if `r` equals `caps.maxFixRounds` plus one, go to section 6 with reason `review not clean after <n> rounds` and the open findings. Otherwise set `role` `builder`, `until` `build`, delete `build.done`, dispatch the `factory-builder` agent with the open Critical and High findings (file, line, note) and the instruction to fix, commit and run QA again from `start`. Wait for `build.done` as in step 5, increment `r`, return to step 6.1.
7. Ship: set `role` `builder`, `until` `ship`, dispatch the `factory-builder` agent for the ship phase only, passing the Medium and Low findings for the PR body, and wait with the same loop over `ship.done` or `blocked.json`. Comment `ship done`.

## 5. Post-run and advancing finished work

For each worktree whose builder finished:

-   `.dev-factory/blocked.json`: section 6 with its reason and decision.
-   `.dev-factory/ship.done`: read the PR from GitHub (`gh pr list --head <branch> --json number,url,headRefOid,isDraft`). Require exactly one PR. Read `gh pr view <N> --json mergeable,mergeStateStatus`: `CONFLICTING` means the base moved under the PR, so treat it as a fix item (label nothing, comment `[dev-factory] base moved: merge conflict`, SET the task back to `ready`) instead of continuing. Then `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" verify --head <headRefOid> --key <KEY> --require-review true --worktree <worktree>` (`--key` finds the QA run made at that head, or the not-applicable record; never pass the PR number as a run); the PR head, the QA head and both review records must be the same commit. Both must pass. Then LINK the task (`skills/task-source`): the branch (`--branch <branch>`, which becomes its GitHub URL), the PR URL, the QA verdict from `verify`, and the images in `<worktree>/.dev-factory/evidence/<KEY>/run-<N>/` as the evidence. Then COMMENT on the task: PR URL, QA verdict and run, evidence list; SET it `inReview`; COMMENT `review started`. Failure of either: section 6.
-   Index the ticket's learnings for later builds: `node "${CLAUDE_PLUGIN_ROOT}/scripts/run-record.mjs" learnings --worktree <worktree> --key <KEY>` (skip when `.dev-factory/learnings.md` does not exist).
-   Record the run for the weekly improvement scan, then tear down: `node "${CLAUDE_PLUGIN_ROOT}/scripts/run-record.mjs" ticket --worktree <worktree> --env <environment>`. Post a short COMMENT `[dev-factory] run: outcome=<outcome> review_rounds=<n> qa_attempts=<n> debug_rounds=<n>` (counts only, after the scrub rule below) so the record survives the machine. Do the same for a blocked ticket in section 6. Finally tear everything down for the next run, whatever the outcome: `node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanup.mjs" --worktree <worktree>` stops the ticket stack, the dev server, the simulator this run booted, and any Playwright or Maestro session left open, and frees the ports lock. Read its JSON: a `left` entry means something outside the run holds a port or session; with `cleanup.takeover` on it would have been stopped, so say in the ticket comment which one and why it stayed.

Independently, for every labelled task `inReview` (LIST): find its PR (`gh pr list --state all --search "<KEY> in:title" --json number`) and read `gh pr view <N> --json state,reviewDecision,author,commits,reviews,comments`.

Read the settings once: `pr.reviewedOnMergeInto`, `pr.doneOnMergeInto`, `review.bugbot`, `review.bugbotAuthor`, `review.bugbotComment`, `caps.maxBugbotRounds`.

-   Reviewed: with `pr.reviewedOnMergeInto` unset, the PR is merged or `reviewDecision` is APPROVED. With it set, only a merge counts, and only one whose `baseRefName` equals it (an approval, or a merge into another branch, leaves the task `inReview`). SET it `reviewed` and COMMENT `[dev-factory] phase: review passed pr=<url>`. If the source refuses the move, comment and leave it `inReview`.
-   Done: when `pr.doneOnMergeInto` is set, also LIST `reviewed` tasks. A task is done when its PR merged into that branch, or when the merge commit has reached it (`gh pr view <N> --json mergeCommit,baseRefName`, then `gh api repos/{owner}/{repo}/compare/<doneBranch>...<oid> --jq .status` is `behind` or `identical`; a release that squashes its commits cannot be seen this way, so a person moves that task). SET it `done` and COMMENT `[dev-factory] phase: done pr=<url> branch=<doneBranch>`. With it unset, `done` stays a person's move.
-   A fix request, any of these, newer than the PR's latest commit: a `CHANGES_REQUESTED` review by someone other than the PR author; a PR or task comment by a person (not a `[bot]`) with a line starting `tasks.fixComment` (default `dev-factory fix`, no slash needed; a leading `/` is also read) and the rest of the line or comment as the instruction; or, when `review.bugbot` is true, an unresolved review thread opened by `review.bugbotAuthor`. A plain comment, a question, CI or an approval is not a request. This is a fix pass: SET it `inProgress`, COMMENT `[dev-factory] phase: fix started`, and continue at section 4 for it in this same pass (fix pass hygiene in section 3 applies, and the review threads and the fix comment's instruction go into the builder prompt). When it ships, section 5 moves it back to `inReview`.
-   PR closed without merge: section 6 with reason `PR closed unmerged`.

### Bugbot (only when `review.bugbot` is true)

After a PR is opened or a fix is pushed, `skills/ship` has posted the `review.bugbotComment` comment (default `bugbot run`), which starts the review. Then, for each `inReview` task:

1. Watch: the review is finished when the `Cursor Bugbot` check on the head commit is no longer pending (`gh pr checks <N>`); keep to the pass, never wait more than a few minutes, and pick it up next pass if it is still running.
2. Read its unresolved threads (`gh api graphql` with a `reviewThreads` query, each thread's id, path, line and first comment, by `review.bugbotAuthor`). None: COMMENT `[dev-factory] phase: bugbot clean` and go on.
3. Some: count the earlier `[dev-factory] phase: bugbot fix` comments; at `caps.maxBugbotRounds` go to section 6 with reason `bugbot not clean after <n> rounds`. Otherwise COMMENT `[dev-factory] phase: bugbot fix round=<n>` and run a fix pass (as above) with the threads verbatim; if a finding needs diagnosis (a bug, a failing behaviour), the builder debugs it as in section 4 step 5 first.
4. When the fix has shipped (section 4 step 7 posts the Bugbot comment again), resolve each thread the commit answered: `gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:"<id>"}){thread{isResolved}}}'`. Resolve only threads the fix actually addressed; leave one that was disputed or not fixed, and say why in the task comment. The next pass reads Bugbot's new findings.

After `reviewed`, QA, UAT and release belong to people. A task whose state is in `done` counts as done for the factory (blockers resolved, validation eligible). A person may park a task at any stage by adding `tasks.blockedLabel` or moving it to a status the factory does not know: leave it alone. A task a person moves back to `ready`, or comments `tasks.fixComment` on, is a fix pass as before.
The Notion upload in LINK is the scheduler's own `curl` (see `skills/task-source/notion.md`); the guard allows that one shape.

## 5b. Validation of merged work

Only when a telemetry MCP server (Sentry or Axiom) is enabled and configured under `environments`; otherwise skip this section. For tasks that merged at least `validation.minHoursAfterMerge` (default 24) hours ago and are not yet validated (LIST `done` without the labels `factory-validated` or `factory-regression`, updated in the last 30 days): only tasks whose phase comments show a debug triage (a bug or a telemetry-linked task) are validated; skip the rest silently. At most one per pass.

For one task: `git worktree add --detach <worktrees>/validate-<KEY> origin/<base>` (`node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree.mjs" default-branch`), write its run.json `{"key","role":"debugger","kind":"bug","debugBefore":<recordedAll>}`, dispatch `factory-debugger` with trigger `validate`, the triage evidence from the task's phase comments, and the window since the release containing the merge (the release tag or label the task carries; without one, since the merge time). It reruns the triage evidence queries (Sentry events and users since the release, the Axiom signature count) and reports before and after as aggregates. Wait as in the triage loop. Then post one COMMENT with the counts, after the scrub rule below. Zero or falling: add the label `factory-validated`. Same or rising: add `factory-regression` and say so in the comment; never reopen the task automatically. Remove the worktree afterwards.

## Scrub rule (every task comment and PR body)

Write each comment or PR body to a temp file and run `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" scrub --file <file>` before posting it. A failure means raw data slipped in: replace it with ids, queries and aggregate counts and run it again. Never post a text that has not passed. The same applies to the run-record comment.

## 6. Blocked path

BLOCK the task (the label keeps it out of the queue until a person removes it) and tear down its environment. Never retry on your own.

## 7. Exit

Print one line: `tick: claimed=<n> resumed=<n> shipped=<n> blocked=<n> merged=<n> skipped=<n>`. End the turn. Do not schedule a wakeup; the scheduler runs the next pass.
