# User-level install, project-level settings and a settings page

Design for the change requested on 2026-11-04. The plan that implements it is `docs/superpowers/plans/2026-11-04-user-level-config.md`.

## Intent

Today the factory is set up again in every repository: a `dev-factory.config.json` at the root, catalog MCP servers written into the repository's `.mcp.json`, companion plugins installed with `--scope local`, and a launchd job per repository. A person who uses GitHub, Notion and Playwright in every project repeats the same answers in every project, and every repository carries factory files that are not the project's own.

After this change:

1. The plugin and the tools a person uses everywhere are set up **once per user**. The tools a person uses in one project only are set up **for that project only**. `/dev-factory:setup` asks which, per tool.
2. Everything the factory keeps for a project lives in one folder, **`.devfactory/`**, which git ignores.
3. A person changes what is on or off for a project from a **settings page in the terminal**, `dev-factory settings`, without editing JSON.

## Goals, non-goals, anti-goals

**Goals**

-   Three configuration layers, merged in order: the plugin's defaults, the user's file, the project's file. Environment variables still win over all three.
-   Each optional tool has one scope: `off`, `user` (every project on this machine) or `project` (this checkout only). Where today's behaviour (a committed file, needed by cloud runners and teammates) must survive, a fourth scope `shared` names it.
-   Old files keep working until `dev-factory migrate` moves them. Nothing a person already set up breaks on update.
-   The settings page shows every option, where it is on, and lets a person toggle it; the same changes are scriptable (`settings set`), because `/dev-factory:setup` runs inside Claude where there is no terminal to draw on.

**Non-goals**

-   Renaming `.factory/` (task files and QA cases: committed work product) or `.dev-factory/` (per-run state inside a worktree). Both stay. The three names are documented side by side.
-   Switching a user-level MCP server off for one project. Claude Code has no scripted way to do it (only the `/mcp` panel); the page shows such a server as `user` and offers to move it to `project` or switch it off everywhere.
-   Making plugins available in cloud sessions; that is Claude Code's limit and `cloud init` keeps its current behaviour.

**Anti-goals** (the change fails if any of these happen)

-   The factory removes an MCP server or a plugin the person added themselves.
-   A factory command stages or commits something in the person's repository without saying so first.
-   A secret ends up in `.devfactory/` or in either config file. Secrets stay in `~/.dev-factory/.env.local`.
-   A ticket run can edit `.devfactory/`.
-   The test suite reads the developer's own `~/.dev-factory/config.json`.

## How Claude Code stores these things (verified 2026-11-04)

The design leans on Claude Code's own scopes rather than inventing files Claude cannot see:

| Thing                  | `user` scope                                                   | `project` scope (this checkout)                                                                                   | `shared` scope (committed)                     |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| MCP server             | `claude mcp add-json -s user` → `~/.claude.json`               | `claude mcp add-json -s local` → `~/.claude.json` under `projects["<absolute path>"]`                             | `claude mcp add-json -s project` → `.mcp.json` |
| Plugin                 | `claude plugin install --scope user`                           | `claude plugin install --scope local` → `.claude/settings.local.json` (Claude adds it to the global git excludes) | `--scope project` → `.claude/settings.json`    |
| Removal                | `claude mcp remove -s user`, `claude plugin uninstall -s user` | `-s local`                                                                                                        | `-s project`                                   |
| Per-project plugin off | –                                                              | `claude plugin disable <id> --scope local`                                                                        | –                                              |

Verified by a probe: a `claude -p` session started in a folder sees that folder's `local` servers (`source: "local"`, status `connected`, tools exposed). The scheduled pass does `cd "$REPO"` before starting Claude, so `local` scope reaches it. A git worktree is a different absolute path and so a different `local` entry; the factory's agents are subagents of the session started in `$REPO`, so this does not affect them, and the README says so for people who start `claude` inside a worktree by hand.

`.mcp.json` servers load in `-p` mode without a prompt. `claude plugin list --json` is machine-readable. `claude mcp list` is not, and takes a few seconds (it checks health); the existing parser in `scripts/mcp.mjs` stays.

## The design

### Layers

`load()` returns `merge(merge(defaults, user), project)`:

-   defaults: the plugin's `config.json`
-   user: `~/.dev-factory/config.json` (`DF_STATE_DIR` moves the folder; `DF_USER_CONFIG` names the file, and an empty value disables the layer)
-   project: `.devfactory/config.json`, found by walking up from the working directory; when it is absent, the legacy `dev-factory.config.json` at the same level is read instead. `DF_CONFIG` still replaces the project layer.

A file that is not valid JSON fails with `<path>: not valid JSON (<reason>)`, never a stack trace. `dev-factory config files` prints the three paths and whether each exists or is legacy.

