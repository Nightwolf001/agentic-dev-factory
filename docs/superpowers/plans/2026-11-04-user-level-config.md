# User-level install, project-level settings and a settings page: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the factory once per user, give each optional tool a scope (`off`, `user`, `project`, or `shared` for what must stay committed), keep a project's factory files in one git-ignored `.devfactory/` folder, and let a person toggle options from a settings page in the terminal.

**Architecture:** Configuration is three layers merged in order: shipped defaults, the user's `~/.dev-factory/config.json`, the project's `.devfactory/config.json`; environment variables still win. MCP servers and plugins are registered through Claude Code's own scopes (`claude mcp add-json -s user|local|project`, `claude plugin install --scope user|local|project`), and the factory records what it registered in a machine file, `~/.dev-factory/registrations.json`, keyed by checkout path. One library, `scripts/settings-lib.mjs`, lists the options and applies a change; the page, `settings set`, `/dev-factory:setup`, `dev-factory mcp enable` and `migrate` all go through it. Old files keep working until `dev-factory migrate` moves them.

**Tech Stack:** Node 20 (ES modules, no dependencies), bash 3.2, `node --test`, Prettier 3.2.5.

**Spec:** `docs/superpowers/specs/2026-11-04-user-level-config-design.md`. Read it first; the "How Claude Code stores these things" table and the nine flagged decisions are the ground every task stands on.

## Global Constraints

