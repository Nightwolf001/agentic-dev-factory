# User-level install, project-level config and a settings page: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the factory once per user, choose per tool whether it applies to every project (user level) or one project (project level), keep a project's factory files in one git-ignored `.devfactory/` folder, and let a person toggle options from a settings page in the terminal.

**Architecture:** Configuration becomes three layers merged in order: shipped defaults, the user's `<state>/config.json`, the project's `.devfactory/config.json`; environment variables still win. Each optional tool (MCP server, companion plugin, task source, boolean flag) is one entry in a settings registry with a scope of `off`, `user` or `project`; one library applies a change and records it, and both the `dev-factory settings` page and `/dev-factory:setup` call it. Old files (`dev-factory.config.json`, `dev-factory.qa.yaml`, the factory's servers in `.mcp.json`) keep working until `dev-factory migrate` moves them.

**Tech Stack:** Node (ES modules, no dependencies), bash 3.2, `node --test`, Prettier 3.2.5.

**Spec:** The request that started this plan (no separate spec file), restated as requirements:

1. Install the plugin at user level, not per repository.
2. Per tool (gh/task source, Notion, Playwright, and the rest of the catalog): set at user level (all projects) or project level (one project), decided when running setup.
3. Everything the factory adds to a project moves into one git-ignored `.devfactory/` folder.
4. A CLI settings page lists every available option and lets the person toggle each on or off for a project.

## Decisions made while planning (change them here, before building)

-   **Folder name is `.devfactory/`** exactly as requested. It sits beside two existing folders that stay as they are: `.dev-factory/` (per-run state inside a worktree) and `.factory/` (task files and QA cases, which are committed work product, so they cannot be git-ignored). The name lives in one constant (`PROJECT_DIR`), so renaming is one line plus docs.
-   **The folder ignores itself** with a `.gitignore` containing `*` inside it. Nothing in the repository's tracked files is edited, and it works in every worktree.
-   **Project-level MCP servers live in `.devfactory/mcp.json`.** Scheduled passes load it with `--mcp-config`. A plain interactive `claude` does not read it, so `dev-factory claude [args]` starts Claude with it. The alternative (keep writing a root `.mcp.json` and git-exclude it) works in plain `claude` but leaves a factory file outside the folder; say so if you prefer it.
-   **User-level MCP servers are registered with Claude at user scope** (`claude mcp add-json --scope user`), so every project and session sees them. The factory remembers which ones it added in `<state>/mcp-user.json`, so it never removes a server the person added themselves.
-   **A server has one scope.** Moving it from user to project removes the other registration. A server found in both places (hand-edited) counts as `project`, and the settings page marks the conflict.
-   **Cloud runs only see committed files.** `cloud init` prints the `git add -f` command for the three project files; it does not stage anything itself.

## Global Constraints

-   Shell scripts run on the macOS default bash 3.2: no `mapfile`, no associative arrays.
-   No dependencies: plain Node and bash; do not run `npm install` on the host.
-   Formatting: `npx prettier@3.2.5 --check "**/*.{md,json,mjs}"` passes; `bash scripts/lint-vocabulary.sh` passes; `claude plugin validate .` passes.
-   Every behavioural change to `scripts/config.mjs`, `scripts/guard-lib.mjs`, `scripts/guard-paths.mjs`, `scripts/worktree.mjs`, `scripts/mcp.mjs`, `scripts/cloud.mjs` and `bin/qa.mjs`, and every new script, has a test in `test/`; new scripts are added to the test list in `AGENTS.md`.
-   Commands, skills and agents call scripts as `node "${CLAUDE_PLUGIN_ROOT}/..."`; scripts find the plugin from their own location; no hard-coded `dev-factory/` path (`test/packaging.test.mjs`).
-   Shared defaults in `config.json` carry no organisation; secrets only in `~/.dev-factory/.env.local`; a repository file cannot grant `cleanup.takeover`.
-   Documentation shows only real subcommands (`test/docs.test.mjs`); README stays in step with commands, scripts and the flow.
-   Version: `0.15.0` becomes `0.16.0` in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` together. Minor, because the plugin is below 1.0 and a moved config location is a breaking change in spirit, but the old files still work, so nothing breaks today.

## Review Focus

The inputs the request implies but no obvious test covers; each is pinned by a test in the task named.

1.  A project that has only the old files (no `.devfactory/`): everything still works, and `migrate` run twice leaves edited new files alone. (Tasks 1, 6)
2.  A ticket worktree in a different folder sees the project's config and MCP file, and a ticket cannot edit them. (Task 2)
3.  A server present at both user and project scope: one scope wins, nothing is registered twice. (Task 3)
4.  `claude` missing or failing during a toggle: nothing is recorded, the error names the command. (Task 4)
5.  `dev-factory settings` with no terminal (a pipe, cron): prints the list and exits instead of waiting for keys. Malformed `.devfactory/config.json` names the file instead of a stack trace. (Tasks 1, 5)

## File Structure

| File                                                                                                                               | Responsibility                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `scripts/project-dir.mjs` (new)                                                                                                    | Where a project's and the user's factory files are, and the legacy names                         |
| `scripts/config.mjs` (modify)                                                                                                      | Three-layer load, `files` subcommand, origin of each layer                                       |
| `scripts/worktree.mjs`, `scripts/guard-lib.mjs`, `scripts/guard-paths.mjs`, `bin/qa.mjs` (modify)                                  | Carry `.devfactory/` into a worktree, keep tickets out of it, read `qa.yaml` from it             |
| `scripts/mcp.mjs`, `scripts/tick.sh`, `scripts/improve.sh`, `scripts/doctor.sh`, `scripts/factory-settings.mjs` (modify)           | Project MCP file, scopes, `--mcp-config` for every file in use                                   |
| `scripts/settings-lib.mjs` (new)                                                                                                   | The registry of options and `listItems` / `setItem`: the one place a toggle is applied           |
| `scripts/settings.mjs`, `scripts/settings-tui.mjs` (new)                                                                           | `settings list/set` and the interactive page (pure render and key handling, thin terminal shell) |
| `scripts/project-init.mjs` (new)                                                                                                   | `init` (create the folder) and `migrate` (move the old files)                                    |
| `scripts/cli.mjs`, `bin/dev-factory`, `scripts/install.sh`, `scripts/cloud.mjs`, `scripts/wizard.sh`, `commands/setup.md` (modify) | New subcommands, user-level install, setup asks the scope, cloud hint                            |
| `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, manifests (modify)                                                                    | Documentation and version                                                                        |

---

### Task 1: Where files live, and three-layer configuration

**Files:**

-   Create: `scripts/project-dir.mjs`, `test/project-dir.test.mjs`
-   Modify: `scripts/config.mjs` (`findRepoConfig`, `load`, new `configFiles`, `files` subcommand), `test/config.test.mjs`

**Interfaces:**

-   Produces, in `scripts/project-dir.mjs`:
    -   `PROJECT_DIR = '.devfactory'`, `PROJECT_FILES = { config: 'config.json', qa: 'qa.yaml', mcp: 'mcp.json' }`, `LEGACY_FILES = { config: 'dev-factory.config.json', qa: 'dev-factory.qa.yaml', mcp: '.mcp.json' }`
    -   `findProjectRoot(from?: string): string | null`: nearest directory at or above `from` that holds `.devfactory/` or a legacy config file.
    -   `projectPath(kind, root): string`: where a file is written, `<root>/.devfactory/<name>`.
    -   `projectFile(kind, root): { path: string, legacy: boolean } | null`: the file that exists, new location first, then legacy.
    -   `userDir(env?): string` (`DF_STATE_DIR` or `~/.dev-factory`) and `userFile('config' | 'mcp', env?): string` (`<state>/config.json`, `<state>/mcp-user.json`).
-   Produces, in `scripts/config.mjs`: `load()` with no argument returns `merge(merge(defaults, userLayer), projectLayer)`; `configFiles(from?, env?): Array<{ layer: 'defaults' | 'user' | 'project', path: string, legacy: boolean, exists: boolean }>`. `findRepoConfig` keeps its signature and now returns the project config path (new or legacy). `DF_CONFIG` still names the project file. `load(file)` with an explicit file is unchanged.

-   [ ] **Step 1: Write the failing tests**

`test/project-dir.test.mjs`:

-   `projectFile prefers .devfactory/config.json over dev-factory.config.json` (both exist: `legacy === false`).
-   `projectFile falls back to the legacy file and says so` (`legacy === true`); returns `null` when neither exists.
-   `findProjectRoot walks up from a subfolder and finds a root that has only the legacy file`.
-   `userFile follows DF_STATE_DIR`.

`test/config.test.mjs` (new tests; leave the existing legacy-file tests as they are, they now prove the fallback):

-   `the user layer sits between the defaults and the project`: user `{"caps":{"maxOpenPrs":7},"tasks":{"source":"github"}}`, project `{"tasks":{"source":"local"}}` → `get('caps.maxOpenPrs') === 7`, `get('tasks.source') === 'local'`, `get('tasks.label') === 'dev-factory'`.
-   `environment variables still beat both layers` (`DF_TASK_SOURCE=github` over a project `local`).
-   `a user file alone configures a project that has none`.
-   `malformed JSON names the file`: `assert.throws(() => load(), /config\.json: not valid JSON/)` for `.devfactory/config.json` containing `{ nope`.
-   `configFiles lists defaults, user and project in merge order and marks a legacy project file`.
-   `config.mjs files prints one line per layer` (spawn the script with a temp cwd and `DF_STATE_DIR`).

-   [ ] **Step 2: Run to verify they fail**

Run: `node --test test/project-dir.test.mjs test/config.test.mjs`
Expected: FAIL (`project-dir.mjs` missing, user layer ignored).

-   [ ] **Step 3: Implement `scripts/project-dir.mjs` and the config changes**

`load` reads each layer with a helper that throws `Error(`${file}: not valid JSON (${message})`)`; a missing user file is an empty layer. `scripts/config.mjs files` prints `<layer>\t<path>\t<present|absent|legacy>`.

-   [ ] **Step 4: Run to verify they pass, then the whole config suite**

Run: `node --test test/project-dir.test.mjs test/config.test.mjs`
Expected: PASS.

-   [ ] **Step 5: Commit**

```bash
git add scripts/project-dir.mjs scripts/config.mjs test/project-dir.test.mjs test/config.test.mjs
git commit -m "feat: layer user config between the defaults and the project's .devfactory/config.json"
```

---

### Task 2: Carry `.devfactory/` into worktrees, keep tickets out of it, read `qa.yaml` from it

**Files:**

-   Modify: `scripts/worktree.mjs` (`LOCAL_FILES`, `copyLocalFiles`), `scripts/guard-lib.mjs` (~lines 885-935), `scripts/guard-paths.mjs` (~lines 350-375), `bin/qa.mjs` (`profilesFile`, ~line 499)
-   Test: `test/worktree.test.mjs`, `test/guard.test.mjs`, `test/qa.test.mjs`

**Interfaces:**

-   Consumes: `projectFile`, `PROJECT_DIR`, `LEGACY_FILES` from Task 1.
-   Produces: `copyLocalFiles(repo, dest)` copies the whole `.devfactory/` folder (every file in it) plus any legacy file that exists, returns the relative names copied; `profilesFile(root)` returns `.devfactory/qa.yaml`, else `dev-factory.qa.yaml`, else the plugin's `qa/profiles.yaml`.

-   [ ] **Step 1: Write the failing tests**

    -   worktree: `a new worktree gets .devfactory/ from the main checkout and git ignores it` (create `.devfactory/config.json`, `mcp.json` and `.gitignore` containing `*` in the repo, add a worktree, assert the files exist there and `git status --porcelain` is empty); `a .devfactory file the branch tracks is left alone`; `a repository with only the legacy files still gets them copied`.
    -   guard: `a ticket cannot write .devfactory/config.json, qa.yaml or mcp.json` (deny, reason mentions it sets what the factory allows); `a ticket cannot remove the .devfactory folder` (`runStateRoot` true for `.devfactory`); the improver role is denied the same way; reads are unaffected.
    -   qa: `qa.yaml in .devfactory replaces the default profiles`, `the legacy dev-factory.qa.yaml is still read`, `.devfactory wins when both exist`.

-   [ ] **Step 2: Run to verify they fail**

Run: `node --test test/worktree.test.mjs test/guard.test.mjs test/qa.test.mjs`
Expected: FAIL on the new tests only.

-   [ ] **Step 3: Implement**

    -   `copyLocalFiles`: copy `.devfactory/` recursively unless the branch tracks `.devfactory/config.json`; keep the existing legacy copy and `exclude` call.
    -   `guard-lib.mjs`: extend the file-name test that guards `dev-factory.config.json` to any path whose first component is `.devfactory`; add `.devfactory` to the `protectedPath` pattern.
    -   `guard-paths.mjs`: add `['.devfactory']` to the protected places and `'.devfactory'` to the `runStateRoot` names.
    -   `bin/qa.mjs`: `profilesFile` uses `projectFile('qa', root)`.

-   [ ] **Step 4: Run to verify they pass**

Run: `node --test test/worktree.test.mjs test/guard.test.mjs test/guard-hardening.test.mjs test/guard-machine.test.mjs test/qa.test.mjs`
Expected: PASS.

-   [ ] **Step 5: Commit** `feat: carry and protect the .devfactory folder in worktrees`

---

### Task 3: Project MCP file, scopes, and `--mcp-config` for every file in use

**Files:**

-   Modify: `scripts/mcp.mjs`, `scripts/factory-settings.mjs`, `scripts/tick.sh` (~line 56), `scripts/improve.sh` (~line 29), `scripts/doctor.sh` (~line 124)
-   Test: `test/mcp.test.mjs`, `test/preflight.test.mjs` or a new `test/mcp-files.test.mjs` for the shell wiring

**Interfaces:**

-   Consumes: `projectPath`, `projectFile`, `userFile` (Task 1).
-   Produces, in `scripts/mcp.mjs`:
    -   `mcpFile(root, env?): string`: `.devfactory/mcp.json` (the file `enable` and `disable` write; `DF_MCP_FILE` still overrides).
    -   `scopeOf(id, { projectFile, userRecord, listing }): 'project' | 'user' | 'external' | null` (project wins when both hold it).
    -   `legacyServers(root): string[]`: catalog ids found in a root `.mcp.json`.
    -   `mcp.mjs config-files`: prints, one per line, the existing files a pass must load: `.devfactory/mcp.json`, then a root `.mcp.json` if present.
    -   `enable` and `disable` keep their signatures; `mcp.mjs enable|disable ID... [--scope project]` (user scope is applied by Task 4, not here).
-   `tick.sh` and `improve.sh` build `MCP_ARGS` from `config-files` with a `while read` loop (bash 3.2); `factory-settings.mjs` defaults `mcpFile` to the project file; `doctor.sh` reads the same file and warns, for each id from `legacyServers`, `MCP <id> is still in .mcp.json: run dev-factory migrate`.

-   [ ] **Step 1: Write the failing tests**

    -   `enable writes .devfactory/mcp.json, creating the folder with its self-ignoring .gitignore` (content `*\n`).
    -   `config-files lists the project file first and a root .mcp.json second, only when they exist`.
    -   `scopeOf: a server in both the project file and the user record is project` (Review Focus 3); `a server only in the claude listing is external`.
    -   `legacyServers finds catalog servers in .mcp.json and ignores the person's own`.
    -   `factory-settings allows the servers in .devfactory/mcp.json` (existing test at `test/mcp.test.mjs:220` adjusted to the new default file).
    -   shell: run `tick.sh`'s argument builder against a temp repo with both files (extract it as `scripts/mcp-args.sh`, sourced by both scripts, if that is the only way to test it) and assert `--mcp-config` appears twice, in that order.

-   [ ] **Step 2: Run to verify they fail**

Run: `node --test test/mcp.test.mjs test/mcp-files.test.mjs`
Expected: FAIL.

-   [ ] **Step 3: Implement** the interfaces above. The self-ignoring `.gitignore` is created by a shared `ensureProjectDir(root): string` exported from `scripts/project-dir.mjs` (add it with its own test in `test/project-dir.test.mjs`); `enable` calls it.

-   [ ] **Step 4: Run to verify they pass**

Run: `node --test test/mcp.test.mjs test/mcp-files.test.mjs test/project-dir.test.mjs test/preflight.test.mjs`
Expected: PASS.

-   [ ] **Step 5: Commit** `feat: keep project MCP servers in .devfactory/mcp.json`

---

### Task 4: The settings registry and the one place a toggle is applied

**Files:**

-   Create: `scripts/settings-lib.mjs`, `test/settings-lib.test.mjs`

**Interfaces:**

-   Consumes: `catalog()`, `enable`, `disable`, `scopeOf`, `parseListing` (Task 3 / `mcp.mjs`); `plugins.json`; `load`, `userFile`, `projectPath`, `ensureProjectDir`.
-   Produces:
    -   `type Scope = 'off' | 'user' | 'project'`
    -   `type Item = { id: string, kind: 'mcp' | 'plugin' | 'source' | 'flag', title: string, purpose: string, without?: string, scope: Scope | 'external' | 'default', value?: unknown, options?: string[], conflict?: boolean }`
    -   ids: `mcp:<catalog id>`, `plugin:<plugins.json id>`, `source` (config path `tasks.source`, options `SOURCES`), `flag:<dotted path>` for exactly these booleans: `review.bugbot`, `git.agentAttribution`, `tasks.unblockOnPr`, `blocked.agentDecides`.
    -   `type Ctx = { root: string, env?: object, run(cmd: string, args: string[]): { status: number, stdout: string, stderr: string }, listing?: string }`
    -   `listItems(ctx): Item[]`: every option, with where it is currently on.
    -   `setItem(id: string, change: { scope: Scope, value?: unknown }, ctx): { changed: boolean, message: string }`.
-   Behaviour pinned by the spec:

    -   MCP `user`: `ctx.run('claude', ['mcp','add-json','--scope','user', id, JSON.stringify(config)])`, then record in `mcp-user.json`; `project`: `enable` into `.devfactory/mcp.json`; `off`: undo whichever scope the item has, removing a user registration only if it is in `mcp-user.json`; an `external` server is never removed. Moving between scopes undoes the other first.
    -   Plugin `user`: `claude plugin install <id> --scope user`; `project`: `--scope local` (private to this project, not committed); `off`: `claude plugin uninstall <id>`. **Verify the exact `uninstall` flags with `claude plugin uninstall --help` before writing the call.**
    -   `source` and `flag` write the value into `<state>/config.json` (`user`) or `.devfactory/config.json` (`project`); `off` on a flag writes `false`; a source has no `off`.
    -   The side effect runs first and the record is written only when it succeeds; a non-zero `status` throws `Error('claude mcp add-json failed: <stderr>')` naming the command, leaving files unchanged.

-   [ ] **Step 1: Write the failing tests** (a recorder `run` collects calls; temp dirs for root and state)

    -   `listItems has one entry per catalog server, companion plugin, the source and the four flags`.
    -   `an MCP server is off, then project after setItem project, with the server written to .devfactory/mcp.json and no claude call`.
    -   `user scope calls claude mcp add-json --scope user and records the id in mcp-user.json`.
    -   `moving a server from user to project removes the user registration first`.
    -   `a server the person added to claude themselves is external and off does not remove it`.
    -   `a failing claude call leaves every file unchanged and the error names the command` (Review Focus 4).
    -   `a flag set at project scope lands in .devfactory/config.json and wins over the user value`.
    -   `a plugin at project scope installs with --scope local`.
    -   `an unknown id throws and lists the valid ones`.

-   [ ] **Step 2: Run to verify they fail**

Run: `node --test test/settings-lib.test.mjs`
Expected: FAIL (module missing).

-   [ ] **Step 3: Implement** `listItems` and `setItem` as above. Config writes read the file, set the dotted path, and write it back with tab indentation like `mcp.mjs` does.

-   [ ] **Step 4: Run to verify they pass**

Run: `node --test test/settings-lib.test.mjs`
Expected: PASS.

-   [ ] **Step 5: Commit** `feat: add the settings registry`

---

### Task 5: `dev-factory settings`: the list, `set`, and the interactive page

**Files:**

-   Create: `scripts/settings.mjs`, `scripts/settings-tui.mjs`, `test/settings.test.mjs`
-   Modify: `scripts/cli.mjs` (`COMMANDS.settings = ['node', 'scripts/settings.mjs']`, header comment), `test/entry.test.mjs` if it lists commands

**Interfaces:**

-   Consumes: `listItems`, `setItem`, `Item`, `Ctx` (Task 4).
-   Produces:

    -   `settings.mjs list [--json]`; `settings.mjs set <id> on|off [--scope user|project]` (`on` without `--scope` means project; `set source <name>` and `set flag:<path> true|false` follow the same form); `settings.mjs` with no arguments opens the page on a terminal and behaves as `list` otherwise.
    -   In `settings-tui.mjs`: `render(items: Item[], cursor: number, status: string): string` (grouped by kind, a `[x]`/`[ ]` box, the scope word, one line of purpose for the item under the cursor, and the keys), and `onKey(state: { items, cursor, status }, key: string): { state, action?: { id: string, change: { scope: Scope } } }` where `up`/`down` move, `space` toggles off ↔ project (or off ↔ the item's last scope), `u` sets user, `p` sets project, `q` quits. The terminal shell reads raw keys, applies the returned action through `setItem` straight away, refreshes the list, and shows the result in `status`.

-   [ ] **Step 1: Write the failing tests**

    -   `render shows every item with its scope and the purpose of the selected one` (snapshot of a three-item list as exact lines).
    -   `onKey: down moves, space on an off item asks for project, space on an on item asks for off, u asks for user`.
    -   `onKey never moves past the first or last item`.
    -   `list --json prints the items` (spawn with a temp root and state).
    -   `set mcp:playwright on --scope project writes .devfactory/mcp.json` (spawn; a stub `claude` first on `PATH` that fails the test if called).
    -   `with no terminal, settings prints the list and exits 0` (spawn with stdin closed; assert it ends, Review Focus 5).
    -   `set with an unknown id exits 1 and names the valid ids`.

-   [ ] **Step 2: Run to verify they fail**

Run: `node --test test/settings.test.mjs`
Expected: FAIL.

-   [ ] **Step 3: Implement.** Raw mode via `process.stdin.setRawMode(true)` and `readline.emitKeypressEvents`; restore the terminal on exit and on SIGINT. No dependencies.

-   [ ] **Step 4: Run to verify they pass**

Run: `node --test test/settings.test.mjs test/entry.test.mjs`
Expected: PASS.

-   [ ] **Step 5: Commit** `feat: add the dev-factory settings page`

---

### Task 6: `init` and `migrate`

**Files:**

-   Create: `scripts/project-init.mjs`, `test/project-init.test.mjs`
-   Modify: `scripts/cli.mjs` (`init`, `migrate` entries)

**Interfaces:**

-   Consumes: `ensureProjectDir`, `projectPath`, `projectFile`, `LEGACY_FILES` (Tasks 1, 3); `legacyServers`, `enable`, `disable` (Task 3).
-   Produces: `init(root): { created: string[] }` makes `.devfactory/` with its `.gitignore` and an empty `config.json` (`{}`) if none exists; `migrate(root, { dryRun }): { moved: Array<{ from: string, to: string }>, skipped: string[] }`:

    -   `dev-factory.config.json` → `.devfactory/config.json`, `dev-factory.qa.yaml` → `.devfactory/qa.yaml`;
    -   catalog servers in a root `.mcp.json` → `.devfactory/mcp.json` (the person's own servers stay, and the file is deleted only if it ends up with no servers);
    -   a destination that already exists is never overwritten: it is listed in `skipped`;
    -   git-tracked sources are moved with `git rm --cached`'s effect left to the person: print a note that the old file is still tracked and should be removed in a commit.

-   [ ] **Step 1: Write the failing tests**

    -   `init creates the folder, the self-ignoring .gitignore and an empty config, and a second run changes nothing`.
    -   `migrate moves the legacy config and qa files`.
    -   `migrate moves only catalog servers out of .mcp.json and keeps the person's own` (Review Focus 1).
    -   `migrate twice, with the new file edited in between, keeps the edit` (skipped, not overwritten).
    -   `migrate --dry-run changes nothing and lists what it would do`.
    -   `migrate notes a tracked source file`.

-   [ ] **Step 2: Run to verify they fail**

Run: `node --test test/project-init.test.mjs`
Expected: FAIL.

-   [ ] **Step 3: Implement** the two functions and the CLI wrapper (`project-init.mjs init|migrate [--dry-run]`).

-   [ ] **Step 4: Run to verify they pass**

Run: `node --test test/project-init.test.mjs`
Expected: PASS.

-   [ ] **Step 5: Commit** `feat: add init and migrate for the .devfactory folder`

---

### Task 7: User-level install, setup that asks the scope, the `claude` wrapper, cloud hint

**Files:**

-   Modify: `scripts/install.sh`, `scripts/cli.mjs` (`claude` entry), `scripts/cloud.mjs`, `scripts/wizard.sh`, `commands/setup.md`
-   Create: `scripts/claude-wrapper.sh`
-   Test: `test/install.test.mjs` (new), `test/cloud.test.mjs`, `test/commands.test.mjs`, `test/entry.test.mjs`

**Interfaces:**

-   Consumes: `settings.mjs set` (Task 5), `project-init.mjs init|migrate` (Task 6), `config-files` (Task 3).
-   Produces:

    -   `install.sh [--apply] [--load] [--user-only] [--plugin-scope user|local]`: companion plugins install with `--scope user` by default (`local` on request); `--user-only` does the launcher, the state `.env.local` and the plugins, and skips the repository checks, the doctor run and the scheduler, so it works outside any repository.
    -   `claude-wrapper.sh` (`dev-factory claude [args]`): `exec claude` with one `--mcp-config <file>` per line of `mcp.mjs config-files`, then the given args; with no files it passes none.
    -   `cloud.mjs init` additionally prints `git add -f .devfactory/config.json .devfactory/qa.yaml .devfactory/mcp.json` for the files that exist, with the reason (a cloud checkout has only committed files).
    -   `commands/setup.md` steps: look; `init` (and `migrate` when old files exist, asking first); for each choice ask **"every project, or only this one?"** with a recommendation and apply it with `settings.mjs set ... --scope`; the task source and companion plugins are asked the same way; finish by pointing at `dev-factory settings` for later changes. The text no longer names `dev-factory.config.json` or `.mcp.json` as where things are written.
    -   `wizard.sh` and the doctor mention `.devfactory/config.json`.

-   [ ] **Step 1: Write the failing tests**

    -   install (stub `claude` first on `PATH` recording calls, temp `DF_STATE_DIR`, cwd outside any git repository): `--user-only works outside a repository`, `companion plugins install with --scope user by default`, `--plugin-scope local installs with --scope local`, `a plugin that fails to install fails the run after the others were tried` (existing behaviour kept).
    -   wrapper: `claude gets one --mcp-config per existing project MCP file, then the caller's arguments` (stub `claude` echoing its argv).
    -   cloud: `init prints the git add -f command for the project files that exist and stages nothing` (`git status --porcelain` shows no staged `.devfactory` file).
    -   commands: `setup.md names .devfactory and the scope question, and no longer tells a person to write dev-factory.config.json`; the existing frontmatter checks still pass.

-   [ ] **Step 2: Run to verify they fail**

Run: `node --test test/install.test.mjs test/cloud.test.mjs test/commands.test.mjs test/entry.test.mjs`
Expected: FAIL on the new tests.

-   [ ] **Step 3: Implement.** In `install.sh`, only the plugin-scope string, the new flags and an early `exit 0` after the plugin section for `--user-only` change; keep every other step as it is.

-   [ ] **Step 4: Run to verify they pass**

Run: `node --test test/install.test.mjs test/cloud.test.mjs test/commands.test.mjs test/entry.test.mjs test/runtime.test.mjs`
Expected: PASS.

-   [ ] **Step 5: Commit** `feat: install once per user and let setup choose user or project scope`

---

### Task 8: Documentation, test list, version, and the final checks

**Files:**

-   Modify: `README.md` (Quick start, a "Where settings live" section under Configuration, Layout, Cloud and Claude environments, the command table), `AGENTS.md` (rule about state, the test list, the "Where things are" table), `CONTRIBUTING.md` (state-location line), `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `test/docs.test.mjs` (remove the exclusion of this plan added when it was committed)

-   [ ] **Step 1: Write the failing tests** in `test/readme.test.mjs`: `the README documents .devfactory, settings, init, migrate and claude` (each string appears in `README.md`), and `AGENTS.md names every new script` (`project-dir.mjs`, `settings-lib.mjs`, `settings.mjs`, `settings-tui.mjs`, `project-init.mjs`). Run `node --test test/readme.test.mjs`; expected: FAIL.

-   [ ] **Step 2: Update the documents.** README: install once with `--scope user`; the three layers and which keys suit which layer; the `.devfactory/` contents; the folder-name note (`.devfactory/` vs `.dev-factory/` vs `.factory/`); the scope rule for MCP servers and plugins; `dev-factory settings`; `dev-factory claude`; migration from the old files; cloud needs `git add -f`. AGENTS.md: replace "State for the project goes in `.factory/` and `dev-factory.config.json`" with `.devfactory/` and `.factory/` (task files and QA cases); add `scripts/project-dir.mjs`, `scripts/settings-lib.mjs`, `scripts/settings.mjs`, `scripts/settings-tui.mjs`, `scripts/project-init.mjs` to the test-required list and the map.

-   [ ] **Step 3: Bump both manifests to `0.16.0`.**

-   [ ] **Step 4: Run every check**

```bash
node --test test/*.test.mjs
npx prettier@3.2.5 --check "**/*.{md,json,mjs}"
bash scripts/lint-vocabulary.sh
claude plugin validate .
```

Expected: all pass. Fix with `npx prettier@3.2.5 --write` where Prettier is the only failure.

-   [ ] **Step 5: Commit** `docs: describe user-level install and the .devfactory folder; release 0.16.0`

---

## Self-review

-   **Spec coverage:** 1 install per user: Task 7 (`--scope user`, `--user-only`) plus Task 8 docs. 2 scope per tool at setup: Tasks 4 and 7. 3 one git-ignored folder: Tasks 1, 2, 3, 6. 4 settings page: Tasks 4 and 5. Cloud and worktree consequences of ignoring the folder: Tasks 2 and 7.
-   **Types:** `Scope`, `Item`, `Ctx`, `projectFile`, `projectPath`, `ensureProjectDir`, `scopeOf`, `legacyServers` are defined once (Tasks 1, 3, 4) and used under the same names later.
-   **Proportion:** the request is four sentences; the plan holds signatures, test names and the values the request fixes, not function bodies.
-   **Left to the implementer on purpose:** the exact column layout of the page, the wording of messages other than the ones quoted, and how `claude plugin uninstall` takes a scope (verify first, Task 4).
