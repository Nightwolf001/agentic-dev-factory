---
name: ship
description: Push the ticket branch and open a draft PR that satisfies the repository's PR rules, with QA evidence and screenshots attached on every run type. Use after QA passes.
---

# Ship

Quick runs (`run.json` has `"quick": true`, started by `/dev-factory:quick`): there is no task, so leave out the task link, and the key in the title and branch is the placeholder `tasks.placeholderKey` (or the key already in the branch). When `run.json` has a `pr` number the PR already exists: skip steps 4 to 6, do step 3 with a plain `git push origin <branch>` (the base was merged in, never rebased, so no force is needed), do step 7 (evidence is never skipped), and write `.dev-factory/ship.done` with that PR's URL and the pushed head. Do not edit the PR title, body or labels; the step 7 comment is the only thing posted to the PR.

Read the live rules, never rely on memory: any branch, title or label checks in the repository's workflows under `.github/workflows`, plus `.github/PULL_REQUEST_TEMPLATE.md` and any pull-request standards the repository keeps (`CLAUDE.md`, `AGENTS.md`, rule files). Where the repository states none, the conventions below are the defaults.

1. Branch name `<type>/<KEY>-<slug>` where type is one of the workflow's allowed prefixes (the values of `git.branchTypes` otherwise). Validate it against the workflow's pattern, if there is one, before pushing.
2. Precondition: `node dev-factory/bin/qa.mjs review status` shows `clean: true` at the current head (both review steps recorded with no Critical or High findings). If not, stop: the scheduler runs review before you ship. Final gates: full affected suites where the environment runs them (see `implement`), `git status` clean, `node dev-factory/bin/qa.mjs verify --head $(git rev-parse HEAD) --key KEY --require-review true` exits 0 (it finds the QA run made at that head, or the not-applicable record). Any commit after QA means QA runs again.
3. `git push -u origin <branch>`. Only the ticket branch; the guard refuses anything else.
4. Title: `Type: short description [KEY]`. It starts with a capital and ends with the task key in square brackets. Types: Feat, Fix, Docs, Refactor, Chore, Test.
5. Body: fill the PR template from the real diff. Include a link to the task when the source has one (`gh issue view <n> --json url`, the Notion page URL, or the Jira browse URL; a local task has none), testing actually performed, the QA run number and verdict, a Review section: two steps (spec, then standards) by separate fresh-context reviewers at this commit, the counts from `qa.mjs review status`, and every Medium and Low finding the prompt passed you (file, line, note). If `.dev-factory/debug/*.json` holds a recorded round, add a Root cause section (the sentence, the evidence refs as ids and aggregate counts only) and a Validation plan section (what Sentry or Axiom aggregate should change after the merge and when it is checked). Before opening, run `node dev-factory/bin/qa.mjs scrub --file <body file>`; it must pass. State plainly that these reviewers are the same model family as the builder and that a human review is still required, and any `Unverified:` assumptions with their sources.
6. Open: `gh pr create --draft --base <base> --head <branch> --title "..." --body-file <file> --label <size> --label <area> --label <category>`.
   `<base>` is `base` in `.dev-factory/run.json` (`git.baseBranch`, else the repository's default branch, when it is absent: `node dev-factory/scripts/worktree.mjs default-branch`): a run started on another branch opens its PR into that branch, and the size label counts the diff against it (`git diff origin/<base>...HEAD --shortstat`). Labels: size from `pr.sizeLabels` (each name with its upper bound in changed lines; `null` is unbounded); area from `pr.areaLabels` (path prefix to label; none by default); category from the branch type through `pr.categoryByBranchType`. Confirm each label exists with `gh label list`; if one does not, put the recommendation in the body instead.
7. Evidence, on every ship, whatever started the run: a ticket build, a scheduled tick, a fix pass, `/dev-factory:quick` (new change or `--pr`). Take the QA run at this head (`qa.mjs verify` names it) and its images in `.dev-factory/evidence/<KEY>/run-N/`.
    - Screenshots exist: attach every one, with the case slug as alt text. A new PR attaches them in the body (`gh pr create --attach './file.png#alt'`, with `![alt](./file.png)` references in the body). A PR that already exists (`--pr`, a fix pass) gets one follow-up comment: `gh pr comment <N> --body-file <file> --attach './file.png#alt'`. The comment states the QA run number and verdict, one line per case with the assertion recorded, and the images. Run `node dev-factory/bin/qa.mjs scrub --file <file>` on it first; it must pass. Needs gh 2.99 or newer (check `gh --version`); if attach is unavailable, list the files and run number in the body or comment and say so.
    - No screenshots because the QA record is not-applicable (no user-visible change), or the case was an API or worker check: say which in one line in the body or comment. Never skip silently.
    - Never commit evidence images. This comment is authorised for every run type; posting anything else, resolving threads, marking ready or merging still is not.
8. Learnings: write what a later ticket would trip over to `.dev-factory/learnings.md`, never as a file in the repository. At most 3 entries, each one or two sentences (300 characters at most) followed by an indented `scope:` line naming the path prefix it concerns (`.` for the whole repository):

    ```
    ## Learnings
    - <the lesson, concrete enough to act on>
      scope: src/worker
    ```

    Ids and aggregate counts only, never raw data. It is mandatory when a debug round happened or a review round found a Critical or High finding; `node dev-factory/bin/qa.mjs learnings check --key <KEY>` says whether it is required and checks the format. Copy the section into the PR body under `## Learnings` and run `node dev-factory/bin/qa.mjs learnings check --key <KEY> --body-file <body file>`; it must pass. Skip the file only when the check says it is not required and there is nothing real to record.

9. Write `.dev-factory/ship.done` containing the PR URL, the verified head and an `evidence:` line (`attached <n>`, or `none: <reason>`), then give the final summary. Do not write it before step 7 is done.
