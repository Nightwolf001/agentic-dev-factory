# User-level Install, Layered Settings and `.devfactory/` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the plugin once per person; turn each MCP server and companion plugin on for all projects or one; keep everything the factory adds to a repository in a git-ignored `.devfactory/`; set every secret once; and give `dev-factory settings` as the complete, grouped list of options with value and source.

**Architecture:** `config.mjs` gains a user layer between the defaults and a project layer that moves to `.devfactory/config.json`. Which servers and plugins are on is recorded in those layers (`mcp.servers.<id>`, `plugins.enabled.<id>`) and applied to Claude Code by sync steps that run `claude mcp` and `claude plugin` at user or local scope, removing only what `~/.dev-factory/managed.json` says the factory added. Scheduled passes start strictly from a generated `.devfactory/mcp.json`. The settings page is a `node:readline` terminal UI over a pure, tested reducer, fed by `settings/options.json`, which a test keeps complete against `config.json`.

**Tech Stack:** Node ESM, `node:test`, bash 3.2, Claude Code CLI (`claude mcp`, `claude plugin`).

**Spec:** `docs/superpowers/specs/2026-11-05-user-level-install-settings-and-promotion-design.md` (§1–§9 and §11, read with the adaptations below). §9 (scratch QA cases) is Task 4 here. §10 (promotion) is a separate follow-up task and is not built by this plan.

## Adaptations for this repository

The spec and plan were written for a company fork. This repository is the organisation-free plugin, so the following override the spec and the task text wherever they conflict:

-   **No organisation anywhere.** `config.json` defaults carry no company, tracker site, project key or host (AGENTS.md). Ignore every mention of a company name, its marketplace path, an `examples/<company>` folder, Appium or a company repository. There is no `examples/` folder and no `test/examples.test.mjs`; do not create them. The install line in docs is `claude plugin install dev-factory@dev-factory --scope user`.
-   **Every tracker is optional.** `tasks.source` is one of `local`, `github`, `notion`, `jira`. The `jira` catalog server is `"recommended": false` with `"tracker": "jira"` (so it is recommended only when `tasks.source = jira`, like `atlassian` and `notion` today). `notion` stays in the catalog as an OAuth HTTP server with no secret, `defaultScope: "user"`. "Notion is out" in the spec does not apply.
-   **Required servers.** `playwright` is required everywhere (scope may change, never `false`). `maestro` is required only when `mobile.appDir` is set (non-null); otherwise it is optional and may be `false`. Required plugin: `superpowers@claude-plugins-official`. Express the maestro rule as a function (`requiredServers(config)`), not a hard-coded list, so validation, `desired()` and the settings page share it. The catalog may carry `"required": true` on `playwright` only; `test/` currently asserts the catalog flags no server, so update that test with the reason.
-   **`defaultScope`:** `user` for playwright, maestro, jira, atlassian, notion, context7, github, sequential-thinking; `project` for 21st, sentry, axiom.
-   **Folders.** `.devfactory/` = per-repository settings and scratch QA cases, git-ignored by its own `.gitignore`. `.factory/tasks/` (the local task source) is unchanged and stays committed; never move it. `.dev-factory/` = per-worktree run state, unchanged.
-   **Settings groups** (Task 9): `MCP servers`, `Plugins`, `Secrets`, `Tasks`, `Sources`, `Models`, `Caps and budgets`, `Git and pull requests`, `Environment`, `Mobile lane`, `Telemetry`, `Review and QA`, `Self-improvement`, `Sandbox`, `Runtime` (fifteen). `Sources` holds every `sources.*` key (local, github, notion, jira). Keys not obviously in one group go to the closest one (for example `scheduler.*`, `alerts.*`, `cleanup.*`, `guard.*` to `Runtime`; `coverage.*`, `evidence.*`, `debug.*`, `validation.*` to `Review and QA`; `blocked.*` to `Tasks`). There is no `qa.promote.targets` map yet (promotion is a later task).
-   **Existing code wins over the plan's line numbers.** Line references like `scripts/worktree.mjs:98-140` come from the fork; find the equivalent code here.
-   **Tests in a `.claude/worktrees/` checkout.** This plan is built in a worktree whose absolute path contains `.claude/`, which makes the shell guard deny almost everything, so six tests in `test/guard.test.mjs` fail here and pass in a normal checkout. `test/factory-target.test.mjs` ("the CLI prints the target as JSON") fails on `main` too. Baseline: 561/568 pass. To check guard tests, run them from a copy outside `.claude/`: `rsync -a --delete --exclude node_modules ./ /tmp/df-uls-guardcheck/ && (cd /tmp/df-uls-guardcheck && node --test test/guard*.test.mjs)`.

## Global Constraints