The repository's own tests must not see the developer's user file: `test/setup.mjs` sets `DF_STATE_DIR` to a fresh temporary folder and `DF_USER_CONFIG` to empty, and every documented test command becomes `node --test --import ./test/setup.mjs test/*.test.mjs`.

### What the factory records

The factory must know what it registered, so it can show scopes on the page and never remove what it did not add. A registration is a fact about one machine (Claude keys `local` scope by the absolute path of the checkout), so the record lives in the machine state folder, never in a file that gets copied, committed or carried into a worktree: `~/.dev-factory/registrations.json`:

```json
{
	"mcp": { "user": ["context7"], "projects": { "/abs/path/to/repo": ["playwright"] } },
	"plugins": { "user": ["superpowers@claude-plugins-official"], "projects": {} }
}
```

`off` removes only what the record names. A recorded server or plugin that Claude no longer lists is dropped from the record when the page or the doctor next reads it. A server in Claude's listing but in no record is `external`: shown, used, never removed. `shared` is read from `.mcp.json` directly. The project config file holds no MCP record, so a teammate, a cloud runner or a worktree sees nothing it would have to honour; what they should share goes through `shared`.

The scheduled pass's allow rules and domains come from every catalog server Claude has, whatever the source: the record, `.mcp.json`, and the external ones found in `claude mcp list` (as today). The scope shown for an `external` server is found with `claude mcp get <id>` when the builder finds it fast enough, else shown as `external` without a scope.

### What becomes of `dev-factory mcp …`

`dev-factory mcp enable|disable` stay as the scriptable form for servers and become thin wrappers over the registry: `enable ID` registers at `project` scope unless `--scope user|shared` says otherwise; `disable ID` removes the registration the record names, or the `.mcp.json` entry with `--scope shared`. This changes the default from today's `.mcp.json` to Claude's local scope; the README's release note says so, and `DF_MCP_FILE` still names the shared file. The "skip a server Claude already has unless `--force`" rule stays. `connect` enables the recommended set at the chosen scope and reports as today; `recommend`, `allow` and `doctor` read every source. The doctor's `required`-server check reads every source too.

### The Jira token server

The token server the plugin ships (`scripts/jira-mcp.mjs`) becomes a catalog entry, `jira` (tracker `jira`, not recommended, purpose: Jira over an API token for unattended passes), so it is an ordinary item on the page and in `migrate`. Its `config` holds placeholders the catalog reader fills in: `{{pluginRoot}}` from `scripts/plugin-root.mjs` and `{{jiraSite}}` from `sources.jira.site`. `scripts/jira-mcp-config.mjs` keeps its name and flags and calls the registry with scope `project` unless told otherwise.

### `.devfactory/`

Contents: `config.json`, `qa.yaml` (replaces `dev-factory.qa.yaml`), and a `.gitignore` holding `*` so the folder ignores itself without touching the repository's tracked files. No MCP file: Claude holds the registrations. `dev-factory init` creates it; `enable`-style writes create it on demand.

A new worktree gets a copy of the folder (as `dev-factory.config.json` and `dev-factory.qa.yaml` are copied today); a file the branch tracks is left alone. The edit guard refuses any write under `.devfactory/` for every run role; the shell guard refuses removing or moving the folder.

Cloud runners see only committed files. `dev-factory cloud init` runs `git add -f .devfactory/config.json` (and `qa.yaml` when it exists), prints what it staged and why, and never commits. MCP servers for a cloud runner use the `shared` scope.

### Legacy files and `migrate`

Read when the new file is absent: `dev-factory.config.json`, `dev-factory.qa.yaml`. Catalog servers in a root `.mcp.json` are `shared`. The doctor warns once per legacy file: `dev-factory.config.json is the old location: run dev-factory migrate`.

`dev-factory migrate [--dry-run] [--mcp project|user]` moves the two files into `.devfactory/` (never overwriting a file that is already there; it lists those as skipped), and with `--mcp project|user` re-registers each catalog server found in `.mcp.json` at that scope **with the entry as it stands in `.mcp.json`** (a pinned version, an extra flag or an env line a person added is kept; the catalog's config is only for a server registered fresh), records it, then removes it from `.mcp.json` (the person's own servers stay; the file is deleted only when it ends up empty). Without `--mcp` the servers stay `shared` and the output says so. A source file that git tracks is moved and the output says it is still tracked, with the `git rm --cached` command to run.

### The settings registry

One library, `scripts/settings-lib.mjs`, holds the list of options and applies a change. Both the page and `/dev-factory:setup` call it.

