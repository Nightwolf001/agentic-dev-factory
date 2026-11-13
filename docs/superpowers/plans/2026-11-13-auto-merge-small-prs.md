# Auto-merge for Small, Labelled PRs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the scheduled pass merge a factory PR on its own when the project has `autoMerge.enabled` on and either the change is small or the task carries the auto-merge label (a labelled task merges whatever its size); every other PR is still merged by a person.

**Architecture:** One pure decision function (`scripts/automerge-lib.mjs`) judges a PR from facts it is handed, and a small CLI (`scripts/automerge.mjs`) gathers those facts with `gh`/`qa.mjs`, acts, and prints a JSON verdict. The tick calls the CLI for each `inReview` task. The shell guard keeps `gh pr merge` and `gh pr ready` denied for everyone; only the CLI (which the guard refuses to every factory role) may do either, so every condition is enforced in tested code and not in a prompt. Because the factory opens draft PRs and GitHub reports a draft as `DRAFT` (never `CLEAN`), it works in two passes: pass one marks the PR ready, pass two (next tick) merges once GitHub says `CLEAN`.

**Tech Stack:** Node ESM, `node:test`, `gh` CLI, bash 3.2 untouched.

**Spec:** none separate. The request is the spec, revised once: first _"auto merge PRs if the task change is 'small', the task has an auto-merge label, and the project has an autoMerge setting turned on"_, then _"the criteria is too strict: agents can merge if the PR is small, or if the label exists on the task regardless of the size of the PR; stacks can be merged; PRs with agent decisions can be merged."_ The decisions under "Decisions" below fill the remaining gaps and are the part to review.

## Decisions (read these first)