-   Shell scripts run on the macOS default bash 3.2: no `mapfile`, no associative arrays.
-   No dependencies: plain Node 20 and bash; do not run `npm install` on the host.
-   `npx prettier@3.2.5 --check "**/*.{md,json,mjs}"`, `bash scripts/lint-vocabulary.sh` and `claude plugin validate .` pass.
-   Every behavioural change to `scripts/config.mjs`, `scripts/guard-lib.mjs`, `scripts/guard-paths.mjs`, `scripts/worktree.mjs`, `scripts/mcp.mjs`, `scripts/factory-settings.mjs`, `scripts/cloud.mjs`, `scripts/jira-mcp-config.mjs` and `bin/qa.mjs`, and every new script, has a test in `test/`; new scripts join the test list in `AGENTS.md`.
-   The test command becomes `node --test --import ./test/setup.mjs test/*.test.mjs` everywhere it is written (AGENTS.md, CONTRIBUTING.md, README), so no test reads the developer's own user file.
-   Scripts find the plugin from their own location (`scripts/plugin-root.mjs`); nothing assumes the plugin sits inside the repository it works on; commands call scripts as `node "${CLAUDE_PLUGIN_ROOT}/..."`.
-   Nothing in the plugin names a company, tracker site, project key or host. Secrets only in `~/.dev-factory/.env.local`. A repository file cannot grant `cleanup.takeover`.
-   The factory never removes an MCP server or plugin it did not record, never stages or commits without saying so, and a ticket run never edits `.devfactory/`.
-   Version `0.15.0` → `0.16.0` in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` together (minor: new behaviour and a changed default for `mcp enable`, old files still work).

## Review Focus

The inputs the spec implies but no obvious test covers; each is pinned by a test in the task named.

1.  A project with only the old files, and `migrate` run twice with the new file edited in between: everything still works and the edit survives. (Tasks 1, 6)
2.  A `.mcp.json` entry a person edited (a pinned version, an extra flag) is re-registered as it stands by `migrate`, not replaced by the catalog's config. (Task 6)
3.  `off` on a server or plugin the factory did not record (external, or the person's own install) changes nothing in Claude and says why. (Task 4)
4.  A `claude` command that fails or is missing during a toggle: no record is written, the error names the command and its stderr. (Task 4)
5.  `dev-factory settings` with no terminal (a pipe, cron, the Bash tool of a Claude session) prints the list and exits 0; malformed `.devfactory/config.json` names the file instead of a stack trace. (Tasks 1, 5)

## File Structure

| File                                                                                                                               | Responsibility                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `scripts/project-dir.mjs` (new)                                                                                                    | Where a project's and the user's factory files are, the legacy names, `ensureProjectDir` |
| `scripts/config.mjs` (modify), `test/setup.mjs` (new)                                                                              | Three-layer load, `DF_USER_CONFIG`, `files` subcommand; test isolation                   |
| `scripts/worktree.mjs`, `scripts/guard-lib.mjs`, `scripts/guard-paths.mjs`, `bin/qa.mjs` (modify)                                  | Carry `.devfactory/` into a worktree, keep tickets out of it, read `qa.yaml` from it     |
| `scripts/registrations.mjs` (new)                                                                                                  | Read, write and prune `~/.dev-factory/registrations.json`                                |
| `scripts/mcp.mjs`, `mcp/catalog.json`, `scripts/jira-mcp-config.mjs`, `scripts/factory-settings.mjs`, `scripts/doctor.sh` (modify) | Scoped register/unregister, catalog placeholders, the `jira` entry, every source counted |
| `scripts/settings-lib.mjs` (new)                                                                                                   | The registry of options: `listItems`, `setItem`                                          |
| `scripts/settings.mjs`, `scripts/settings-tui.mjs` (new)                                                                           | `settings list/set` and the page (pure render and key handling, thin terminal shell)     |
| `scripts/project-init.mjs` (new)                                                                                                   | `init` and `migrate`                                                                     |
| `scripts/cli.mjs`, `scripts/install.sh`, `scripts/cloud.mjs`, `scripts/wizard.sh`, `commands/setup.md` (modify)                    | New subcommands, user-level install, setup asks the scope, cloud stages the forced add   |
| `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.env.example`, `qa/profiles.yaml`, `skills/task-source/jira.md`, manifests (modify)  | Documentation, test command, version                                                     |

---

### Task 1: Where files live, three-layer configuration, test isolation

**Files:**

-   Create: `scripts/project-dir.mjs`, `test/project-dir.test.mjs`, `test/setup.mjs`
-   Modify: `scripts/config.mjs` (`findRepoConfig`, `load`, new `configFiles`, `files` subcommand), `test/config.test.mjs`, `AGENTS.md` and `CONTRIBUTING.md` (the test command only; the rest of the docs is Task 8)

**Interfaces:**

-   Produces, in `scripts/project-dir.mjs`:
    -   `PROJECT_DIR = '.devfactory'`, `PROJECT_FILES = { config: 'config.json', qa: 'qa.yaml' }`, `LEGACY_FILES = { config: 'dev-factory.config.json', qa: 'dev-factory.qa.yaml' }`
    -   `findProjectRoot(from = process.cwd()): string | null`: nearest directory at or above `from` holding `.devfactory/` or a legacy file.
    -   `projectPath(kind: 'config' | 'qa', root: string): string` → `<root>/.devfactory/<name>`.
    -   `projectFile(kind, root): { path: string, legacy: boolean } | null`: the file that exists, new location first.
    -   `ensureProjectDir(root): string`: creates `.devfactory/` and a `.gitignore` holding `*\n` if absent; returns the folder.
    -   `userDir(env = process.env): string` (`DF_STATE_DIR` or `~/.dev-factory`); `userConfigFile(env): string | null` (`DF_USER_CONFIG` when set, `''` → `null`; else `<userDir>/config.json`).
-   Produces, in `scripts/config.mjs`: `load()` (no argument) returns `merge(merge(defaults, user), project)`; `configFiles(from?, env?): Array<{ layer: 'defaults' | 'user' | 'project', path: string | null, exists: boolean, legacy: boolean }>`; `findRepoConfig` keeps its signature and returns the project file (new or legacy); `DF_CONFIG` still replaces the project layer; `load(file)` is unchanged. A layer that is not valid JSON throws `Error(`${file}: not valid JSON (${reason})`)`.
-   `test/setup.mjs` sets `process.env.DF_STATE_DIR` to a fresh `mkdtemp` folder and `process.env.DF_USER_CONFIG = ''` when they are unset; spawned scripts inherit both.

-   [ ] **Step 1: Write the failing tests**

`test/project-dir.test.mjs`: `projectFile prefers .devfactory/config.json over dev-factory.config.json`; `projectFile falls back to the legacy file and marks it`; `projectFile is null when neither exists`; `findProjectRoot walks up from a subfolder to a root that has only the legacy file`; `ensureProjectDir writes a self-ignoring .gitignore once and leaves an existing one alone`; `userConfigFile follows DF_STATE_DIR and an empty DF_USER_CONFIG disables it`.

`test/config.test.mjs` (keep the existing legacy-file tests; they now prove the fallback): `the user layer sits between the defaults and the project` (user `{"caps":{"maxOpenPrs":7},"tasks":{"source":"github"}}`, project `{"tasks":{"source":"local"}}` → `get('caps.maxOpenPrs') === 7`, `get('tasks.source') === 'local'`, `get('tasks.label') === 'dev-factory'`); `environment variables beat both layers` (`DF_TASK_SOURCE=github`); `a user file alone configures a project that has none`; `malformed JSON names the file` (`assert.throws(() => load(), /config\.json: not valid JSON/)`); `configFiles lists the layers in merge order and marks a legacy project file`; `config.mjs files prints one line per layer` (spawn with a temp cwd and `DF_STATE_DIR`).

-   [ ] **Step 2: Run to verify they fail**

Run: `node --test test/project-dir.test.mjs test/config.test.mjs`
Expected: FAIL (module missing; user layer ignored).

-   [ ] **Step 3: Implement** `scripts/project-dir.mjs`, the `load`/`configFiles` changes, `config.mjs files` (prints `<layer>\t<path>\t<present|absent|legacy>`), and `test/setup.mjs`. Change the test command in `AGENTS.md` and `CONTRIBUTING.md` to `node --test --import ./test/setup.mjs test/*.test.mjs`.

-   [ ] **Step 4: Run to verify they pass, then the whole suite with the new command**

Run: `node --test --import ./test/setup.mjs test/*.test.mjs`
Expected: PASS (the existing tests still pass with the user layer disabled by `setup.mjs`).

-   [ ] **Step 5: Commit** `feat: layer a user config between the defaults and the project's .devfactory/config.json`

---

### Task 2: Carry `.devfactory/` into worktrees, keep tickets out of it, read `qa.yaml` from it

**Files:**

-   Modify: `scripts/worktree.mjs` (`LOCAL_FILES`, `copyLocalFiles`), `scripts/guard-lib.mjs` (~lines 885-935), `scripts/guard-paths.mjs` (~lines 350-375), `bin/qa.mjs` (`profilesFile`, ~line 499)
-   Test: `test/worktree.test.mjs`, `test/guard.test.mjs`, `test/guard-machine.test.mjs`, `test/qa.test.mjs`

**Interfaces:**

-   Consumes: `projectFile`, `PROJECT_DIR`, `LEGACY_FILES` (Task 1).
-   Produces: `copyLocalFiles(repo, dest)` copies the whole `.devfactory/` folder plus any legacy file, returns the relative names copied, excludes them in the worktree; `profilesFile(root)` returns `.devfactory/qa.yaml`, else `dev-factory.qa.yaml`, else the plugin's `qa/profiles.yaml`.

-   [ ] **Step 1: Write the failing tests**

    -   worktree: `a new worktree gets .devfactory/ from the main checkout and git ignores it` (`git status --porcelain` empty); `a .devfactory file the branch tracks is left alone`; `a repository with only the legacy files still gets them copied`.
    -   guard: `a ticket cannot write .devfactory/config.json or qa.yaml` (deny, reason says it sets what the factory allows); `a ticket cannot remove or move the .devfactory folder` (`runStateRoot('.devfactory')` true); the improver and promoter roles are denied the same way; reads are unaffected.
    -   qa: `qa.yaml in .devfactory replaces the default profiles`; `the legacy dev-factory.qa.yaml is still read`; `.devfactory wins when both exist`.

-   [ ] **Step 2: Run to verify they fail**

Run: `node --test --import ./test/setup.mjs test/worktree.test.mjs test/guard.test.mjs test/guard-machine.test.mjs test/qa.test.mjs`
Expected: FAIL on the new tests only.

-   [ ] **Step 3: Implement.** `copyLocalFiles`: copy `.devfactory/` recursively unless the branch tracks `.devfactory/config.json`; keep the legacy copy and the `exclude` call. `guard-lib.mjs`: extend the name test that guards `dev-factory.config.json` to any path whose first component is `.devfactory`; add `.devfactory/` to `protectedPath`. `guard-paths.mjs`: add `['.devfactory']` to the protected places and `'.devfactory'` to `runStateRoot`. `bin/qa.mjs`: `profilesFile` uses `projectFile('qa', root)`.

-   [ ] **Step 4: Run to verify they pass**

Run: the Step 2 command plus `test/guard-hardening.test.mjs`
Expected: PASS.

-   [ ] **Step 5: Commit** `feat: carry and protect the .devfactory folder in worktrees`

---

### Task 3: Registrations, scoped MCP commands, the `jira` catalog entry

**Files:**

-   Create: `scripts/registrations.mjs`, `test/registrations.test.mjs`
-   Modify: `scripts/mcp.mjs`, `mcp/catalog.json`, `scripts/jira-mcp-config.mjs`, `scripts/factory-settings.mjs`, `scripts/doctor.sh` (~line 124)
-   Test: `test/mcp.test.mjs`, `test/jira-mcp.test.mjs`

**Interfaces:**

-   Produces, in `scripts/registrations.mjs`:
    -   `readRegistrations(env?): { mcp: { user: string[], projects: Record<string, string[]> }, plugins: { user: string[], projects: Record<string, string[]> } }` (missing file → empty shape; file at `<userDir>/registrations.json`).
    -   `record(kind: 'mcp' | 'plugins', scope: 'user' | 'project', id: string, root?: string, env?)`, `forget(kind, scope, id, root?, env?)`, `recordedScope(kind, id, root, env?): 'user' | 'project' | null`.
    -   `prune(kind, present: string[], root, env?): string[]`: drops recorded ids not in `present`, returns what it dropped.
-   Produces, in `scripts/mcp.mjs`:
    -   `catalog(cfg?): Record<id, entry>` now fills `{{pluginRoot}}` (from `PLUGIN_ROOT`) and `{{jiraSite}}` (from `sources.jira.site`, `''` when unset) in every string of every `config`.
    -   `type McpScope = 'user' | 'project' | 'shared'`
    -   `registerServer({ id, scope, config?, root, run, env? }): { changed: boolean, message: string }`: `user` → `run('claude', ['mcp','add-json','-s','user', id, JSON.stringify(config ?? catalog[id].config)])` then `record`; `project` → the same with `-s local`; `shared` → `enable([id], sharedFile)` (today's `.mcp.json` write). The command runs first; a non-zero status throws `Error(`claude mcp add-json failed: ${stderr}`)` and records nothing.
    -   `unregisterServer({ id, scope, root, run, env? })`: `user`/`project` → only when `recordedScope` names that scope: `claude mcp remove -s user|local`, then `forget`; otherwise `{ changed: false, message }` saying the factory did not add it; `shared` → `disable([id], sharedFile)`.
    -   `scopeOf(id, { root, listing, sharedFile, env? }): 'user' | 'project' | 'shared' | 'external' | null` (shared wins over a record, a record wins over external; `null` when Claude does not have it).
    -   `sharedFile(root, env?)`: `DF_MCP_FILE` or `<root>/.mcp.json`.
    -   `mcp.mjs enable ID... [--scope user|project|shared] [--force]` (default `project`), `disable ID... [--scope …]`, `connect [--all] [--scope …]`; `recommend`, `allow`, `doctor` and `list` read every source (record, shared file, listing). `allowRules(file, external)` keeps its signature; callers pass the ids from every source.
    -   `type Run = (cmd: string, args: string[]) => { status: number, stdout: string, stderr: string }`; the default wraps `spawnSync` with `encoding: 'utf8'`.
-   `mcp/catalog.json` gains `jira`: `title` "Jira over an API token", `category` tracker, `tracker` jira, `recommended` false, `config` `{ "command": "node", "args": ["{{pluginRoot}}/scripts/jira-mcp.mjs"], "env": { "JIRA_SITE": "{{jiraSite}}" } }` (take the exact env names from today's `jira-mcp-config.mjs`), `purpose`, `without`, `domains` `[]`.
-   `scripts/jira-mcp-config.mjs` keeps its flags and calls `registerServer({ id: 'jira', scope: process.argv has --scope ? that : 'project' })`; `--print` still prints the config.
-   `scripts/doctor.sh`: the MCP lines come from `mcp.mjs doctor` as today, and a legacy file warns `dev-factory.config.json is the old location: run dev-factory migrate` (same for `dev-factory.qa.yaml`).

-   [ ] **Step 1: Write the failing tests** (a recorder `run` that collects calls and returns a scripted status; temp `DF_STATE_DIR` and root)

    -   registrations: `record then recordedScope then forget round-trips, keyed by root for project scope`; `prune drops ids Claude no longer lists and returns them`; `a missing file reads as the empty shape`.
    -   mcp: `catalog fills {{pluginRoot}} and {{jiraSite}} and the jira entry names no host of its own` (the shipped file matches `/\{\{jiraSite\}\}/` and nothing like `atlassian\.net`); `registerServer user calls claude mcp add-json -s user and records the id`; `registerServer project uses -s local and records under the root`; `registerServer shared writes .mcp.json and runs no claude command`; `a failing claude call records nothing and the error names the command and stderr` (Review Focus 4); `unregisterServer refuses a server the factory did not record and says so` (Review Focus 3); `scopeOf: shared beats a record, a record beats external, unknown is null`; `enable defaults to project scope and --scope shared gives the old behaviour` (spawn the CLI with a stub `claude` first on `PATH` that records its argv to a file); `factory-settings allows the catalog servers from the record, the shared file and the listing` (adjust the test at `test/mcp.test.mjs:220`).
    -   jira: `jira-mcp-config registers at project scope by default and --print still prints the config`.

-   [ ] **Step 2: Run to verify they fail**

Run: `node --test --import ./test/setup.mjs test/registrations.test.mjs test/mcp.test.mjs test/jira-mcp.test.mjs`
Expected: FAIL.

-   [ ] **Step 3: Implement** the interfaces above. `factory-settings.mjs build()` gains `ids: string[]` (every catalog server in use) in place of deriving them from `mcpFile` alone; its `main` collects them from `readRegistrations`, the shared file and `externalServers`. The stub-`claude` helper for CLI tests goes in `test/patterns.mjs` as `fakeClaude(dir, { status = 0, stdout = '' })` returning the folder to prepend to `PATH`, so Tasks 4–7 reuse it.

-   [ ] **Step 4: Run to verify they pass**

Run: the Step 2 command plus `test/doctor.test.mjs test/preflight.test.mjs`
Expected: PASS.

-   [ ] **Step 5: Commit** `feat: register MCP servers at user, project or shared scope and record what the factory added`

---

### Task 4: The settings registry

**Files:**

-   Create: `scripts/settings-lib.mjs`, `test/settings-lib.test.mjs`

**Interfaces:**

-   Consumes: `catalog`, `registerServer`, `unregisterServer`, `scopeOf`, `parseListing`, `findServer`, `stateOf`, `Run` (Task 3); `readRegistrations`, `record`, `forget`, `prune` (Task 3); `plugins.json`; `load`, `userConfigFile`, `projectPath`, `ensureProjectDir` (Task 1).
-   Produces:
    -   `type Scope = 'off' | 'user' | 'project' | 'shared'`
    -   `type Item = { id: string, kind: 'mcp' | 'plugin' | 'source' | 'flag', title: string, purpose: string, without?: string, scope: Scope | 'external' | 'user-off-here' | 'default', value?: unknown, options?: string[], required?: boolean, health?: string, note?: string }`
    -   ids: `mcp:<catalog id>`, `plugin:<plugins.json id>`, `source` (`tasks.source`, options `SOURCES`), `flag:<dotted path>` for exactly `review.bugbot`, `git.agentAttribution`, `tasks.unblockOnPr`, `blocked.agentDecides`.
    -   `type Ctx = { root: string, env?: object, run: Run, mcpListing?: string, pluginListing?: string }` (`mcpListing` is the text of `claude mcp list`, `pluginListing` the JSON of `claude plugin list --json`, both supplied by the caller so the page fetches them once).
    -   `listItems(ctx): Item[]`; `setItem(id, change: { scope: Scope, value?: unknown }, ctx): { changed: boolean, message: string }`.
-   Behaviour pinned by the spec:

    -   MCP: `user`/`project`/`shared` → `registerServer`; `off` → `unregisterServer` at the recorded scope, or the shared file; an `external` server → `{ changed: false }` with the reason. Moving between scopes unregisters the old scope first. After a change, the item is read back from a fresh `claude mcp list` and the message says `registered` or `claude did not keep it: <state>`.
    -   Plugins: scope from `pluginListing` (`scope`, `enabled`, `projectEnabled`); `user`/`project`/`shared` → `claude plugin install <id> --scope user|local|project` then `record('plugins', …)`; `off` → `claude plugin uninstall <id> -s <scope>` only for a recorded install, else `{ changed: false, message: 'installed by you: claude plugin uninstall <id> -s <scope>' }`; a `required` plugin (`plugins.json`) is `required: true` and `off` returns `{ changed: false }`; a user-scope plugin accepts scope `user-off-here` (`claude plugin disable <id> --scope local`) and back to `user` (`claude plugin enable <id> --scope local`).
    -   `source` and `flag`: write the value into the user or project config file (create `.devfactory/` on demand); a flag `off` writes `false`; `source` has no `off`.
    -   Any non-zero `status` throws an error naming the command and its stderr, and nothing is written (Review Focus 4). An unknown id throws and lists the valid ids.

-   [ ] **Step 1: Write the failing tests** (recorder `run`, temp dirs, fixed `mcpListing`/`pluginListing` strings)

    -   `listItems has one entry per catalog server, companion plugin, the source and the four flags`.
    -   `an MCP server goes off → project with add-json -s local and a record under the root`; `user scope uses -s user`; `moving from user to project removes the user registration first`; `an external server is reported and off changes nothing` (Review Focus 3); `a failing claude call writes nothing and the error names the command` (Review Focus 4); `after a change the item is read back and a server claude did not keep is reported`.
    -   `a plugin at project scope installs with --scope local and is recorded`; `off on a plugin the person installed prints the command and runs nothing`; `superpowers is required and cannot be switched off`; `a user plugin toggles to user-off-here with disable --scope local`.
    -   `a flag at project scope lands in .devfactory/config.json and wins over the user value`; `source at user scope lands in the user file`.
    -   `an unknown id throws and lists the valid ones`.

-   [ ] **Step 2: Run to verify they fail**

Run: `node --test --import ./test/setup.mjs test/settings-lib.test.mjs`
Expected: FAIL (module missing).

-   [ ] **Step 3: Implement** `listItems` and `setItem`. Config writes read the file, set the dotted path, write back with tab indentation like `mcp.mjs`.

-   [ ] **Step 4: Run to verify they pass**

Run: `node --test --import ./test/setup.mjs test/settings-lib.test.mjs`
Expected: PASS.

-   [ ] **Step 5: Commit** `feat: add the settings registry`

---

### Task 5: `dev-factory settings`: the list, `set`, and the page

**Files:**

-   Create: `scripts/settings.mjs`, `scripts/settings-tui.mjs`, `test/settings.test.mjs`
-   Modify: `scripts/cli.mjs` (`COMMANDS.settings = ['node', 'scripts/settings.mjs']`, header comment), `test/entry.test.mjs` (`scripts/settings.mjs` joins `CLIS`)

**Interfaces:**

-   Consumes: `listItems`, `setItem`, `Item`, `Ctx` (Task 4); `claudeListing` (Task 3).
-   Produces:

    -   `settings.mjs list [--json]`; `settings.mjs set <id> <off|user|project|shared> ` for MCP and plugins; `set source <name> [--scope user|project]`; `set flag:<path> true|false [--scope …]`; `--scope` defaults to `project`. No arguments: the page on a terminal, `list` otherwise. Usage errors exit 3; a failed change exits 1 with the error's message.
    -   In `settings-tui.mjs`: `render(items: Item[], cursor: number, status: string, { width = 80 } = {}): string` (grouped by kind; `[x]`/`[ ]`; the scope word, `required` or `external`; the selected item's purpose; the key line `↑↓ move  space on/off here  u user  p project  s shared  q quit`); `onKey(state: { items, cursor, status }, key: string): { state, action?: { id, change: { scope: Scope } } }`: `up`/`down` move within bounds; `space` on `off` → `project`, on `project`/`shared` → `off`, on a `user` plugin → `user-off-here` and back, on a `user` MCP server → status says Claude has no per-project switch; `u`, `p`, `s` set that scope (`s` only for mcp and plugin items); `q` → `action: { quit: true }`.
    -   The terminal shell: prints `checking Claude's servers…`, fetches `claude mcp list` and `claude plugin list --json` once, enters raw mode (`readline.emitKeypressEvents`, `setRawMode(true)`), applies each action through `setItem` at once, refreshes the item from a fresh `listItems`, shows the message in `status`, restores the terminal on `q` and on SIGINT.

-   [ ] **Step 1: Write the failing tests**

    -   `render shows every item with its scope and the purpose of the selected one` (exact lines for a four-item fixture: one mcp off, one mcp external, one required plugin, one flag).
    -   `onKey: down moves, space on an off item asks for project, space on a project item asks for off, u asks for user, s on a flag does nothing`; `onKey never moves past the ends`; `space on a user plugin asks for user-off-here`.
    -   `list --json prints the items` (spawn with a temp root, `fakeClaude`).
    -   `set mcp:playwright project calls claude mcp add-json -s local` (spawn with `fakeClaude` recording argv).
    -   `with no terminal, settings prints the list and exits 0` (spawn with stdin from `/dev/null`; Review Focus 5).
    -   `set with an unknown id exits 1 and names the valid ids`.

-   [ ] **Step 2: Run to verify they fail**

Run: `node --test --import ./test/setup.mjs test/settings.test.mjs test/entry.test.mjs`
Expected: FAIL.

-   [ ] **Step 3: Implement** the three files and the `cli.mjs` entry.

-   [ ] **Step 4: Run to verify they pass**

Run: `node --test --import ./test/setup.mjs test/settings.test.mjs test/entry.test.mjs test/docs.test.mjs`
Expected: PASS.

-   [ ] **Step 5: Commit** `feat: add the dev-factory settings page`

---

### Task 6: `init` and `migrate`

**Files:**

-   Create: `scripts/project-init.mjs`, `test/project-init.test.mjs`
-   Modify: `scripts/cli.mjs` (`init`, `migrate` entries)

**Interfaces:**

-   Consumes: `ensureProjectDir`, `projectPath`, `projectFile`, `LEGACY_FILES` (Task 1); `catalog`, `readProject`, `registerServer`, `disable`, `sharedFile` (Task 3).
-   Produces: `init(root): { created: string[] }` (the folder, its `.gitignore`, an empty `config.json` `{}` when none exists); `migrate(root, { dryRun = false, mcp = null as null | 'project' | 'user', run, env? }): { moved: Array<{ from, to }>, skipped: string[], reregistered: string[], tracked: string[], notes: string[] }`:

    -   `dev-factory.config.json` → `.devfactory/config.json`; `dev-factory.qa.yaml` → `.devfactory/qa.yaml`; a destination that exists is `skipped`, never overwritten.
    -   with `mcp`: for each catalog id in the shared file, `registerServer({ id, scope: mcp, config: <the entry as it stands in .mcp.json> })`, then `disable([id], sharedFile)`; the person's own servers stay; the file is removed only when `mcpServers` ends up empty. Without `mcp`: `notes` says the servers stay shared.
    -   a source that git tracks (`git ls-files --error-unmatch`) is moved and listed in `tracked`, with the note `git rm --cached <from>` to run.
    -   CLI: `project-init.mjs init | migrate [--dry-run] [--mcp project|user]`; `--dry-run` prints the plan and changes nothing.

-   [ ] **Step 1: Write the failing tests**

    -   `init creates the folder, the self-ignoring .gitignore and an empty config; a second run changes nothing`.
    -   `migrate moves the legacy config and qa files`; `migrate twice with the new file edited in between keeps the edit` (Review Focus 1).
    -   `migrate --mcp project re-registers each catalog server with its entry as it stands and removes it from .mcp.json` (a playwright entry with an extra `--foo` arg: the recorded `add-json` argv carries `--foo`; Review Focus 2); `the person's own servers stay and the file is removed only when empty`.
    -   `migrate without --mcp leaves .mcp.json alone and says the servers stay shared`.
    -   `migrate --dry-run changes nothing and lists what it would do`; `migrate notes a tracked source file`.

-   [ ] **Step 2: Run to verify they fail**

Run: `node --test --import ./test/setup.mjs test/project-init.test.mjs`
Expected: FAIL.

-   [ ] **Step 3: Implement** the two functions and the CLI wrapper.

-   [ ] **Step 4: Run to verify they pass**

Run: `node --test --import ./test/setup.mjs test/project-init.test.mjs test/docs.test.mjs`
Expected: PASS.

-   [ ] **Step 5: Commit** `feat: add init and migrate for the .devfactory folder`

---

### Task 7: User-level install, setup that asks the scope, cloud stages the forced add

**Files:**

-   Modify: `scripts/install.sh`, `scripts/cloud.mjs`, `scripts/wizard.sh`, `commands/setup.md`
-   Test: `test/install.test.mjs` (new), `test/cloud.test.mjs`, `test/commands.test.mjs`, `test/doctor.test.mjs`

**Interfaces:**

-   Consumes: `settings.mjs set` (Task 5), `project-init.mjs init|migrate` (Task 6), `record('plugins', …)` (Task 3).
-   Produces:

    -   `install.sh [--apply] [--load] [--user-only] [--plugin-scope user|local]`: companion plugins install with `--scope user` unless `--plugin-scope local`, and each successful install is recorded through `node "$DIR/scripts/registrations.mjs" record plugins <scope> <id>` (add that small CLI to `registrations.mjs`); `--user-only` does the launcher, the state `.env.local` and the plugins, then exits 0 before the repository checks, the doctor and the scheduler, so it runs outside any repository.
    -   `cloud.mjs init`: after writing `.claude/settings.json`, runs `git add -f .devfactory/config.json` (and `qa.yaml` when it exists), prints `staged <file> (a cloud checkout has only committed files; git reset <file> undoes it)`, never commits; when neither exists it says to run `dev-factory init` first.
    -   `commands/setup.md`: look; run `init` (and offer `migrate` when the doctor reports a legacy file); for each chosen tool ask once **"every project on this machine, or only this one?"** with a recommendation (trackers and documentation servers: user; a compose environment, Maestro and the QA profile: project; for a cloud runtime: shared) and apply it with `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" set …`; the task source and companion plugins are asked the same way; finish by pointing at `dev-factory settings`. The text no longer tells a person to write `dev-factory.config.json` or `.mcp.json`.
    -   `wizard.sh` names `.devfactory/config.json` and `dev-factory settings`.

-   [ ] **Step 1: Write the failing tests**

    -   install (`fakeClaude` recording argv, temp `DF_STATE_DIR`, cwd outside any git repository): `--user-only works outside a repository and exits 0`; `companion plugins install with --scope user by default and are recorded`; `--plugin-scope local installs with --scope local`; `a plugin that fails to install fails the run after the others were tried` (existing behaviour kept).
    -   cloud: `init stages the project files with git add -f, says so, and commits nothing` (`git diff --cached --name-only` lists them, `git log` unchanged); `init without a .devfactory folder says to run init first`.
    -   commands: `setup.md names .devfactory, the scope question and settings.mjs set, and no longer says to write dev-factory.config.json or .mcp.json`; the existing frontmatter checks still pass.

-   [ ] **Step 2: Run to verify they fail**

Run: `node --test --import ./test/setup.mjs test/install.test.mjs test/cloud.test.mjs test/commands.test.mjs`
Expected: FAIL on the new tests.

-   [ ] **Step 3: Implement.** In `install.sh` only the plugin-scope string, the record call, the new flags and the early exit change; everything else stays.

-   [ ] **Step 4: Run to verify they pass**

Run: the Step 2 command plus `test/doctor.test.mjs test/runtime.test.mjs`
Expected: PASS.

-   [ ] **Step 5: Commit** `feat: install once per user and let setup choose user or project scope`

---

### Task 8: Documentation, test list, version, final checks

**Files:**

-   Modify: `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.env.example`, `qa/profiles.yaml`, `skills/task-source/jira.md`, `scripts/mcp-guard-lib.mjs` (comments), `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `test/docs.test.mjs` (drop the exclusion of this plan), `test/hygiene.test.mjs`, `test/readme.test.mjs`

-   [ ] **Step 1: Write the failing tests.** `test/readme.test.mjs`: `the README documents .devfactory, registrations.json, settings, init, migrate and the shared scope`; `AGENTS.md names every new script in its test list` (`project-dir.mjs`, `registrations.mjs`, `settings-lib.mjs`, `settings.mjs`, `settings-tui.mjs`, `project-init.mjs`). `test/hygiene.test.mjs`: `the legacy file names appear only where the fallback lives` (`dev-factory.config.json`, `dev-factory.qa.yaml` outside `test/` only in `scripts/project-dir.mjs`, `scripts/project-init.mjs`, `scripts/doctor.sh`, and the README's migration section); `every documented test command uses --import ./test/setup.mjs`. Remove the plan's exclusion from `test/docs.test.mjs`. Run `node --test --import ./test/setup.mjs test/readme.test.mjs test/hygiene.test.mjs test/docs.test.mjs`; expected: FAIL.

-   [ ] **Step 2: Update the documents.** README: install once (`claude plugin install … --scope user`, `dev-factory install --user-only`); the layer table gains the user layer and `.devfactory/config.json` replaces `dev-factory.config.json`; a "Where things live" note for `.devfactory/`, `.factory/`, `.dev-factory/`; the scope table from the spec; `dev-factory settings`, `init`, `migrate`; the `mcp enable` default change under a release note; cloud: `cloud init` stages the forced add and MCP servers for a runner use `shared`; the worktree note (a `claude` started by hand inside a worktree does not see the checkout's project-scope servers). Layout table and command list updated. AGENTS.md and CONTRIBUTING.md: the state-location rule, the test command, the "Where things are" rows. `.env.example`, `qa/profiles.yaml`, `skills/task-source/jira.md`, `mcp-guard-lib.mjs` comments: the new names.

-   [ ] **Step 3: Bump both manifests to `0.16.0`.**

-   [ ] **Step 4: Run every check**

```bash
node --test --import ./test/setup.mjs test/*.test.mjs
npx prettier@3.2.5 --check "**/*.{md,json,mjs}"
bash scripts/lint-vocabulary.sh
claude plugin validate .
```

Expected: all pass (`npx prettier@3.2.5 --write` where formatting is the only failure).

-   [ ] **Step 5: Commit** `docs: describe user-level install and the .devfactory folder; release 0.16.0`

---

## Self-review

-   **Spec coverage:** layers and `DF_USER_CONFIG` (Task 1); `.devfactory/`, worktrees, guards, `qa.yaml` (Tasks 1, 2); registrations, scopes, `mcp enable` default, the `jira` entry, every-source allow rules (Task 3); the registry, plugin states, read-back (Task 4); the page and `settings set` (Task 5); `init`, `migrate` keeping edited entries (Task 6); install, setup, cloud staging (Task 7); docs, test command, version (Task 8). Non-goals (renaming `.factory/`, per-project switch for a user MCP server, cloud plugins) have no task on purpose.
-   **Types:** `Scope`, `Item`, `Ctx`, `Run`, `McpScope`, `registerServer`, `unregisterServer`, `scopeOf`, `sharedFile`, `readRegistrations`, `record`, `forget`, `prune`, `projectFile`, `projectPath`, `ensureProjectDir`, `userConfigFile`, `fakeClaude` are defined once and used under the same names later.
-   **Proportion:** the spec is ~170 lines; the plan carries signatures, test names and the pinned values, not bodies.
-   **Left to the implementer on purpose:** the page's column layout; the wording of messages not quoted; whether an `external` server's scope is looked up with `claude mcp get`; the exact env names of the `jira` entry (read from today's `jira-mcp-config.mjs`).