-   bash 3.2 on macOS: no `mapfile`, no associative arrays.
-   No npm dependencies, no `npm install` on the host; the page uses `node:readline` only.
-   `npx prettier@3.2.5 --check "**/*.{md,json,mjs}"`, `bash scripts/lint-vocabulary.sh`, `claude plugin validate .` and `node --test test/*.test.mjs` pass after every task.
-   New scripts (`project-dir.mjs`, `plugins.mjs`, `settings-lib.mjs`, `settings.mjs`) join AGENTS.md's test list; every behavioural change to a listed file has a test.
-   Nothing assumes the plugin sits inside the repository; machine state stays under `DF_STATE_DIR` (default `~/.dev-factory`).
-   Tests fake the `claude` binary through `DF_CLAUDE_BIN` and never touch the contributor's `~/.claude.json`; child processes get `DF_STATE_DIR` set to a temporary folder and `DF_CONFIG`, `DF_FACTORY_REPO`, `DF_PROJECT_CONFIG`, `DF_PROJECT_QA` cleared.
-   No secret value is ever written to a file other than `~/.dev-factory/.env.local`; catalog configs hold `${VAR:-}` references only.
-   The factory never edits `~/.claude.json` directly and never removes a server or plugin not recorded in `managed.json`.
-   Legacy `dev-factory.config.json`, `dev-factory.qa.yaml`, `.factory/qa/cases/` and `.mcp.json` are still read for one release, with a `note:`; nothing new is written to them (except `cloud init --routine`, §4).
-   Work on `feat/user-level-settings`, never on `main`. End every commit message with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` after a blank line.
-   Keep the vocabulary clean (`bash scripts/lint-vocabulary.sh`); explain rules by their reason. `test/hygiene.test.mjs` and `test/docs.test.mjs` sweep every tracked file (secrets, tracker sites, documented `dev-factory <command>`s, links).
-   A new setting goes in `config.json`, is validated in `scripts/config.mjs` and documented in the README (and, from Task 9, in `settings/options.json`).

## Review Focus

1. **Both config files present.** A committed `dev-factory.config.json` and a `.devfactory/config.json`: only the new one is merged and `config validate` prints a `note:` naming the ignored file. Pinned in Task 2.
2. **The person's own servers.** A user-scope `playwright` the person added by hand, with `managed.json` empty: turning everything off removes nothing. Pinned in Task 6.
3. **Required servers.** `mcp.servers.playwright: false` in any layer fails validation; the page and `settings set` refuse to turn it off. Pinned in Tasks 2 and 10.
4. **Non-interactive use.** `dev-factory settings` with stdin or stdout not a TTY prints the list and exits 0 without raw mode. Pinned in Task 10.
5. **A `DF_*`-sourced value.** `DF_EFFORT=low` in the environment: the `models.effort` row shows `low` with source `DF_EFFORT`, and `⏎`/`space` on it leaves the state unchanged with a message. Pinned in Task 10.

---

## File Structure

| File                                                                                                            | Responsibility                                                                             |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `scripts/project-dir.mjs` (new)                                                                                 | `.devfactory/` paths, the self-ignoring `.gitignore`, `migrate`                            |
| `scripts/config.mjs`                                                                                            | layers, `setIn`, `notices`, validation of the new keys, `write-from-env`                   |
| `scripts/worktree.mjs`, `scripts/guard-lib.mjs`                                                                 | carry the new files; protect `.devfactory/`                                                |
| `mcp/catalog.json`, `scripts/jira-mcp.mjs`, `scripts/cli.mjs`, `scripts/mcp-guard-lib.mjs`, `hooks/hooks.json`  | `defaultScope`, `jira` and `github` in the catalog, env.local fallback, GitHub read-only   |
| `scripts/mcp.mjs`, `scripts/factory-settings.mjs`, `scripts/tick.sh`, `scripts/improve.sh`, `scripts/doctor.sh` | desired set, scoped sync, `managed.json`, generated `.devfactory/mcp.json`, secrets report |
| `scripts/plugins.mjs` (new), `plugins.json`, `scripts/install.sh`, `scripts/update.mjs`                         | plugin scopes, machine-only install, re-sync after update                                  |
| `settings/options.json` (new), `test/readme.test.mjs`                                                           | the option catalogue; completeness against `config.json` and the README                    |
| `scripts/settings-lib.mjs`, `scripts/settings.mjs` (new), `scripts/cli.mjs`                                     | the page, `list`, `set`, secrets                                                           |
| `commands/setup.md`, `hooks/hooks.json`, `scripts/cloud.mjs`, `templates/dev-factory-tick.yml`, docs            | guided setup, SessionStart, cloud, README, AGENTS.md, examples                             |

---

### Task 1: `.devfactory/` paths and migration

**Files:**

-   Create: `scripts/project-dir.mjs`
-   Test: `test/project-dir.test.mjs`

**Interfaces:**

-   Produces:

    -   `PROJECT_DIR = '.devfactory'`
    -   `PROJECT_FILES = { config: '.devfactory/config.json', qa: '.devfactory/qa.yaml', cases: '.devfactory/qa/cases', mcp: '.devfactory/mcp.json' }`
    -   `LEGACY_FILES = { config: 'dev-factory.config.json', qa: 'dev-factory.qa.yaml', cases: '.factory/qa/cases' }`
    -   `projectRoot(from = process.cwd()): string | null`: the nearest folder at or above `from` containing `.git` (file or folder).
    -   `ensureProjectDir(root: string): string`: creates `<root>/.devfactory/` and `.devfactory/.gitignore` containing `# written by dev-factory: this folder stays out of git\n*\n`; an existing `.gitignore` without a `*` line gets one appended; otherwise untouched.
    -   `planMigration(root): Array<{ from: string, to: string, tracked: boolean, conflict: boolean }>`, one entry per legacy path that exists (`tracked` from `git ls-files --error-unmatch`, `conflict` when `to` exists).
    -   `applyMigration(root, moves): { moved: string[], skipped: Array<{ from, reason }>, untrack: string[] }`: `fs.renameSync` (folders included), conflicts skipped with reason `already exists: <to>`, `untrack` holds `git rm -r --cached -- <from>` for tracked sources. It runs no git write itself.
    -   CLI: `project-dir.mjs migrate [--apply]` prints `plan  <from> -> <to>` or `do  <from> -> <to>` per move, `skip  <from>: <reason>`, then each untrack command on its own line.

-   [ ] **Step 1: Write failing tests** in `test/project-dir.test.mjs`, each in a fresh `git init` temporary folder:
    -   `ensureProjectDir makes a folder git ignores`: after the call, with `.devfactory/config.json` written and `git add -A`, `git status --porcelain` is empty.
    -   `ensureProjectDir keeps an existing gitignore and is idempotent`: `foo\n` becomes `foo\n*\n`; a second call changes nothing.
    -   `planMigration lists each legacy path with tracked and conflict`: committed `dev-factory.config.json`, untracked `dev-factory.qa.yaml`, committed `.factory/qa/cases/A-1/x.yaml` give three moves with `tracked` `[true, false, true]`.
    -   `applyMigration skips a conflict and leaves both files`.
    -   `applyMigration returns untrack commands for tracked sources only`: equals `['git rm -r --cached -- dev-factory.config.json', 'git rm -r --cached -- .factory/qa/cases']`.
    -   `projectRoot finds the repository from a subfolder and returns null outside one`.
-   [ ] **Step 2: Run** `node --test test/project-dir.test.mjs`. Expected: FAIL (module missing).
-   [ ] **Step 3: Implement** `scripts/project-dir.mjs` per the interfaces.
-   [ ] **Step 4: Run** `node --test test/project-dir.test.mjs`. Expected: PASS.
-   [ ] **Step 5: Commit** `git add scripts/project-dir.mjs test/project-dir.test.mjs && git commit -m "Add the .devfactory project folder and a migration from the old file locations"`

### Task 2: Settings layers

**Files:**

-   Modify: `scripts/config.mjs`, `config.json` (add `"mcp": { "servers": {} }` and `"plugins": { "enabled": {} }`)
-   Test: `test/config.test.mjs`

**Interfaces:**