-   **"A person merges" is relaxed, not removed.** `docs/reference.md` says this rule lives in plugin code so a repository's file cannot loosen it. The setting is still safe: `.devfactory/config.json` is owner-only (the edit guard refuses it to every factory run, `scripts/guard-lib.mjs:1015`), so a ticket cannot switch it on. The docs sentence is reworded to say exactly that.
-   **The rule: `autoMerge.enabled` AND (small OR labelled).** `autoMerge.enabled` is the master switch (off by default). With it on, a PR is eligible when it is small, or when its task carries `autoMerge.label` (case-insensitive), whatever its size. Consequence to be aware of: with the switch on, every small PR merges itself, label or not; the label is the engineer's authorisation for a task that is bigger than small, and it is not needed for a small one. (If you want small PRs to need the label too, that is one `&&` in `decide`.)
-   **Size is measured, not trusted.** "Small" is the PR's real `additions + deletions` from `gh pr view`, compared with `pr.sizeLabels[autoMerge.maxSize]` (default bucket `small`, 100 lines). The size label on the PR is not read: anyone can relabel it. A labelled task skips the size test.
-   **Stacked PRs and PRs with agent decisions are allowed, and said out loud.** A stacked PR merges into its blocker's branch like any other (the tick's existing retarget and Reviewed/Done rules for stacks are untouched and run first). A PR whose body has "Decisions made without a person" merges too. Because no person reads these first, the tick's merge comment carries `decide`'s `notes` (`stacked on PR #M`, `carries decisions made without a person`) so they are visible afterwards.
-   **Fixed safety gates** (not settings: a setting for each would be a way to loosen them): PR open; not an `ai-tooling/` branch (the factory's own changes always get a person); QA verify and both review steps clean at the PR head; no specialist review axis (data, infra, security) triggered; no `CHANGES_REQUESTED`; task not parked (`tasks.blockedLabel`, `tasks.questionLabel`); Bugbot (when `review.bugbot` is on) has no unresolved thread and no pending check; GitHub says `mergeStateStatus` is `CLEAN` (so branch protection, required checks and required approvals are honoured: a repo that requires an approval never auto-merges).
-   **Never forced.** No `--admin`, no `--auto`. The merge passes `--match-head-commit <head>` so a push after the check cannot be merged unreviewed.
-   **A person can always stop it.** Turning `autoMerge.enabled` off, adding `tasks.blockedLabel` to the task, or making the PR a draft again after pass one all work: the PR is not re-readied for the same head. (Removing the label stops a large PR but not a small one, by the rule above.)
-   **Out of scope (note as follow-ups):** `/dev-factory:plan` adding the label for you; a cap on merges per pass (`caps.maxOpenPrs` already bounds it); GitHub's native `--auto` queue.

## Global Constraints

-   `node --test test/*.test.mjs`, `npx prettier@3.2.5 --check "**/*.{md,json,mjs}"`, `bash scripts/lint-vocabulary.sh` and `claude plugin validate .` pass after every task. Do not run `npm install` on the host.
-   The factory is running real tasks on this machine while this is built, so nothing here may alter it: edit only inside this worktree; never touch `~/.dev-factory`, `~/.claude`, `~/.claude.json`, the installed plugin, launchd, the main checkout or any port or process; run no `npx`, `gh`, `claude` or `docker` command. Every test, format check and lint runs through a hermetic wrapper that writes only to a scratch folder, has no network, cannot signal another process and starts with an empty environment. The tests that need ports, processes, docker or the network are expected to fail there; a change is judged by failures that are not in that saved baseline.
-   Scripts run on plain Node with no dependencies and as `node "${CLAUDE_PLUGIN_ROOT}/scripts/..."`; nothing may hard-code a `dev-factory/` path (`test/packaging.test.mjs`).
-   Nothing names a company, tracker site, project key or host. Explain rules by their reason (`lint-vocabulary.sh`).
-   A new setting goes in `config.json`, `scripts/config.mjs` (validation), `settings/options.json` and the table in `docs/reference.md`.
-   A behavioural change to `scripts/guard-lib.mjs` or `scripts/config.mjs`, and the new `scripts/automerge-lib.mjs` / `scripts/automerge.mjs`, each need a test in `test/`.
-   Version: new backwards-compatible setting and behaviour is a **minor**: `0.18.3` → `0.19.0` in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` together.
-   Commits and PR text carry the attribution lines the session specifies; branch off `main`, never commit to it, open a draft PR.

## Review Focus

Inputs the request implies but no obvious test would cover; each has a test in the task that owns the code.

1. Label spelled `Auto-Merge`, `auto-merge` or with other labels around it: it must count (case-insensitive, trimmed). A large PR with the label merges; a large PR without it waits for a person. _(Task 2)_
2. Size boundary without the label: exactly the bound is eligible, bound + 1 is not (it is left for a person, not refused); a PR with 0 changed lines (empty, or `additions`/`deletions` missing) is refused even with the label. _(Task 2)_
3. The head moves between the check and the merge, or `gh` fails midway: nothing is merged unreviewed and no state is changed on an unknown (`--match-head-commit`, exit 21). _(Task 3)_
4. The repository requires an approval or a check is red/pending (`BLOCKED`, `UNSTABLE`, `BEHIND`): wait quietly, never force, never `--admin`. _(Task 2, Task 3)_
5. A person re-drafts the PR after it was marked ready, or adds `tasks.blockedLabel`: respected on the next pass. _(Task 2)_

---

### Task 1: The settings

**Files:**

-   Modify: `config.json` (new top-level `autoMerge` block after `pr`)
-   Modify: `scripts/config.mjs` (in `validate`, next to the `pr.*` checks near line 380)
-   Modify: `settings/options.json` (four entries in group `Git and pull requests`, `scopeHint: "project"`)
-   Test: `test/config.test.mjs`, `test/settings-catalog.test.mjs` (existing, must still pass)

**Interfaces:**

-   Produces: `get('autoMerge.enabled')` boolean (default `false`); `autoMerge.label` string (`"auto-merge"`); `autoMerge.maxSize` string naming a key of `pr.sizeLabels` (`"small"`); `autoMerge.method` one of `squash`, `merge`, `rebase` (`"squash"`).

-   [ ] **Step 1: Write the failing tests** in `test/config.test.mjs`, using its existing `withSetting(key, value)` helper:

    ```js
    test('autoMerge defaults to off, the auto-merge label, the small bucket and squash', () => {
    	const c = load();
    	assert.deepEqual(c.autoMerge, { enabled: false, label: 'auto-merge', maxSize: 'small', method: 'squash' });
    	assert.deepEqual(validate(c), []);
    });
    test('autoMerge settings are validated', () => {
    	assert.ok(withSetting('autoMerge.enabled', 'yes').some((p) => /autoMerge\.enabled must be true or false/.test(p)));
    	assert.ok(withSetting('autoMerge.method', 'fast-forward').some((p) => /autoMerge\.method must be one of squash, merge, rebase/.test(p)));
    	assert.ok(withSetting('autoMerge.maxSize', 'huge').some((p) => /autoMerge\.maxSize must name a pr\.sizeLabels bucket/.test(p)));
    	assert.ok(
    		withSetting('autoMerge.maxSize', 'large').some((p) => /needs a line bound/.test(p)),
    		'the unbounded bucket is refused',
    	);
    	for (const bad of ['', 'dev-factory', 'factory-blocked', 'factory-question'])
    		assert.ok(
    			withSetting('autoMerge.label', bad).some((p) => /autoMerge\.label must be a label name/.test(p)),
    			bad,
    		);
    });
    ```

-   [ ] **Step 2: Run** `node --test test/config.test.mjs` → FAIL (`c.autoMerge` undefined).
-   [ ] **Step 3: Add the block to `config.json`** (`"autoMerge": { "enabled": false, "label": "auto-merge", "maxSize": "small", "method": "squash" }`) and the checks to `validate()` with the exact messages the tests match. `label` must be a non-empty string differing from `tasks.label`, `tasks.blockedLabel` and `tasks.questionLabel` (the same shape as the existing `tasks.questionLabel` check). `maxSize` must be a key of `pr.sizeLabels` whose value is a number.
-   [ ] **Step 4: Add the four `autoMerge.*` entries to `settings/options.json`** (titles: "Auto-merge small PRs", "Auto-merge task label", "Largest PR size that auto-merges", "Auto-merge method"; types `boolean`, `string`, `string`, `string`). Group stays `Git and pull requests`, so the group count the catalogue test asserts (15) does not change.
-   [ ] **Step 5: Run** `node --test test/config.test.mjs test/settings-catalog.test.mjs test/settings.test.mjs` → PASS.
-   [ ] **Step 6: Commit** `feat: add the autoMerge settings`.

---

### Task 2: The decision function

**Files:**

-   Create: `scripts/automerge-lib.mjs`
-   Test: `test/automerge.test.mjs`

**Interfaces:**

-   Consumes: the config shape from Task 1.
-   Produces:

    -   `changedLines(pr: {additions?: number, deletions?: number}): number` (missing fields count as 0).
    -   `sizeBound(cfg): number` (`cfg.pr.sizeLabels[cfg.autoMerge.maxSize]`; a bound below 1, which validation does not forbid, means nothing counts as small).
    -   `decide(input): { action: 'off'|'refused'|'wait'|'ready'|'merge', via: 'small'|'label'|null, reasons: string[], notes: string[] }` where `input = { cfg, labels: string[], pr, verified: boolean, review: {clean: boolean, triggered: string[]}, bugbot: {unresolved: number, pending: boolean}, readiedHead: string|null }` and `pr = { state, isDraft, headRefOid, headRefName, mergeStateStatus, reviewDecision, additions, deletions, body }` (the fields of `gh pr view --json`).
    -   `mergeArgs({ pr: number, head: string, method: string }): string[]` → `['pr','merge','<n>','--<method>','--match-head-commit','<head>']` and nothing else.
    -   `EXIT = { DONE: 0, WAIT: 10, REFUSED: 11, OFF: 12, UNKNOWN: 21 }`.

    Action rules (first match wins): `off` when `autoMerge.enabled` is not `true`, or the PR is neither small (changed lines at or below the bound, 0 included, so an empty PR reaches the refusal below instead of being ignored) nor on a labelled task (`labels` has `autoMerge.label`, case-insensitive, trimmed), with `via: null`, `reasons: []` (an over-size PR without the label is a PR for a person, not a refusal). Otherwise `via` is `'label'` when the label is present, else `'small'` (the label wins when both hold). `refused` (a permanent reason, one string each, all collected): changed lines `0`; PR not `OPEN`; `headRefName` starts `ai-tooling/`; `!verified`; `!review.clean`; `review.triggered.length > 0`; `reviewDecision === 'CHANGES_REQUESTED'`; `labels` includes `tasks.blockedLabel` or `tasks.questionLabel`; `mergeStateStatus` is `DIRTY`; a draft whose `readiedHead === headRefOid` (a person drafted it again). Otherwise `wait` (a transient reason): `bugbot.pending`, `bugbot.unresolved > 0`, and for a non-draft PR any `mergeStateStatus` other than `CLEAN`. Otherwise `ready` when `isDraft`, else `merge`. `notes` is set whenever the action is `ready` or `merge`: `stacked on PR #<M>` when the body has that line, `carries decisions made without a person` when it has that section, `labelled task, <n> changed lines` when `via` is `label` and the PR is over the bound; it never changes the action.

-   [ ] **Step 1: Write the failing tests** in `test/automerge.test.mjs` (`import './isolate-state.mjs'` first, like the other tests). A `base()` fixture returns an all-eligible, non-draft, `CLEAN`, 40-line PR with the default config and `enabled: true`. Tests, each asserting `decide(...).action` and the reason text:

    -   `off` when disabled (even labelled and small); a small PR with no label → `merge` with `via: 'small'`; a 5,000-line PR with no label → `off`; the same PR with labels `['Auto-Merge']` and `[' auto-merge ', 'x']` → `merge` with `via: 'label'` (Review Focus 1); `blockedLabel` or `questionLabel` among the labels → `refused`.
    -   Size without the label: 100 lines → `merge`; 101 → `off`; `additions: 0, deletions: 0` and `{}` → `refused` with `/no changed lines/`, with and without the label (Review Focus 2); the bound follows `autoMerge.maxSize: 'medium'` (500).
    -   Allowed, with `notes`: a body with the line `stacked on PR #5 (branch \`task/APP-1-x\`)`→`merge`and`notes`contains`stacked on PR #5`; a body with `## Decisions made without a person`→`merge`and`notes`contains`carries decisions made without a person`; a PR with neither has `notes: []`.
    -   One test per permanent gate (not open, `ai-tooling/x` branch, not verified, review not clean, `triggered: ['security']`, `CHANGES_REQUESTED`, `DIRTY`), each `refused`; and one test that several failures list all their reasons.
    -   `wait`, no reasons mentioning refusal: `mergeStateStatus` `BLOCKED`, `UNSTABLE`, `BEHIND`, `UNKNOWN`; `bugbot: {unresolved: 1}`; `bugbot: {pending: true}` (Review Focus 4). A repository that needs an approval stays `BLOCKED` and so never merges.
    -   Draft: all-eligible draft with `readiedHead: null` → `ready`; the same draft with `readiedHead` equal to its head → `refused` with `/made a draft again/`; with `readiedHead` of an older commit → `ready` (Review Focus 5).
    -   `mergeArgs({pr: 7, head: 'abc', method: 'squash'})` deep-equals `['pr','merge','7','--squash','--match-head-commit','abc']`, and no method produces `--admin` or `--auto`.

-   [ ] **Step 2: Run** `node --test test/automerge.test.mjs` → FAIL (module missing).
-   [ ] **Step 3: Implement `scripts/automerge-lib.mjs`** as the pure functions above, no I/O. Collect all refusal reasons into one array so the tick comment explains everything at once.
-   [ ] **Step 4: Run** `node --test test/automerge.test.mjs` → PASS.
-   [ ] **Step 5: Commit** `feat: decide which PRs may merge themselves`.

---

### Task 3: The CLI

**Files:**

-   Create: `scripts/automerge.mjs`
-   Modify: `settings.factory.json` (add `"node *automerge.mjs*"` to `sandbox.excludedCommands`, beside `node *open-prs.mjs*`: it runs `gh`, which needs the network and the person's credentials outside the sandbox)
-   Test: `test/automerge.test.mjs` (a second section), `test/preflight.test.mjs` or wherever `excludedCommands` is asserted, if it is

**Interfaces:**

-   Consumes: `decide`, `mergeArgs`, `EXIT` (Task 2); `qa.mjs verify` exit status and `qa.mjs review status` JSON (`{clean, triggered, ...}`, `bin/qa.mjs:734`).
-   Produces: `node scripts/automerge.mjs run --pr <N> --key <KEY> --labels <csv> --worktree <dir> [--readied-head <sha>] [--dry-run]` prints one JSON line `{"action":"off|refused|wait|ready|merged|failed","via":"small|label|null","pr":N,"head":"<sha>","lines":n,"reasons":[...],"notes":[...]}` and exits per `EXIT` (`merged` and `ready` → `0`). `export async function run(args, deps)` where `deps = { gh(argv): string, qa(argv): {status, stdout}, cfg }` so tests inject fakes.

-   [ ] **Step 1: Write the failing tests** with fake `gh`/`qa` recording argv:
    -   eligible non-draft PR → `gh` was called with exactly `mergeArgs(...)` after one `pr view`, result `merged`, exit `0` (Review Focus 3: the argv ends with `--match-head-commit <head from the view>`).
    -   eligible draft → exactly one `gh pr ready <N>` call, no merge call, result `ready`.
    -   `--dry-run` → no `ready`/`merge` call at all, still prints the action it would take.
    -   `off` and `wait` and `refused` make no write call and exit `12`, `10`, `11`.
    -   `gh pr view` throws, or the merge call throws (head moved: `gh` rejects `--match-head-commit`) → exit `21`, result `failed`, no second write (Review Focus 3).
    -   Bugbot: with `review.bugbot` true the unresolved count comes from a `gh api graphql` **query** (no `mutation`) filtered to `review.bugbotAuthor`, pending from a check whose name matches `/bugbot/i` in `statusCheckRollup`; with it false neither is asked.
    -   `verified` is `qa verify --head <headRefOid> --key <KEY> --require-review true --worktree <dir>` exiting `0`; `review` is the JSON of `qa review status --worktree <dir>`.
-   [ ] **Step 2: Run** the file → FAIL.
-   [ ] **Step 3: Implement `scripts/automerge.mjs`** following `scripts/open-prs.mjs` (`isMain` guard, `loadTrackerEnv()`, `load()`/`get()`, `execFileSync('gh', …)` as the default `deps.gh`). Fetch `gh pr view <N> --json number,state,isDraft,headRefOid,headRefName,mergeStateStatus,reviewDecision,additions,deletions,body,statusCheckRollup`. Perform at most one write per call: `gh pr ready <N>` for `ready`, `gh <mergeArgs>` for `merge`. Any thrown error → `{"action":"failed"}`, exit `21`.
-   [ ] **Step 4: Add the sandbox exclusion** and run the full suite: `node --test test/*.test.mjs` → PASS.
-   [ ] **Step 5: Commit** `feat: add the auto-merge command`.

---

### Task 4: The guard

**Files:**

-   Modify: `scripts/guard-lib.mjs` (the tracker-writer block near line 931, where `tasks.mjs` writes are refused to `FACTORY_ROLES`)
-   Test: `test/guard.test.mjs`

**Interfaces:**

-   Consumes: `evaluate(command, ctx)` as it is.
-   Produces: the shell guard refuses `node …/automerge.mjs` to every factory role (`builder`, `reviewer`, `debugger`, `researcher`, `improver`, `promoter`), and still refuses `gh pr merge` and `gh pr ready` to everyone, the scheduler's own session included.

-   [ ] **Step 1: Write the failing tests** in `test/guard.test.mjs`, using its `ctx`/`denied`/`allowed` helpers and `evaluate(cmd, { role })`:
    ```js
    test('auto-merge is the scheduler’s alone and gh pr merge stays reserved for people', () => {
    	const cmd = 'node "/p/scripts/automerge.mjs" run --pr 7 --key APP-1 --labels auto-merge --worktree /w';
    	for (const role of ['builder', 'reviewer', 'debugger', 'researcher', 'improver', 'promoter'])
    		assert.equal(evaluate(cmd, { role }).deny, true, role);
    	assert.equal(evaluate(cmd, {}).deny, false, 'the scheduler session has no role');
    	assert.equal(evaluate('gh pr merge 7 --squash', {}).deny, true);
    	assert.equal(evaluate('gh pr ready 7', {}).deny, true);
    	assert.equal(evaluate('gh pr merge 7 --squash', { role: 'improver' }).deny, true);
    });
    ```
-   [ ] **Step 2: Run** `node --test test/guard.test.mjs` → FAIL on the role loop (the script is not recognised yet, so a factory role would be allowed).
-   [ ] **Step 3: Add the refusal** beside the `tasks.mjs` one: a segment matching `^node\s+\S*automerge\.mjs"?\s` for a `FACTORY_ROLES` role gets the reason `merging is the scheduler's alone, not a factory agent's (automerge.mjs)`. Leave the `gh pr merge|ready` line in `denyGh` untouched, and update the comment at the top of the file to say the scheduler merges only through `automerge.mjs`.
-   [ ] **Step 4: Run** `node --test test/guard*.test.mjs` → PASS. (In a `.claude/worktrees/` checkout a few existing guard tests fail for an unrelated path reason; compare with `main` before blaming this change.)
-   [ ] **Step 5: Commit** `feat: keep auto-merge out of every factory agent's reach`.

---

### Task 5: The tick, the ship wording, the docs, the version

**Files:**

-   Modify: `commands/tick.md` (section 5, a new bullet **Auto-merge** immediately before **Reviewed**)
-   Modify: `skills/ship/SKILL.md` (step 5 and the "merging still is not" line)
-   Modify: `docs/reference.md` (the four rows under `#### Pull requests`; a new `### Auto-merge` section under "Using the factory"; the sentences at line ~402 and ~1126 that say a person merges; Known limits)
-   Modify: `README.md` (one line), `AGENTS.md` (add `scripts/automerge-lib.mjs`, `scripts/automerge.mjs` to the tested-scripts list and one row to "Where things are")
-   Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`0.19.0`)
-   Test: `test/docs.test.mjs`, `test/hygiene.test.mjs`, `test/commands.test.mjs` (existing sweeps)

**Interfaces:**

-   Consumes: the CLI contract from Task 3.

-   [ ] **Step 1: Write the failing check.** Add to `test/commands.test.mjs` (or its existing list of scripts a command must mention, near line 67) an assertion that `commands/tick.md` contains `scripts/automerge.mjs" run` and that `docs/reference.md` documents every `autoMerge.*` key from `config.json`. Run it → FAIL.
-   [ ] **Step 2: Add the tick bullet.** Applies to an `inReview` task whose PR has no fix request newer than its head and is not closed, after the stacked-PR bullet (a retarget or sync of a stacked PR happens before any merge of it). When `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get autoMerge.enabled` prints `true`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/automerge.mjs" run --pr <N> --key <KEY> --labels <the task's labels, comma separated> --worktree <worktree> --readied-head <sha from the task's newest "phase: auto-merge ready head=" comment>`. Two argument rules the CLI enforces: a task with no labels is passed as `--labels ""` (an empty string, never a missing value), and `--readied-head` is left out entirely when there is no such comment (a flag with no value, or whose value starts with `--`, is a hard failure, exit 21). Never pass `--dry-run`. `ready` and `merged` both exit `0`, so branch on the `action` field of the JSON line, not on the exit code alone. By its exit: `0` with action `ready` → COMMENT `[dev-factory] phase: auto-merge ready head=<sha>`; `0` with action `merged` → COMMENT `[dev-factory] phase: auto-merged pr=<url> head=<sha> lines=<n> via=<small|label>` followed by each of the verdict's `notes` on its own line (the `Reviewed` bullet then sees the merge in the same pass); `10` and `12` (including a PR that is simply too large and unlabelled) → nothing, say nothing; `11` → COMMENT `[dev-factory] phase: auto-merge skipped: <reasons>` only when the newest such comment differs, so a standing refusal is said once, not every five minutes; `21` → nothing is changed, note it in the exit summary. Every comment goes through the scrub rule. Never run `gh pr merge` or `gh pr ready` yourself.
-   [ ] **Step 3: Reword `skills/ship/SKILL.md`.** Line 26: replace "resolving threads, marking ready or merging still is not" with the same text plus "(the scheduler merges small, labelled PRs itself, through `scripts/automerge.mjs`; a builder never does)". Step 5: the "human review is still required" sentence gains "unless the scheduler merges it under `autoMerge`, in which case it says so in a comment"; and the "Decisions made without a person" section says its decisions are visible in the PR and, under `autoMerge`, may already be merged when a person reads them.
-   [ ] **Step 4: Write the docs.** `### Auto-merge` in `docs/reference.md`: the rule (enabled AND small OR labelled), that stacked PRs and PRs with agent decisions are included and named in the merge comment, the fixed safety gates (copy the list from "Decisions" above), the two-pass flow, how to turn it on (`dev-factory settings set autoMerge.enabled true`, label a task `auto-merge` to authorise the merge of a task bigger than small; a small one needs no label), why a repository that requires an approval will not auto-merge, how to stop it (turn `autoMerge.enabled` off, add the blocked label, or turn the draft back), and the Auto-merge section; the four `autoMerge.*` rows under Pull requests already exist from Task 1, so only extend their text where the rule needs it. Reword line ~402 to: "What config cannot change: the guards … and that a factory agent never merges. Only the scheduler can, through `scripts/automerge.mjs`, and only when the owner turned `autoMerge.enabled` on in a settings file a ticket cannot edit." Update the "never merges" sentences at ~1126 and the improver section so they still hold (improver PRs and `ai-tooling/` branches are never auto-merged).
-   [ ] **Step 5: README and AGENTS.md** (one line each), **bump both manifests to `0.19.0`**.
-   [ ] **Step 6: Run all checks:** `node --test test/*.test.mjs`, `npx prettier@3.2.5 --check "**/*.{md,json,mjs}"` (`--write` the new plan and docs first), `bash scripts/lint-vocabulary.sh`, `claude plugin validate .` → all pass.
-   [ ] **Step 7: Commit** `feat: auto-merge small labelled PRs; Release 0.19.0`, push the branch, open a draft PR whose body says what could not be verified (a real `gh pr merge` against GitHub, branch protection behaviour; do this once by hand on a throwaway repo before merging the factory change).

---

## Self-review

-   **Spec coverage:** `autoMerge` setting on → Task 1 + `decide` rule `off`; small or labelled → `decide`'s `via` (Review Focus 1, 2); stacked PRs and agent-decision PRs allowed and reported through `notes` → Task 2 tests and Task 5 tick comment; the merge itself, never forced → Task 3; kept safe by guard → Task 4; behaviour documented and wired into the tick → Task 5.
-   **Consistency:** `decide` (with `via` and `notes`), `mergeArgs`, `EXIT`, `changedLines`, `sizeBound` are defined in Task 2 and used under those names in Tasks 3 and 5; the CLI action names (`off|refused|wait|ready|merged|failed`) and exit codes (`0|12|11|10|10|21`) match the tick bullet; the config keys `autoMerge.enabled|label|maxSize|method` match across Tasks 1, 2, 3 and 5.
-   **Open point for the reviewer:** the two-pass flow means a PR is un-drafted and sits non-draft for one tick (5 minutes by default) before it merges, and un-drafting can retrigger CI. If you would rather a person always un-drafts, drop the `ready` action and make a draft `wait` with reason `draft`; Task 2's draft tests and Task 3's `ready` test are the only things that change.