Items: `mcp:<catalog id>` (scopes off/user/project/shared), `plugin:<plugins.json id>` (off/user/project/shared), `source` (the task source: user/project, value one of `local|github|notion|jira`), `flag:<dotted path>` for `review.bugbot`, `git.agentAttribution`, `tasks.unblockOnPr`, `blocked.agentDecides` (user/project, value true/false).

Plugins: `claude plugin list --json` (`scope`, `enabled`, `projectEnabled` per plugin) gives the state; the record says which installs were the factory's. `off` runs `claude plugin uninstall -s <scope>` only for a recorded install; for one the person installed, the page shows the command instead of running it. A plugin `plugins.json` marks `required` (superpowers today) is shown with that word and cannot be switched off. A user-level plugin has one more state, `user (off here)`: Claude's `claude plugin disable <id> --scope local`, the only per-project switch Claude offers; on such a plugin, space toggles between `user` and `user (off here)`.

Applying a change: the Claude command runs first; only when it exits 0 is the record written. A failure throws an error naming the command and its stderr, with no file changed. Moving between scopes removes the old registration first. `off` on an `external` item does nothing except say why. After a change the item is read back from Claude's listing, so a write Claude did not keep is reported rather than assumed (an `add-json` run from the Bash tool of a live session was seen to persist in the probe, but the page checks every time).

### The page and the scriptable form

`dev-factory settings` on a terminal: a list grouped by kind, a `[x]`/`[ ]` box, the scope word, one line of purpose for the selected item, and the keys: up/down, space (off ↔ project), `u` user, `p` project, `s` shared (MCP and plugins only), `q` quit. The page reads `claude plugin list --json` and `claude mcp list` once when it opens and shows `checking Claude's servers…` while it waits; each toggle is applied immediately and the line shows the result or the error.

Without a terminal (a pipe, cron, a Claude session) it prints the list and exits 0. `dev-factory settings list [--json]` and `dev-factory settings set <id> <off|user|project|shared>` (for `source`: `set source github --scope user`; for a flag: `set flag:review.bugbot true --scope project`) do the same from a script. `--scope` defaults to `project`.

### Setup and install

`/dev-factory:setup` keeps its interview, and for each chosen tool asks once: "every project on this machine, or only this one?", with a recommendation (trackers and documentation servers: user; a compose environment, Maestro, the QA profile: project), then runs `settings set`. It runs `init` first and offers `migrate` when it finds legacy files. It ends by pointing at `dev-factory settings`.

`dev-factory install`: companion plugins install with `--scope user` unless `--plugin-scope local`; `--user-only` does the launcher, the state `.env.local` and the plugins and skips the repository checks, the doctor and the scheduler, so it works outside any repository. The scheduler stays per repository.

### Documentation and version

README: install once; the three layers and which keys suit which; `.devfactory/` and its two neighbours; the scope table above; `dev-factory settings`, `init`, `migrate`; migration from the old files; cloud needs the forced add. AGENTS.md, CONTRIBUTING.md and the test command change with it. Version `0.16.0` (minor: new behaviour, old files still work).

## Constraints

-   bash 3.2, plain Node 20, no dependencies, Prettier 3.2.5, the vocabulary lint, `claude plugin validate .`.
-   Every behavioural change in the enforcement and configuration scripts has a test; new scripts join the list in AGENTS.md.
-   Nothing in the plugin names a company, tracker site or host.

## Left to the builder

-   The exact layout of the page beyond the elements named above, and the wording of messages not quoted here.
-   Whether the scope of an `external` server is found with `claude mcp get <id>` or left blank; reading `~/.claude.json` directly is not an option (undocumented, and the file is Claude's).
-   How `test/setup.mjs` is kept in step with the documented test command (a hygiene test that greps the docs is the obvious way).

## Decisions made on the person's behalf (flagged for review)

1.  Project-level MCP servers use Claude's `local` scope rather than a file in `.devfactory/`; nothing in the repository, visible to plain `claude` sessions, no wrapper command.
2.  A fourth scope, `shared`, keeps today's committed files for cloud runners and teammates instead of dropping that ability.
3.  `.factory/` and `.dev-factory/` keep their names.
4.  The record of what the factory registered is a machine file, `~/.dev-factory/registrations.json`, keyed by checkout path, not anything in the project.
5.  `cloud init` stages the forced add itself (reversible with `git reset`), rather than only printing the command.
6.  `dev-factory mcp enable` changes its default from the committed `.mcp.json` to Claude's local scope (`--scope shared` gives the old behaviour).
7.  Plugins are recorded too; a plugin the person installed is never uninstalled by the page; `superpowers` is locked on; a user-level plugin can be switched off for one project with Claude's own `disable --scope local`.
8.  The Jira token server joins the catalog as `jira` so it has a scope like every other server.
9.  `migrate` keeps a server's entry as the person edited it rather than replacing it with the catalog's.