-   Consumes: `PROJECT_FILES`, `LEGACY_FILES`, `projectRoot`, `ensureProjectDir` (Task 1).
-   Produces:

    -   `userConfigFile(env = process.env): string` = `<DF_STATE_DIR or ~/.dev-factory>/config.json`.
    -   `findRepoConfig(from, env)`: `DF_CONFIG` first; else, walking up, the first folder holding `.devfactory/config.json` or `dev-factory.config.json`, preferring the new one in the same folder.
    -   `isLegacyConfig(file): boolean`.
    -   `layers({ from = process.cwd(), env = process.env } = {}): Array<{ name: 'defaults' | 'user' | 'project', file: string | null, data: object }>`, always three entries, `data: {}` for a missing file.
    -   `load(file?)`: no argument merges defaults, user, project with `merge`; an explicit file is read as it is.
    -   `setIn(layer: 'user' | 'project', dotted: string, value: unknown, { from, env } = {}): string`: writes the layer file (tab indent, trailing newline); `undefined` deletes the key and prunes empty objects; the project layer always writes `<projectRoot>/.devfactory/config.json` (via `ensureProjectDir`), never the legacy file; returns the path.
    -   `sourceOf(dotted, { from, env }): 'default' | 'user' | 'project' | 'file' | string` (the `DF_*` name when that override is set).
    -   `notices({ from, env }): string[]`: `"<dir>/dev-factory.config.json is the old location: run dev-factory migrate"` when the legacy file is in use; `"<dir>/dev-factory.config.json is ignored: <dir>/.devfactory/config.json is used"` when both exist.
    -   Validation: `mcp.servers` is an object whose keys are catalog ids and values booleans; `plugins.enabled` is an object whose keys are `plugins.json` ids and values booleans; a `false` for a required server or plugin is the problem `mcp.servers.<id> is required and cannot be false` / `plugins.enabled.<id> is required and cannot be false`. The catalog and plugin lists are read from `mcp/catalog.json` and `plugins.json` (not imported from `mcp.mjs`, to avoid a cycle).
    -   CLI: `validate` prints each notice as `note: ...` on stderr, exit code unchanged. `write-from-env [--if-set] [--force]` writes `.devfactory/config.json` from `DF_PROJECT_CONFIG` and `.devfactory/qa.yaml` from `DF_PROJECT_QA`; each value is raw when it starts with `{` (config) or a non-base64 character (yaml) and base64 otherwise; with `--if-set` an unset variable is skipped silently (exit 0), without it an unset variable exits 1; invalid JSON exits 1; an existing file is kept unless `--force`.

-   [ ] **Step 1: Write failing tests** (temporary repositories, `env = { DF_STATE_DIR: tmpState }`):
    -   `the user layer sits between defaults and project`: user `models.effort: 'low'`, `caps.maxConcurrent: 3`; project `caps.maxConcurrent: 1`; `get('models.effort')` is `'low'`, `get('caps.maxConcurrent')` is `1`, `sourceOf('models.effort')` is `'user'`.
    -   `the new project file wins over the legacy one in the same folder, with a notice` (`/is ignored/`).
    -   `the legacy file alone is still read, with a notice` (`/run dev-factory migrate/`).
    -   `setIn project writes .devfactory/config.json and never the legacy file`; `.devfactory/.gitignore` exists afterwards.
    -   `setIn with undefined prunes empty objects` (file holds `{}`).
    -   `validate rejects an unknown server, a non-boolean and a required server set to false`: problems include `mcp.servers.nope is not a catalog server`, `mcp.servers.sentry must be true or false`, `mcp.servers.playwright is required and cannot be false`.
    -   `write-from-env` as a child process: base64 config and raw YAML write both files; `--if-set` with neither set exits 0 and writes nothing; an existing file without `--force` exits 1 and is unchanged.
-   [ ] **Step 2: Run** `node --test test/config.test.mjs`. Expected: new tests FAIL.
-   [ ] **Step 3: Implement** per the interfaces; update the header comment of `config.mjs` to describe the layers.
-   [ ] **Step 4: Run** `node --test test/*.test.mjs`. Expected: PASS.
-   [ ] **Step 5: Commit** `git commit -am "Read a user settings layer and the project layer from .devfactory/config.json"`

### Task 3: Worktrees and the edit guard

**Files:**

-   Modify: `scripts/worktree.mjs:98-140`, `scripts/guard-lib.mjs:1044-1095`
-   Test: `test/worktree.test.mjs`, `test/guard.test.mjs`

**Interfaces:**

-   Consumes: `PROJECT_FILES`, `LEGACY_FILES`, `ensureProjectDir` (Task 1).
-   Produces: `LOCAL_SETTINGS = ['.devfactory/config.json', '.devfactory/qa.yaml', 'dev-factory.config.json', 'dev-factory.qa.yaml']`; `carrySettings` calls `ensureProjectDir(worktree)` before copying into `.devfactory/` and adds no `info/exclude` line for those two. The guard denies any path with a `.devfactory/` segment (case-insensitive, any depth, real path checked) with reason `".devfactory/ holds the owner's settings; a factory run does not edit it"`, except a builder's own `.devfactory/qa/cases/<KEY>/`, which is allowed; `ownCase` and `protectedPath` gain the `.devfactory/qa/cases/` spellings and keep the legacy ones.

-   [ ] **Step 1: Write failing tests:**
    -   worktree: `carrySettings copies .devfactory/config.json and qa.yaml into a new worktree and git status stays clean`.
    -   guard, builder run `{ role: 'builder', key: 'A-1' }`: denied for `.devfactory/config.json`, `.devfactory/qa.yaml`, `.devfactory/.gitignore`, `.devfactory/mcp.json`, `.devfactory/qa/cases/B-2/x.yaml`, `.DevFactory/Config.json`, `sub/.devfactory/config.json`; allowed for `.devfactory/qa/cases/A-1/x.yaml`.
-   [ ] **Step 2: Run** `node --test test/worktree.test.mjs test/guard.test.mjs`. Expected: new tests FAIL.
-   [ ] **Step 3: Implement.** The own-case check runs before the `.devfactory/` deny.
-   [ ] **Step 4: Run** `node --test test/*.test.mjs`. Expected: PASS.
-   [ ] **Step 5: Commit** `git commit -am "Carry .devfactory settings into worktrees and keep runs out of the folder"`

### Task 4: QA cases are scratch work in `.devfactory/qa/cases/`

Spec §9. QA cases are no longer committed: they live in the git-ignored `.devfactory/qa/cases/<KEY>/`, and a QA run is bound to their content by digests instead of by git.

**Files:**

