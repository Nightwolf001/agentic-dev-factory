---
description: Run a small change through the factory with no Jira ticket, or fix the review comments on an open PR (usage /dev-factory:quick "<change>" [--base <branch>] or /dev-factory:quick --pr 1234 ["<extra instruction>"])
argument-hint: '"<change>" [--base <branch>] | --pr <number> ["<extra instruction>"]'
---

Run one small change through the factory in this session, visibly, without Jira. Same worktree, environment, test-first build, QA walk and two-step review as `/dev-factory:build`; only the ticket is missing.

Arguments: $ARGUMENTS. Two forms:

-   New change: a description, optionally `--base <branch>` to build on a branch you have pushed instead of `develop` (the PR then targets it). The branch and PR title carry the placeholder key `PLAT-000`, because CI requires a Jira key in both (the repository already uses it for housekeeping PRs).
-   `--pr <number>` with an optional instruction: fix the review feedback on that open PR and push to its branch. No new PR is opened.

If a new change is larger than one demoable slice (several areas, a schema or API contract change, needs a design decision), say so and suggest `/dev-factory:plan`; do not start.

## 1. Frame it

New change: write 2 to 5 checkable acceptance criteria and one Out of scope bullet from the request, show them, and continue unless the person objects. Write them to a temp file and run `node dev-factory/bin/qa.mjs ticket lint --file <file>`.

`--pr`:

1. `gh pr view <N> --json state,headRefName,baseRefName,isCrossRepository,author,url,title`. Stop if it is not OPEN, comes from a fork, or the head branch is `develop`, `preprod`, `main` or `master`. If the PR author is not the person running this (`gh api user --jq .login`), ask before going on: this pushes to their branch.
2. Read the feedback verbatim and keep only what is still open: unresolved, non-outdated review threads (`gh api graphql` over `pullRequest.reviewThreads { isResolved isOutdated comments { path line body author { login } } }`), plus `gh pr view <N> --json reviews,comments` for change requests. Bot comments count; the person asked for this run.
3. Show the person the numbered list plus their extra instruction and let them drop items. The remaining list is the acceptance criteria: one checkable bullet per item.

## 2. Branch and worktree

New change: `type` is one of `fix`, `feature`, `improvement`, `task`, `refactor`, `docs`; `slug` is up to 6 lowercase words. Branch `<type>/PLAT-000-<slug>`, checked against the regex in `.github/workflows/ci_system.yml`. `node dev-factory/scripts/worktree.mjs add --branch <branch> --path ../.worktrees/quick-<slug> [--base <name>]` (it branches off `origin/<base>`, default `develop`, and keeps `.dev-factory/` out of git; exit 2 or 3 means the base is unknown, not on origin, or behind your local copy: tell the person to push it and stop).

`--pr`: `node dev-factory/scripts/worktree.mjs attach --branch <head> --path ../.worktrees/pr-<N>`, then `git -C <worktree> merge --no-edit origin/<base>` (the PR's own base). A conflict is not resolved here: `git merge --abort`, report the conflicting files, and stop.

KEY is `PLAT-000`, or for `--pr` the Jira key in the branch name (`[A-Za-z]+-[0-9]+`) when it has one. Do not `cd` into the worktree: run every command from this session's directory and pass `--worktree <absolute worktree path>` to `qa.mjs` and `e2e-env.sh` (a worktree cut from a base that lacks the plugin has no `dev-factory/` folder to run them from).

## 3. Run it

1. Write `.dev-factory/run.json`: `{"key","branch","base":"<name>","startedAt","mode":"interactive","quick":true,"pr":<N or null>,"kind":"task","role":"builder","until":"build"}`, `base` is the branch the worktree was cut from (for `--pr`, the PR's `baseRefName`). Then `node dev-factory/scripts/run-context.mjs set --worktree <absolute worktree path>`.
2. `bash dev-factory/scripts/e2e-env.sh up --worktree <worktree> --key <KEY> --ports canonical` (exit 75: retry later; `--device` for a mobile change).
3. Dispatch `factory-builder` with the key, worktree, branch, the criteria, any open PR feedback verbatim, and `.dev-factory/env.json`; environment, implement and qa phases only. Say that QA cases for a `PLAT-000` run go under `dev-factory/qa/cases/PLAT-000/` and that anything already in that directory must be replaced by this run's cases, because `qa.mjs start` walks every case in it. Wait for `.dev-factory/build.done` or `blocked.json`.
4. Review in two steps with fix rounds up to `caps.maxFixRounds`, exactly as `commands/build.md` step 5b. Show the findings after each step.
5. Write `until` `ship` and dispatch the builder for the ship phase. It follows the Quick runs section of `skills/ship`: a new change opens a draft PR with the evidence attached, `--pr` pushes and posts one evidence comment with the screenshots. Wait for `.dev-factory/ship.done` or `blocked.json`.

## 4. Report

Read the result from files and GitHub, not the builder's narrative: `ship.done` or `blocked.json`, `gh pr view <branch> --json url,headRefOid,state`, and `node dev-factory/bin/qa.mjs verify --head <headRefOid> --key <KEY> --require-review true --worktree <worktree>`.

Tell the person the PR URL, the QA verdict, blockers, and for `--pr` which feedback items were fixed, with the commit. The evidence comment (QA run, verdict, screenshots) is already on the PR from the ship phase; confirm it landed (`gh pr view <N> --json comments`) and report the link. Offer to post the fixed-items summary as one more PR comment (scrub it first with `node dev-factory/bin/qa.mjs scrub --file <file>`); never post anything else, resolve threads, mark ready or merge on your own. Jira is never touched.

Finally `bash dev-factory/scripts/e2e-env.sh down --worktree <worktree>`.
