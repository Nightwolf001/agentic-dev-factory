# User-level install, layered settings, the `.devfactory/` folder and QA case promotion

Design, 2026-11-05. Supersedes the two plans of 2026-11-04 (`docs/superpowers/plans/2026-11-04-user-level-install-and-devfactory-folder.md` and `2026-11-04-promote-test-cases.md`), which were written before this brainstorm and before the Claude Code research below.

> This design was first written for a company fork. In this repository it is read together with the "Adaptations for this repository" section of `docs/superpowers/plans/2026-11-05-user-level-install-and-settings.md`, which wins where the two differ (no organisation, every tracker optional, Notion kept, only `playwright` always required). §10 (promotion) is a separate later task.

## Intent

Today the factory is installed per repository, its options are spread over `config.json`, the README tables, `.env.example`, `mcp/catalog.json` and `plugins.json`, and setup asks about only some of them. Secrets get typed more than once: the Jira token goes into `~/.dev-factory/.env.local` and again, by hand, into an Atlassian entry in `.mcp.json`. The owner's words: "too much custom config and hidden options, plus manual API token copy-pastes in multiple places".

After this work:

-   The plugin is installed **once per person** (user scope). A repository needs nothing installed.
-   Each MCP server and companion plugin is turned on **for all of a person's projects** or **for one project**. Setup asks that for each one.
-   Everything the factory adds to a repository lives in one git-ignored folder, **`.devfactory/`**.
-   **`dev-factory settings`** shows every option the factory has, grouped, with its current value and where that value came from, and lets you change it. Setup is the same page in guided mode.
-   Every secret is set **once**, in one place, and referenced by name everywhere else.
-   A ticket's QA cases are **scratch work**: written on the fly, walked once for evidence, never committed. After QA and review pass, the builder promotes one or two UI cases into the project's own test suite, in the project's framework.

## Goals

1. `claude plugin install dev-factory@dev-factory --scope user` once; then `/dev-factory:setup` in any repository.
2. Setup asks, per MCP server and per companion plugin, "all projects, this project only, or off", with a recommendation, and nothing else about them.
3. `.devfactory/` holds the project config, the QA profiles, the scratch QA cases and the generated MCP config, and keeps itself out of git.
4. A settings page that is the complete list of options: if a key exists in the defaults, it has a row.
5. One secret store per environment (`~/.dev-factory/.env.local` on a machine; repository secrets on GitHub Actions). No server config ever holds a value.
6. QA cases stay uncommitted, with the same guarantees as today (a run is bound to the cases and the code it walked).
7. `qa.promoteTestCases`: after QA and review, promote one or two UI cases into the project's Playwright or Detox suite.

## Non-goals

-   Frameworks other than Playwright and Detox are **not** promotion targets.
-   No new MCP servers beyond `github` and the existing `jira` server moving into the catalog. Notion is out.
-   Claude Code's own plugin settings dialog (`userConfig` in `plugin.json`, `claude plugin configure`) is not used: it stores only single-line strings per plugin and cannot show where a value came from. It may hold the GitHub token later; not now.
-   The factory does not edit `~/.claude.json` by hand. Everything it does to Claude Code goes through `claude mcp` and `claude plugin`.
-   No per-project "off" switch for a server a person turned on for all projects, in interactive sessions. Claude Code keeps that switch in the `/mcp` panel (a per-project `disabledMcpServers` list in `~/.claude.json`), and the page points there. Scheduled passes do honour a project-level off, because they start with exactly the servers the config names (see MCP below).

## Anti-goals (what would make this a failure even if it works)

-   A person's own servers or plugins get removed or changed by the factory. The factory removes only what it added itself.
-   A secret appears in any file other than `~/.dev-factory/.env.local` (or in a repository).
-   A QA run can be reused after its cases or its code changed.
-   A promoted test is committed red, or half-converted.
-   An option exists that the settings page does not show.
-   The old files silently stop working. One release of reading them with a notice, and a migration command.

## Constraints

-   Node ESM scripts with `node:test`, no npm dependencies, and no `npm install` on the host. The terminal page uses `node:readline` only.
-   Shell scripts run on macOS bash 3.2.
-   Prettier 3.2.5, `scripts/lint-vocabulary.sh` and `claude plugin validate .` pass. Every behavioural change to a file in AGENTS.md's test list gets a test; the new scripts join that list.
-   Nothing assumes the plugin sits inside the repository. Machine state stays under `DF_STATE_DIR` (default `~/.dev-factory`).
-   Commits carry no attribution line. Work on a feature branch.
-   The factory's hooks and guards keep working for repositories that have not migrated yet.