-   Modify: `bin/qa.mjs`, `skills/qa/SKILL.md`, `skills/implement/SKILL.md`, `commands/quick.md`, `agents/factory-builder.md` (wherever they say cases are committed or name `.factory/qa/cases`), `README.md` (the QA evidence section and the Layout table), `qa/profiles.yaml` (only if it names the cases path)
-   Test: `test/qa.test.mjs`, `test/evidence.test.mjs` if it builds cases

**Interfaces:**

-   Consumes: `PROJECT_FILES.cases`, `PROJECT_FILES.qa`, `LEGACY_FILES` (Task 1).
-   Produces in `bin/qa.mjs`:
    -   `CASES_DIR` becomes `.devfactory/qa/cases`; `LEGACY_CASES_DIR = '.factory/qa/cases'`. `casesDirFor(root, key)` returns the new folder when it has any case file for the key, else the legacy folder when that has one, else the new folder. `listCaseFiles` uses it.
    -   `dirtyFiles(root)` ignores every path under `.devfactory/` (a builder's scratch cases are never "uncommitted work"). `.factory/qa/cases/` is not exempt (legacy cases are still committed until migrated).
    -   `start` records `caseDigests: { "<relative path>": "<sha256 hex>" }` for every case file of the key in the manifest.
    -   `done` and `verify` recompute the digests from the same folder; a changed, added or missing case file fails with `cases_changed: <first few paths>` (a `QaError`, non-zero exit). A manifest written before this change (no `caseDigests`) is accepted as today.
    -   The `needs_own_case` message names `.devfactory/qa/cases/<KEY>/`; a restore hint for missing cases no longer says `git checkout`.
    -   QA profiles are read from `.devfactory/qa.yaml`, then the legacy `dev-factory.qa.yaml`, then the plugin's `qa/profiles.yaml`.
-   Skills and commands tell the builder to write cases under `.devfactory/qa/cases/<KEY>/` and never to `git add` them; evidence, the PR and the ticket comment are unchanged.

-   [ ] **Step 1: Write failing tests** in `test/qa.test.mjs` (temporary repositories, as the existing tests build them):
    -   `start accepts uncommitted cases under .devfactory and records their digests`.
    -   `done fails with cases_changed when a case changed after start` (edit one byte), `... when a case was added`, `... when a case was removed`.
    -   `verify fails with cases_changed when a case changed after done`.
    -   `a manifest without caseDigests still verifies`.
    -   `legacy .factory/qa/cases is read when the new folder has nothing for the key`.
    -   `profiles come from .devfactory/qa.yaml before dev-factory.qa.yaml`.
    -   `dirtyFiles ignores .devfactory/ but not .factory/qa/cases/`.
-   [ ] **Step 2: Run** `node --test test/qa.test.mjs`. Expected: new tests FAIL.
-   [ ] **Step 3: Implement**, then update the skills, commands, agent and README text.
-   [ ] **Step 4: Run** `node --test test/*.test.mjs`. Expected: PASS apart from the baseline failures.
-   [ ] **Step 5: Commit** `git commit -am "Keep QA cases as scratch work in .devfactory and bind a run to their digests"`

### Task 5: The catalog: `defaultScope`, `jira`, `github`, and GitHub read-only in runs

**Files:**

-   Modify: `mcp/catalog.json`, `scripts/jira-mcp.mjs` (env fallback), `scripts/cli.mjs` (add `'jira-mcp': ['node', 'scripts/jira-mcp.mjs']`), `scripts/mcp-guard-lib.mjs`, `hooks/hooks.json` (matcher), `scripts/jira-mcp-config.mjs` (export the catalog entry's shape, keep `write` for the transition)
-   Test: `test/mcp.test.mjs`, `test/jira-mcp.test.mjs`, `test/mcp-guard.test.mjs`, `test/entry.test.mjs`

**Interfaces:**

-   Produces:

    -   Every catalog server has `"defaultScope": "user" | "project"`: `user` for playwright, maestro, jira, atlassian, context7, github, sequential-thinking; `project` for 21st, sentry, axiom.
    -   `jira` entry: `{ "title": "Jira (API token)", "category": "tracker", "recommended": true, "defaultScope": "user", "config": { "type": "stdio", "command": "${DF_LAUNCHER:-~/.dev-factory/bin/dev-factory}", "args": ["jira-mcp"], "env": { "JIRA_EMAIL": "${JIRA_EMAIL:-}", "JIRA_API_TOKEN": "${JIRA_API_TOKEN:-}" } }, "requires": ["JIRA_EMAIL and JIRA_API_TOKEN in ~/.dev-factory/.env.local", "dev-factory install --apply (the launcher)"], "secrets": ["JIRA_EMAIL", "JIRA_API_TOKEN"], "domains": [] }`. Check in Step 4 whether `~` expands in `command`; if not, `mcp sync` substitutes the absolute launcher path when it writes the server (Task 6).
    -   `github` entry: `{ "title": "GitHub", "purpose": "Read issues, pull requests, reviews and Actions runs.", "category": "code", "recommended": false, "defaultScope": "user", "config": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN:-}" } }, "requires": ["GITHUB_PERSONAL_ACCESS_TOKEN exported in the shell that starts claude (read scopes are enough)"], "secrets": ["GITHUB_PERSONAL_ACCESS_TOKEN"], "without": "Agents read GitHub through the gh CLI, which the factory needs anyway.", "domains": ["api.githubcopilot.com"] }`.
    -   `context7` gains `"secrets": ["CONTEXT7_API_KEY"]` (optional: `"secretsOptional": true`).
    -   `jira-mcp.mjs`: `loadEnvLocal(env = process.env, file = path.join(env.DF_STATE_DIR || '~/.dev-factory', '.env.local')): object` fills `JIRA_EMAIL`, `JIRA_API_TOKEN` and `JIRA_SITE` from the file only for variables that are empty; `JIRA_SITE` falls back to `get('sources.jira.site')`.
    -   `evaluateMcp` judges `^mcp__(?:plugin_dev-factory_|claude_ai_)?github__(.+)$` inside a run only: allowed when the tool name matches `/^(get|list|search)_|_read$/i`, else denied with `github <tool>: a run reaches GitHub through the guarded gh CLI; the GitHub MCP server is read-only here`.
    -   `hooks.json` matcher becomes `mcp__(plugin_dev-factory_|claude_ai_)?([Ss]entry|[Aa]xiom|[Gg]it[Hh]ub)__.*`.

-   [ ] **Step 1: Write failing tests:**
    -   mcp: `every catalog server names a defaultScope of user or project`; `jira and github are in the catalog and their configs hold variable references, no values` (the JSON text matches no `ghp_`, `github_pat_`, `@`).
    -   jira-mcp: `loadEnvLocal fills only empty variables from the file and never overrides a set one`.
    -   mcp-guard: in a run, `mcp__github__merge_pull_request`, `mcp__github__create_or_update_file`, `mcp__claude_ai_GitHub__push_files` denied; `mcp__github__get_file_contents`, `mcp__github__list_pull_requests`, `mcp__github__pull_request_read` allowed; outside a run `mcp__github__merge_pull_request` allowed. `hooks.json`'s matcher matches `mcp__github__merge_pull_request`.
    -   entry: `dev-factory jira-mcp` resolves to `scripts/jira-mcp.mjs`.
-   [ ] **Step 2: Run** the four test files. Expected: FAIL.
-   [ ] **Step 3: Implement** per the interfaces.
-   [ ] **Step 4: Check by hand** that Claude expands `${DF_LAUNCHER:-...}` and `${GITHUB_PERSONAL_ACCESS_TOKEN:-}` at user scope: `claude mcp add-json -s user df-check '<the github config>'`, `claude mcp get df-check`, then `claude mcp remove -s user df-check`. Expected: the reference is stored, not a value. Record the outcome in the catalog's `requires` text if it differs.
-   [ ] **Step 5: Run** `node --test test/*.test.mjs`. Expected: PASS.
-   [ ] **Step 6: Commit** `git commit -am "Put the Jira token server and GitHub in the catalog, with a default scope per server and GitHub read-only inside runs"`

### Task 6: MCP servers at user or project scope, with ownership

**Files:**

-   Modify: `scripts/mcp.mjs`
-   Test: `test/mcp.test.mjs`

**Interfaces:**

-   Consumes: `layers`, `setIn`, `validate` (Task 2); `defaultScope`, `secrets` (Task 5); `PROJECT_FILES.mcp`, `projectRoot` (Task 1).
-   Produces:

    -   `claudeBin(env = process.env): string` = `env.DF_CLAUDE_BIN || 'claude'`; every `claude` call in `mcp.mjs` and `plugins.mjs` uses it.
    -   `desired(ls = layers(), cat = catalog()): Array<{ id, scope: 'user' | 'project', required: boolean }>`: user `true` → `user`; else project `true` → `project`; project `false` removes a user-level id from the result (honoured by the generated pass config, not by Claude's own scopes); required ids always present, at the layer that names them, else at `defaultScope`.
    -   `managedFile(env)`, `readManaged(env)`, `writeManaged(env, data)`; shape `{ mcp: { user: string[], local: { [repoRealPath]: string[] } }, plugins: { user: string[], local: { [repoRealPath]: string[] } } }`.
    -   `planSync({ want, managed, listing, repo, cat }): { add: Array<{ id, scope }>, remove: Array<{ id, scope }>, skip: Array<{ id, name, reason }> }`: add = wanted and not managed at that scope; skip = `findServer` finds it in `listing` and it is not managed anywhere (`reason: 'already available as "<name>"'`); remove = managed at a scope where it is no longer wanted (a scope change is one remove plus one add). `scope: 'project'` maps to Claude's `local`.
    -   `serverConfig(id, cat, env): object`: the catalog config with `${DF_LAUNCHER:-...}` replaced by the absolute launcher path `<state>/bin/dev-factory` when Step 4 of Task 5 found `~` is not expanded; otherwise as is.
    -   `applySync(plan, { repo, env }): { done: Array<{ id, scope, action }>, failed: Array<{ id, scope, action, error }> }`: runs `<claude> mcp add-json -s user|local <id> <json>` and `<claude> mcp remove -s user|local <id>` (cwd `repo` for local); `managed.json` is updated only for commands that succeeded. Refuses with `dev-factory install --apply first: the jira server runs through the launcher` when `jira` is wanted and the launcher is missing.
    -   `writePassConfig({ want, cat, env, file = <repo>/.devfactory/mcp.json }): string`: `{ mcpServers: { [id]: serverConfig } }` for every wanted id (`jira` included when its token is set), tab-indented; returns the path. The old `jira-mcp-config.mjs write` stays for one release.
    -   `secretsReport({ want, cat, env }): Array<{ name, state: 'set' | 'empty', neededBy: string[], optional: boolean }>`, over every `secrets` entry of the wanted servers plus `CLAUDE_CODE_OAUTH_TOKEN` (`neededBy: ['unattended runs']`, optional).
    -   `planLegacyMigration(file, cat): Array<{ id, action: 'adopt' | 'keep' }>`: an entry of the legacy `.mcp.json` whose config deep-equals the catalog config (ignoring a `${...}` value's default) is `adopt`; anything else is `keep` (the person's own). `mcp.mjs migrate [--apply]` writes `mcp.servers.<id>: true` to the project layer for each `adopt`, removes it from `.mcp.json` (deleting the file when it becomes empty), and leaves `keep` entries with a note; `project-dir.mjs migrate` prints a reminder to run it.
    -   CLI: `enable ID... [--user|--project]` writes `mcp.servers.<id> = true` in that layer (default: `defaultScope`), deletes the key from the other layer, then syncs; `disable ID... [--user|--project]` deletes the key from that layer (both when no flag), refusing required ids with `mcp: <id> is required; change its scope with enable --user or --project`; `sync [--dry-run]`; `write-config`; `secrets`; `connect [--all]` enables recommended (or all) at each `defaultScope` then prints `connectReport` over `desired()`; `list` prints a scope column `user`, `proj`, `repo` (legacy `.mcp.json`), `ext`, `off`. `doctorLines` treats `desired()` ids like `.mcp.json` ones.

-   [ ] **Step 1: Write failing tests.** Fixture: a fake `claude` script (`DF_CLAUDE_BIN`) that appends its argv to a log and exits 1 when an env `DF_FAKE_FAIL` names the server; `DF_MCP_LISTING` for listings.
    -   `desired: user wins over project, project false drops a user-level server, required servers always present at defaultScope`.
    -   `planSync adds a wanted server at its scope and moves a scope as remove plus add`.
    -   `planSync never removes a server the factory does not manage` (listing shows user-scope `playwright`, managed empty, nothing wanted: `remove` is `[]`, `skip` names it).
    -   `applySync records only commands that succeeded` (`DF_FAKE_FAIL=sentry`: `managed.json` lacks `sentry`, `failed[0].id === 'sentry'`).
    -   `writePassConfig writes every wanted server with variable references intact`.
    -   `secretsReport names what each wanted server needs without values`.
    -   CLI `disable playwright` exits 1 with `/required/`.
    -   `migrate adopts a legacy .mcp.json entry that matches the catalog and keeps one that does not` (a `sentry` entry equal to the catalog's → project layer `mcp.servers.sentry: true` and gone from the file; a hand-made `my-tool` entry stays).
-   [ ] **Step 2: Run** `node --test test/mcp.test.mjs`. Expected: FAIL.
-   [ ] **Step 3: Implement.** Keep `enable(ids, file)` / `disable(ids, file)` for the legacy file but stop calling them from the CLI.
-   [ ] **Step 4: Run** `node --test test/*.test.mjs`. Expected: PASS.
-   [ ] **Step 5: Commit** `git commit -am "Turn MCP servers on for all projects or one, recorded in settings and applied through claude mcp with ownership"`

### Task 7: Scheduled passes start strictly from the generated config; doctor reports secrets

**Files:**

-   Modify: `scripts/factory-settings.mjs`, `scripts/tick.sh:62-66`, `scripts/improve.sh:29`, `scripts/doctor.sh:67-75,117-125,138-142`, `scripts/mcp.mjs` (`doctorLines` already changed)
-   Test: `test/mcp.test.mjs` (factory-settings), `test/scheduler.test.mjs` or `test/preflight.test.mjs` (tick flags), `test/docs.test.mjs` as needed

**Interfaces:**

-   Consumes: `desired`, `writePassConfig`, `secretsReport` (Task 6).
-   Produces: `factory-settings.build({ ..., want = desired() })` adds the domains and allow rules of `want` ids (legacy `.mcp.json` ids and `external` still added). `tick.sh` and `improve.sh` run `node "$DIR/scripts/mcp.mjs" write-config` and pass `--strict-mcp-config --mcp-config "$REPO/.devfactory/mcp.json"`; the `$STATE/mcp-jira.json` line goes. `doctor.sh` prints one line per `mcp.mjs secrets` entry (`ok  JIRA_API_TOKEN set (jira)` / `warn  GITHUB_PERSONAL_ACCESS_TOKEN empty: needed by github` / `fail` when a required server's secret is empty) and the `config validate` notes.

-   [ ] **Step 1: Write failing tests:**
    -   `factory-settings allows the domains and rules of desired servers` (project `mcp.servers.sentry: true` → `allowedDomains` has `mcp.sentry.dev`, `permissions.allow` has `mcp__sentry`).
    -   `tick.sh passes --strict-mcp-config with the generated file` (grep the script text, as `test/preflight.test.mjs` checks other flags; adjust to the existing style).
    -   `doctor prints a secrets line per wanted server` (run `doctor.sh` with the fake claude and a temporary state; output matches `/JIRA_API_TOKEN (set|empty)/`).
-   [ ] **Step 2: Run** the tests. Expected: FAIL.
-   [ ] **Step 3: Implement.**
-   [ ] **Step 4: Run** `node --test test/*.test.mjs` and `bash -n scripts/tick.sh scripts/improve.sh scripts/doctor.sh`. Expected: PASS.
-   [ ] **Step 5: Commit** `git commit -am "Start scheduled passes strictly from the generated MCP config and report each secret the servers need"`

### Task 8: Companion plugins at user or project scope; machine-only install; re-sync after update

**Files:**

-   Create: `scripts/plugins.mjs`
-   Modify: `plugins.json` (`"defaultScope": "user"` per plugin), `scripts/install.sh:9,52-70`, `scripts/update.mjs` (`main` runs `mcp sync` and `plugins sync` after a successful update), `scripts/cli.mjs` (`plugins: ['node', 'scripts/plugins.mjs']`)
-   Test: `test/plugins.test.mjs`, `test/scheduler.test.mjs` (install without a repository), `test/update.test.mjs`

**Interfaces:**

-   Consumes: `layers` (Task 2); `claudeBin`, `readManaged`, `writeManaged` (Task 6).
-   Produces:

    -   `pluginCatalog(): { plugins: Array<{ id, required, why, defaultScope }>, marketplaces }`.
    -   `desiredPlugins(ls, cat): Array<{ id, scope: 'user' | 'project', required, off?: 'project' }>`: same rules as `desired()`; a project `false` on a user-level plugin yields `{ id, scope: 'user', off: 'project' }`; an optional plugin no layer names is wanted at `defaultScope` unless `DF_INSTALL_OPTIONAL=0`.
    -   `planPlugins({ want, managed, installed, repo }): { install: Array<{ id, scope }>, disable: Array<{ id, scope: 'local' }>, uninstall: Array<{ id, scope }> }`; `installed` is the parsed `claude plugin list --json`; only managed plugins are uninstalled.
    -   `applyPlugins(plan, { repo, env })`: `<claude> plugin install <id> --scope user|local`, `<claude> plugin disable <id> --scope local`, `<claude> plugin uninstall <id>` for managed ones, cwd `repo` for local; records in `managed.json`.
    -   CLI `plugins.mjs sync [--dry-run]`, `plugins.mjs list`.
    -   `install.sh` outside a repository prints `no repository here: machine setup only (launcher, env file, plugins); run it in a repository to add its scheduler` and skips the scheduler step; step 4 becomes `node "$DIR/scripts/plugins.mjs" sync` (`--dry-run` unless `--apply`).

-   [ ] **Step 1: Write failing tests:**
    -   plugins: `required plugin always wanted at user scope`; `project true installs at local scope from the repository` (fake log has `plugin install frontend-design@claude-plugins-official --scope local`); `project false on a user-level plugin disables it at local scope`; `an unmanaged plugin is never uninstalled`.
    -   install: `install.sh` (dry run, fake claude) from a non-repository exits 0 and prints `machine setup only`.
    -   update: after a successful update the fake log shows `mcp sync` and `plugins sync` were invoked (through `cli.mjs`).
-   [ ] **Step 2: Run** the tests. Expected: FAIL.
-   [ ] **Step 3: Implement** per the interfaces (bash 3.2 in `install.sh`).
-   [ ] **Step 4: Run** `node --test test/*.test.mjs` and `bash -n scripts/install.sh`. Expected: PASS.
-   [ ] **Step 5: Commit** `git commit -am "Install companion plugins for all projects or one, allow a machine-only install and re-sync after an update"`

### Task 9: The option catalogue

**Files:**

-   Create: `settings/options.json`, `scripts/settings-lib.mjs`
-   Modify: `test/readme.test.mjs` (derive `OPEN` from the catalogue's `map` entries), `AGENTS.md` (config rule: a new setting also gets an `options.json` entry)
-   Test: `test/settings-catalog.test.mjs`

**Interfaces:**

-   Produces: `settings/options.json` = `{ "groups": ["MCP servers", "Plugins", "Secrets", "Tasks", "Jira", "Models", "Caps and budgets", "Git and pull requests", "Environment", "Mobile lane", "Telemetry", "Review and QA", "Self-improvement", "Sandbox", "Runtime"], "options": { "<dotted.key>": { "group": string, "title": string, "type": "boolean" | "number" | "string" | "list" | "map", "scopeHint": "user" | "project", "env"?: "DF_*" } } }`. Maps: `environments`, `review.specialistAxes`, `git.branchTypes`, `models.efforts`, `pr.sizeLabels`, `pr.areaLabels`, `pr.categoryByBranchType`, `repoSkills`, `sources.jira.states`, `qa.promote.targets` (added by the companion plan). `scopeHint` is `user` for `models.*`, `alerts.notify`, `runtime.*`; `project` otherwise. `mcp.servers` and `plugins.enabled` are not options (the page builds those rows from the catalogs).

    -   Create `scripts/settings-lib.mjs` with one export for now, `optionCatalog(): { groups: string[], options: object }` (Task 10 extends the file).

-   [ ] **Step 1: Write failing tests** in `test/settings-catalog.test.mjs`:
    -   `every leaf of config.json is an option or lies inside a map option` (walk `config.json`; a leaf under a `map` key counts as covered; `mcp.servers.*` and `plugins.enabled.*` excluded).
    -   `every option names a key config.json has` (a map key must be an object in the defaults).
    -   `every env override in config.mjs's ENV_OVERRIDES is on its option` and vice versa.
    -   `groups are the listed fifteen and every option's group is one of them`.
    -   readme: the existing README tests still pass with `OPEN` derived from the catalogue.
-   [ ] **Step 2: Run** `node --test test/settings-catalog.test.mjs test/readme.test.mjs`. Expected: FAIL.
-   [ ] **Step 3: Write** `settings/options.json`, taking titles from the README tables; update `test/readme.test.mjs` and the AGENTS.md config rule.
-   [ ] **Step 4: Run** `node --test test/*.test.mjs`. Expected: PASS.
-   [ ] **Step 5: Commit** `git commit -am "Add the option catalogue that keeps every setting visible"`

### Task 10: The settings page

**Files:**

-   Create: `scripts/settings.mjs`
-   Modify: `scripts/settings-lib.mjs` (from Task 9), `scripts/cli.mjs` (`settings`, `migrate` → `scripts/project-dir.mjs migrate`; `resolve` supports a fixed extra argument)
-   Test: `test/settings.test.mjs`, `test/entry.test.mjs`

**Interfaces:**

-   Consumes: `layers`, `setIn`, `sourceOf`, `validate`, `ENV_OVERRIDES` (Task 2); `catalog`, `desired`, `planSync`, `applySync`, `secretsReport` (Task 6); `pluginCatalog`, `desiredPlugins`, `planPlugins`, `applyPlugins` (Task 8); `optionCatalog` (Task 9).
-   Produces (pure, in `settings-lib.mjs`):

    -   `type Row = { group, kind: 'mcp' | 'plugin' | 'secret' | 'option', id, title, type, value, source: 'default' | 'user' | 'project' | 'file' | string, locked: boolean, editable: boolean }`. Server and plugin rows: `value` is `'off' | 'project' | 'user'`. Secret rows: `value` is `'set' | 'empty'`, `title` says who needs it. Option rows: `value` is the effective value; `editable` is false when `source` is a `DF_*` name.
    -   `buildRows({ layers, mcpCat, pluginCat, options, secrets, env }): Row[]` in catalogue group order, rows sorted by id within a group.
    -   `initialState(rows, { repo }): { rows, cursor: 0, collapsed: Set<string>, filter: '', edits: Map<string, { layer, key, value }>, message: '', quitArmed: false }`.
    -   `reduce(state, key: 'up' | 'down' | 'space' | 'u' | 'p' | 'd' | 'enter' | 'q' | 's' | 'left' | 'right' | { search: string } | { input: string } | { secret: string }): state`:
        -   `space`: server/plugin `off → project → off`; a `user` row gets `message: 'on for all projects: u turns it off there, p adds a project-level off'`; boolean option flips in `scopeHint`'s layer; others no-op.
        -   `u`: server/plugin `user → off`, else `→ user`; option sets the effective value in the user layer. `p`: same for project. `d`: removes the row's override in every layer (`value: undefined`).
        -   A change that would turn a `locked` row off is refused: `message: '<id> is required: it cannot be turned off'`.
        -   A non-editable option row: `message: '<key> is set by <DF_*>; change it in your shell or ~/.dev-factory/.env.local'`.
        -   `enter` on a number/string/list/map option opens `editing: { id, text }`; `{ input }` validates with `validate()` on a merged copy and either records the edit in `scopeHint`'s layer or sets `message` to the problem. `enter` on a secret row opens `editing: { id, secret: true }`; `{ secret }` records `{ layer: 'env', key: name, value }`.
        -   `left`/`right` collapse or expand the cursor row's group; `{ search }` sets `filter`.
        -   `q` with edits arms a confirm (`message: 'unsaved changes: s saves, q again discards'`); a second `q`, or `q` with none, returns `{ ...state, exit: 'discard' }`; `s` returns `{ ...state, exit: 'save' }`.
    -   `changes(state): Array<{ layer: 'user' | 'project' | 'env', key, value }>`: server rows map to `mcp.servers.<id>`, plugin rows to `plugins.enabled.<id>`; `off` writes `undefined` to both layers; `project` writes `true` to project and `undefined` to user; `user` writes `true` to user and `undefined` to project.
    -   `render(state, { width }): string`: header `dev-factory settings: <repo>`, group headers `▾`/`▸ <group> (<n>)`, rows `▸ <id padded 28> <value padded 14> <source>`, footer `↑↓ move  space on/off  u all projects  p this project  d default  ⏎ edit  / search  s save (<n> changes)  q quit`, then `message`; no line longer than `width`.
    -   `settings.mjs`: interactive when both stdio ends are TTYs (`readline.emitKeypressEvents`, raw mode, alternate screen, restored on every exit including `SIGINT`); on save, `setIn` per change (env changes written to `.env.local`, mode 600, replacing an existing line for that name), then `mcp sync` and `plugins sync`, results printed after leaving the screen. Non-TTY: `list`. `list [--json]`; `set <id|key> <value> [--user|--project]` (`on` = `project`; secrets as `set secret:<NAME>` reading the value from stdin) through the same reducer, exit 1 with the reducer's message when nothing changed.

-   [ ] **Step 1: Write failing tests:**
    -   `buildRows lists servers, plugins, secrets and every option, required rows locked, DF_ rows not editable` (env `DF_EFFORT=low`: the `models.effort` row has `value 'low'`, `source 'DF_EFFORT'`, `editable false`).
    -   `space on an off server turns it on for this project; changes writes project true and clears user`.
    -   `u on a project server moves it to all projects`.
    -   `a required server cannot be turned off by space or u` (message as specified).
    -   `space on a DF_-sourced option leaves the state and explains`.
    -   `enter then input on a number validates: "abc" is refused with the validate problem, "3" is recorded in the project layer`.
    -   `d removes the override from both layers`.
    -   `q with edits asks first; a second q discards`.
    -   `render keeps every line within width and marks the cursor row`.
    -   CLI `settings list --json` with stdin `/dev/null` exits 0 and parses as an array of rows.
    -   CLI `settings set playwright off` exits 1 with `/required/`; `settings set sentry on` writes `mcp.servers.sentry: true` to `.devfactory/config.json` and the fake log shows `mcp add-json -s local sentry`; `settings set secret:CONTEXT7_API_KEY` with stdin `abc` writes `CONTEXT7_API_KEY=abc` to the temporary `.env.local` with mode `600` and prints no value.
-   [ ] **Step 2: Run** `node --test test/settings.test.mjs test/entry.test.mjs`. Expected: FAIL.
-   [ ] **Step 3: Implement** `settings-lib.mjs`, then `settings.mjs`, then the `cli.mjs` entries and usage comment.
-   [ ] **Step 4: Run** `node --test test/*.test.mjs`. Expected: PASS.
-   [ ] **Step 5: Try it by hand** in a scratch repository: `node scripts/cli.mjs settings`; set `sentry` to this project and `context7` to all projects, edit `caps.maxConcurrent`, save. Expected: both config files hold the keys, `claude mcp list` shows both servers; turn them off and save: gone from `claude mcp list`; Ctrl-C mid-page leaves the terminal usable (`stty -a` shows `icanon`).
-   [ ] **Step 6: Commit** `git commit -am "Add dev-factory settings: every option grouped with its value and source, editable for this project or all projects"`

### Task 11: Guided setup, cloud, SessionStart, docs and migration notices

**Files:**

-   Modify: `commands/setup.md`, `hooks/hooks.json` (SessionStart), `scripts/cloud.mjs`, `templates/dev-factory-tick.yml`, `scripts/wizard.sh`, `scripts/install.sh` (closing text), `scripts/sources/index.mjs:13`, `.env.example`, `README.md`, `AGENTS.md`, `CONTRIBUTING.md` as needed
-   Test: `test/commands.test.mjs`, `test/readme.test.mjs`, `test/docs.test.mjs`, `test/cloud.test.mjs`, `test/packaging.test.mjs`

**Interfaces:**

-   Consumes: everything above.
-   Produces:

    -   `hooks.json` gains `"SessionStart": [{ "matcher": "startup|resume", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs\" write-from-env --if-set", "timeout": 15 }] }]`.
    -   `cloud.mjs init --routine` writes `.mcp.json` from `desired()` (`writePassConfig` to that path, variable references only) and merges `enabledMcpjsonServers: [...ids]` into `.claude/settings.json`; its printed help names `DF_PROJECT_CONFIG` and `DF_PROJECT_QA` as the session's environment variables. `--github-actions` guidance names them as repository variables.
    -   `templates/dev-factory-tick.yml`: a step `dev-factory config write-from-env --if-set` with `env: DF_PROJECT_CONFIG: ${{ vars.DF_PROJECT_CONFIG }}` and `DF_PROJECT_QA: ${{ vars.DF_PROJECT_QA }}` before the pass; header comment updated; no `.mcp.json` requirement.
    -   `commands/setup.md`, rewritten as guided mode: (1) look at the repository as today, plus `dev-factory migrate` offered when legacy files exist; (2) walk the rows that matter for a first run with one recommendation each, writing each answer with `dev-factory settings set ...` (project keys, sprint rule, improvement project, each server and plugin with scope using `defaultScope`, environment type and compose details, telemetry, secrets that are empty via `set secret:<NAME>`); (3) `mcp sync`, `plugins sync`, `config validate`, `doctor`; (4) install line `claude plugin install dev-factory@dev-factory --scope user` once per machine; (5) close with `dev-factory settings` for later changes. No hand-written `.mcp.json` entry anywhere.
    -   README: Quick start (user-scope install), MCP servers (scopes, `managed.json`, generated pass config, `jira` in the catalog, `/mcp` for a per-project off), Configuration (five layers; `.devfactory/`; one line on `.dev-factory/` versus `.devfactory/`), a Settings page section (keys, groups, secrets), a Moving section (`dev-factory migrate`, `git rm --cached` lines), Cloud (`DF_PROJECT_CONFIG`, `DF_PROJECT_QA`, routine `.mcp.json`). AGENTS.md: state rule, test list, "Where things are" rows (settings page, option catalogue, project folder, plugins).

-   [ ] **Step 1: Write failing tests:** `commands.test.mjs`: `setup.md names settings set, mcp sync and plugins sync and never .mcp.json as something to write`; `cloud.test.mjs`: `init --routine writes .mcp.json with variable references only and enabledMcpjsonServers`; `docs.test.mjs`/`readme.test.mjs`: README sections `Settings page` and `Moving to .devfactory` exist.
-   [ ] **Step 2: Run** those tests. Expected: FAIL.
-   [ ] **Step 3: Write** the command, hook, cloud, template, docs and example changes.
-   [ ] **Step 4: Run every check:** `node --test test/*.test.mjs`; `bash scripts/lint-vocabulary.sh`; `npx prettier@3.2.5 --check "**/*.{md,json,mjs}"`; `claude plugin validate .`; `grep -rn "dev-factory.config.json" commands skills agents` prints nothing. Expected: all pass.
-   [ ] **Step 5: End to end by hand.** In a scratch clone with a legacy `dev-factory.config.json`: `claude plugin install dev-factory@dev-factory --scope user`, then `/dev-factory:setup`. Expected: migration offered; `.devfactory/` exists and `git status` does not show it; `dev-factory doctor` passes with each secret line; `claude mcp list` shows the chosen servers at the chosen scopes; a second repository sees the user-level ones only.
-   [ ] **Step 6: Commit** `git commit -am "Guided setup through the settings page, cloud sessions fed from DF_PROJECT_CONFIG, docs for the user-level install"`