## What the research established (Claude Code 2.1.318)

-   MCP scopes: user and local servers are stored in `~/.claude.json` (local under `projects["<path>"]`), project servers in `.mcp.json`. Local scope is keyed by the project path; whether a worktree at another path sees them is undocumented. The factory never depends on it: every session, scheduled or interactive, starts in the **main checkout**, and the builder's worktree is driven from that session.
-   `${VAR}` and `${VAR:-default}` expand in `command`, `args`, `env`, `url` and `headers` at every scope (a default is required for user and local entries). Unset variables are left literal.
-   `claude -p` loads project `.mcp.json` servers without approval; `--strict-mcp-config` with `--mcp-config <file>` uses exactly the servers in the file.
-   `enabledMcpjsonServers` / `disabledMcpjsonServers` / `enableAllProjectMcpServers` pre-approve or reject `.mcp.json` servers; they are ignored when committed in an untrusted folder.
-   Plugins: `claude plugin install <id> --scope user|project|local` writes `enabledPlugins` in `~/.claude/settings.json`, `.claude/settings.json` or `.claude/settings.local.json`. A project or local `false` turns off a user-scope plugin in that project. The marketplace registration is per user. `claude plugin list --json` exists; `claude mcp list` has no `--json`.
-   A plugin's `hooks.json` may register `SessionStart` (matchers `startup`, `resume`, `clear`, `compact`, `fork`).
-   `CLAUDE_CONFIG_DIR` moves settings, sessions and plugins; whether it moves `~/.claude.json` is undocumented, so tests fake the `claude` binary instead of pointing it at a temporary home.

## Decisions

### 1. Install scope

The documented install is `claude plugin install dev-factory@dev-factory --scope user`, once per machine. `dev-factory install` (the launcher, the env file, companion plugins) runs from anywhere; only the scheduler step needs a repository and is skipped with a note when there is none.

### 2. Settings layers

Later layers win. Objects merge key by key; arrays and scalars replace.

| Layer    | Where                              | Use                                                                         |
| -------- | ---------------------------------- | --------------------------------------------------------------------------- |
| defaults | `config.json` in the plugin        | shared defaults, no organisation                                            |
| user     | `~/.dev-factory/config.json`       | one person's choices for every project: models, effort, servers and plugins |
| project  | `<repo>/.devfactory/config.json`   | what is true for this project: Jira projects, environment, targets          |
| file     | `DF_CONFIG`                        | tests and odd machines; replaces the project layer                          |
| env      | the `DF_*` variables, `.env.local` | a value that differs on one machine                                         |

`config.mjs` gains `layers()`, `setIn(layer, key, value)` and `notices()`. The legacy `dev-factory.config.json` is still read for one release when `.devfactory/config.json` is absent, with a notice naming `dev-factory migrate`. When both exist, the new one is used and the notice says the old one is ignored.

### 3. The `.devfactory/` folder

```
.devfactory/
  .gitignore      "*" — the folder ignores itself; the repository's .gitignore is never touched
  config.json     the project layer
  qa.yaml         QA profiles (replaces dev-factory.qa.yaml)
  qa/cases/<KEY>/ scratch QA cases
  mcp.json        generated: the MCP servers a scheduled pass starts with (never edited by hand)
```

`scripts/project-dir.mjs` owns the paths, `ensureProjectDir()` and `dev-factory migrate [--apply]`, which moves `dev-factory.config.json`, `dev-factory.qa.yaml` and `.factory/qa/cases/` into place, skips a target that already exists, and prints the `git rm -r --cached -- <path>` lines for files that are tracked. The worktree helper carries `config.json` and `qa.yaml` into each new worktree as it carries the legacy files today; `.devfactory/` needs no `info/exclude` line.

The run state folder `.dev-factory/` (run.json, env.json, evidence) stays as it is. The two names are close; the run folder is per worktree and transient, the settings folder is per repository and persistent. The README says so in one line.

### 4. MCP servers

**Recorded in config.** `mcp.servers.<id>: true` in the user layer means all projects; in the project layer, this project. A project-layer `false` means off here even if the user layer says on: honoured by scheduled passes, and shown on the page with "turn it off for this project in `/mcp`" for interactive sessions. Required servers (`playwright`, `maestro`) cannot be `false` anywhere; validation refuses it.

**Applied to Claude Code** by `dev-factory mcp sync` (run by setup, by the page on save and by `doctor`): user → `claude mcp add-json -s user <id> <json>`; project → `claude mcp add-json -s local <id> <json>` from the main checkout; off → `claude mcp remove -s <scope> <id>` **only for a server recorded in `~/.dev-factory/managed.json`** as added by the factory at that scope. A catalog server Claude already has from elsewhere (a hand-made user entry, a claude.ai connector) is used as it is and never duplicated or removed. The legacy `.mcp.json` is read, never written; `migrate` offers to move its factory-added entries to local scope and delete them from the file.

**Scheduled passes** write `.devfactory/mcp.json` from the desired set (the catalog configs, variable references intact, plus the `jira` server) and start `claude -p --strict-mcp-config --mcp-config .devfactory/mcp.json`. The pass then has exactly the servers the config names, whatever `~/.claude.json` holds, and the sandbox and permission settings are built from the same list.

**The `jira` server survives plugin updates.** A user-scope entry holds a fixed command path, and the installed plugin lives at a versioned cache path that `dev-factory update` replaces. So the catalog entry's `command` is the launcher `~/.dev-factory/bin/dev-factory` with the subcommand `jira-mcp` (the launcher always runs the newest installed version), `dev-factory install --apply` is a prerequisite that `mcp sync` checks, and `update.mjs` runs `mcp sync` after an update. The server reads `sources.jira.site` from the config itself, as `scripts/jira-mcp.mjs` does today, so the catalog config carries only the two variable references.

**Cloud sessions that are not `claude -p` passes.** A routine or Claude Code web session starts from the committed files and has no `~/.claude.json`. For those, `cloud init --routine` writes a committed `.mcp.json` from the project's desired set (variable references only, never a value) and the `enabledMcpjsonServers` list in `.claude/settings.json`. That is the one place the factory writes `.mcp.json`, and only on an explicit `cloud init`.

**Catalog changes.** Every server gets `defaultScope` (`user` for playwright, maestro, jira, atlassian, context7, github, sequential-thinking; `project` for 21st, sentry, axiom). `jira` (the plugin's own stdio server, `scripts/jira-mcp.mjs`, with `JIRA_EMAIL: "${JIRA_EMAIL:-}"` and `JIRA_API_TOKEN: "${JIRA_API_TOKEN:-}"`) joins the catalog as recommended; `atlassian` (OAuth) stays for people without a token. `github` joins as optional: `{ "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN:-}" } }`. Inside a factory run the MCP guard keeps `github` read-only (tool names starting `get_`, `list_`, `search_` or ending `_read`), because a run reaches GitHub through the guarded `gh` CLI and the server must not be a way around it.

### 5. Secrets

One store per environment: `~/.dev-factory/.env.local` on a machine, repository secrets on GitHub Actions. Rules:

-   Every catalog server and every script references a secret by variable name. Setup never asks for a value a second time, and never writes one anywhere else. The hand-written API-token Atlassian entry in `.mcp.json` goes away: `jira` is that server.
-   Interactive sessions do not load `.env.local`, so `scripts/jira-mcp.mjs` reads `~/.dev-factory/.env.local` itself when its variables are empty. The same fallback applies to any plugin-owned stdio server; HTTP servers with a header reference (`github`, `context7`'s key) need the variable exported in the shell that starts `claude`, and the doctor says so when it is empty and the server is on.
-   `dev-factory doctor` lists each variable the enabled servers and features need, as `set` or `empty`, with what needs it. It never prints a value.
-   The settings page has a Secrets group: `set`/`empty` per variable, `⏎` prompts with hidden input and writes `.env.local` (mode 600).

### 6. Companion plugins

`plugins.enabled.<id>: true` in the user or project layer, `defaultScope` in `plugins.json` (all `user` today), applied by `dev-factory plugins sync`: `claude plugin install <id> --scope user` or `--scope local`, `claude plugin disable <id> --scope local` for a project-layer `false` on a user-level plugin, removal only for plugins in `managed.json`. `superpowers` is required and cannot be `false`.

### 7. The settings page (`dev-factory settings`)

One flat terminal page, grouped, in this order: MCP servers, Plugins, Secrets, then the config groups in the README's order (Tasks, Jira, Models, Caps and budgets, Git and pull requests, Environment, Mobile lane, Telemetry, Review and QA, Self-improvement, Sandbox, Runtime). Each row: key (or id), short description, value in effect, source (`default`, `user`, `project`, or the `DF_*` variable name). Groups collapse; `/` searches.

Keys: `↑↓` move, `space` flips a boolean or cycles a server/plugin `off → this project → off`, `u` sets the row for all projects, `p` for this project, `d` removes the override (back to default), `⏎` edits a number, string or list inline (validated with `config.mjs validate`'s rules before it is accepted; a list is comma-separated), `s` saves, `q` quits (asks when there are unsaved changes). A `DF_*`-sourced value is shown with the variable name and not editable. Required servers and plugins cannot be turned off, only moved between scopes. Secrets rows take `⏎` only.

Save writes the layer files through `setIn`, then runs `mcp sync` and `plugins sync`, and prints their results after leaving the alternate screen. Non-interactive (stdin or stdout not a TTY): prints the list and exits 0. `settings list [--json]` and `settings set <id|key> <value> [--user|--project]` exist for scripts and for the setup command.

**The option catalogue.** A new `settings/options.json` maps every setting to `{ group, title, type, scopeHint }` (`scopeHint` is `user` or `project`, the layer `space`/`⏎` write to when neither `u` nor `p` was pressed; models and effort are `user`, everything else `project`). A setting is a leaf key of `config.json`, or one of the maps whose entries a project names itself (`environments`, `review.specialistAxes`, `git.branchTypes`, `models.efforts`, `pr.sizeLabels`, `pr.areaLabels`, `pr.categoryByBranchType`, `repoSkills`, `sources.jira.states`, `qa.promote.targets`), listed in the file with `type: "map"`. A map is one row: its value is shown as compact JSON and `⏎` edits that JSON text, validated before it is accepted. A test fails when a `config.json` leaf has no entry (and is not inside a listed map) or an entry names no key, so a new setting cannot be hidden. The README reference tables are checked against the same file.

**Setup is the page in guided mode.** `/dev-factory:setup` reads the repository as today (build files, `gh repo view`, `claude mcp list`, Maestro on the machine), then walks the rows that matter for a first run with a recommendation each (project keys, sprint rule, improvement project, each server and plugin with scope, environment type, telemetry, secrets that are empty), writes them with `settings set`, and leaves the rest at default. It ends with `doctor` and says "change anything later with `dev-factory settings`".

### 8. Cloud and GitHub Actions

`.devfactory/` is never committed, so a fresh checkout gets its project config from `DF_PROJECT_CONFIG` (the file's JSON, raw or base64) and its QA profiles from `DF_PROJECT_QA` (the YAML, raw or base64): `dev-factory config write-from-env [--if-set] [--force]` writes both, each only when its variable is set. The plugin's `SessionStart` hook runs it with `--if-set`, so a Claude Code web or routine session with the variable set has its config before the first command. The Actions template adds the step before the pass and passes the variable from `vars.DF_PROJECT_CONFIG`; the Jira secrets come from repository secrets as today. The pass then generates `.devfactory/mcp.json` and starts strictly from it, so no `.mcp.json` approval is involved on a runner.

### 9. QA cases are scratch work

Cases live in `.devfactory/qa/cases/<KEY>/`, git-ignored, and are never committed. `qa.mjs`:

-   `start` no longer needs the cases committed: `dirtyFiles` exempts `.devfactory/`. It records a sha256 per case file in the manifest (`caseDigests`).
-   `done` and `verify` recompute the digests; a changed, added or missing case fails with `cases_changed`, so a run still cannot outlive its cases. The head binding for code stays as it is.
-   The restore hint for missing cases no longer mentions `git checkout`.
-   The legacy `.factory/qa/cases/` is still read when the new folder has nothing for the key.
-   Profiles come from `.devfactory/qa.yaml`, then the legacy file, then the plugin's defaults.

The edit guard allows a builder only its own `.devfactory/qa/cases/<KEY>/` and refuses everything else under `.devfactory/`, at any depth and in any letter case. Evidence (screenshots, requests, the run manifest) goes to the PR and the Jira ticket exactly as today; nothing there changes.

### 10. Promotion (`qa.promoteTestCases`, default `false`)

**When.** After `qa.mjs done` is a pass **and** `qa.mjs review status` is clean (both review steps at the QA head). Promotion is the last builder step before ship.

**What.** One or two UI cases (`qa.promote.maxPerTicket`, default 2) from the run, scored with a fixed rubric (bug reproduction +4; covers an acceptance criterion no existing test in the target folder covers +3; crosses a boundary such as screen to API +2; exercises code changed in this diff +1; depends on data CI does not have −3). API and worker cases are not promoted. The unit tests the implement phase wrote under TDD are already committed; the step confirms the diff contains at least one test file and says so in the PR, nothing more.

**Where.** `qa.promote.targets` is a named map in the project layer, for example `{ "web-e2e": { "kind": "web", "framework": "playwright", "dir": "e2e/promoted", "command": "yarn playwright test {files}" }, "mobile-e2e": { "kind": "mobile", "framework": "detox", "dir": "clients/mobile/__tests__/integration/promoted", "command": null } }`. `dir` must be inside the repository. A case is promoted to every target whose `kind` matches its profile; a kind with no target is skipped with the reason in the PR. Frameworks: `playwright` (adapt the spec to the repository's config, fixtures and helpers) and `detox` (rewrite the Maestro flow with the shipped step mapping in `skills/qa/maestro-to-detox.md`: launch, tap by id or text, type, assert visible or not, scroll until visible, wait with timeout, back; `runFlow` maps to the repository's own helper for that flow or the case is skipped; recording and screenshot steps are dropped; credentials come from the repository's Detox environment config). Any step with no mapping means the case is skipped with `no Detox equivalent for <step>`; nothing partial is ever committed. Before writing, the builder reads three neighbouring tests in `dir` and follows their naming, imports and testIDs.

**Running.** When `command` is set it runs on the new files; a red test is fixed or dropped. When it is `null` or the environment cannot run it (Detox without a built app), lint and typecheck still run on the files, and the PR line says `not run locally: <why>`.

**Committing.** One commit of the promoted files only, `Test: promote QA cases <slugs> [KEY]`, recorded in `.dev-factory/promoted.json` through `qa.mjs promote record`. `qa.mjs verify` accepts a head that differs from the QA head only by commits whose changed paths are all recorded promotions inside a target `dir` (a merge of the base is still allowed as today); any other change at the same head is refused as it is now.

**The factory reviews the promoted files (decided by the owner).** Promotion is its own hand-off, between the review and the ship dispatches, so the flow of a ticket with the setting on becomes: build → reviews → **promote → promoted review (→ fix)** → ship. In detail:

-   The scheduler dispatches the builder with `until: "promote"` after `review status` is clean. The builder scores, converts, runs, commits and records as above, then writes `.dev-factory/promoted.done` (the hand-off marker; `promote.done` already belongs to the AGENTS.md promoter) containing the new head, or `blocked.json`. With nothing worth promoting it still writes `promoted.done` with the unchanged head and the skipped cases, so the step is never silent. The stop gate accepts only those two files for `until: "promote"`; `worktree.mjs`'s `DONE_MARKERS` gains `promoted.done`.
-   The scheduler then dispatches `factory-reviewer` with axis `promoted` over only the files in `.dev-factory/promoted.json`, judging them against the target folder's conventions, the acceptance criterion the case covered and the mapping rules. `qa.mjs review record --axis promoted` accepts a head after the QA head when the difference is promotion-only (the same test `verify` applies); the "step 2 needs a clean step 1 at the same commit" rule stays for spec and standards and does not apply to `promoted`.
-   Critical or High findings: the builder is dispatched again with `until: "promote"` and the findings; it fixes or drops the file in another promotion-only commit, records it, and the `promoted` review runs again. `caps.maxFixRounds` bounds this as it bounds the other fix rounds.
-   `qa.mjs verify --require-review true` demands a clean `promoted` review at the head whenever `promoted.json` has entries, so ship cannot skip it. With the setting off, nothing above runs and `verify` behaves as today.
-   `/dev-factory:build` and `/dev-factory:quick` follow the same sequence.

**The PR body** gets a `## Promoted tests` section: one line per promoted file (case slug, file, `ran` or the note) and one per skipped case with its reason, or `promotion is off` when the setting is false.

### 11. Migration and compatibility

For one release the factory reads the legacy config, QA profile and case paths with a `note:` from `config validate` and `doctor`. `dev-factory migrate` moves them. Afterwards the legacy paths are removed from the code, in a separate ticket.

## Left to the builder

-   Exact row descriptions in `settings/options.json` (take them from the README tables).
-   The terminal rendering details (column widths, colours, how a long list value is shown).
-   The shape of `managed.json` beyond "ids per scope, per repository path for local".
-   How `settings set` names a secret (`secret:JIRA_API_TOKEN` or a `--secret` flag).
-   Test fixtures: a fake `claude` binary on `DF_CLAUDE_BIN` that logs its arguments and returns canned listings.
