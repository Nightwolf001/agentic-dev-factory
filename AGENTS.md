# dev-factory: guidance for agents editing this directory

This directory is the factory itself: a Claude Code plugin that plans, builds, verifies and ships tasks to draft PRs. Tasks come from GitHub Issues, Notion, Jira or local files (`tasks.source`); every MCP server is optional. Read `README.md` first.

## Rules

-   Inside a ticket run (a worktree with `.dev-factory/run.json` whose role is builder, reviewer, debugger or researcher) you never edit the factory's own files (a vendored `dev-factory/`, the installed plugin); a hook refuses it. The one exception is the `improver` role of `/dev-factory:improve`, which edits the factory in a checkout of its source (the folder in `factoryPrefix` of its run.json, found by `scripts/factory-target.mjs`) except the enforcement files named in `agents/factory-improver.md`, and the `promoter` role, which edits only the `## Learned rules` section of `AGENTS.md` files outside `dev-factory/`. Changes to the factory are ordinary tickets done by a person or an interactive session.
-   Keep the vocabulary clean: `bash scripts/lint-vocabulary.sh` must pass. Explain rules by their reason, not by where they came from.
-   Every behavioural change to `bin/qa.mjs`, `scripts/guard-lib.mjs`, `scripts/config.mjs` or `scripts/stop-gate.mjs` needs a test in `test/`. Run them with `node --test test/*.test.mjs`. The same holds for `scripts/promote-lib.mjs`, `scripts/learnings-lib.mjs`, `scripts/debug-lib.mjs`, `mcp-guard-lib.mjs`, `scrub-lib.mjs`, `ticket-lib.mjs`, `learnings-lib.mjs`, `frontier.mjs`, `run-record.mjs`, `stop-gate-lib.mjs`, `tasks.mjs`, `mcp.mjs`, `factory-settings.mjs` `scripts/factory-target.mjs` and everything under `scripts/sources/`.
-   This is an installable plugin: commands, skills and agents run its scripts as `node "${CLAUDE_PLUGIN_ROOT}/..."` (substituted when they load), scripts find the plugin from their own location, and nothing may assume the plugin sits inside the repository it works on. State for the project goes in `.factory/` and `dev-factory.config.json`; machine state in `~/.dev-factory` (`DF_STATE_DIR`). `test/packaging.test.mjs` fails on a hard-coded `dev-factory/` path.
-   Shell scripts must work with the macOS default bash 3.2: no `mapfile`, no associative arrays.
-   Formatting follows the repository Prettier config for `.md`, `.json` and `.mjs`: `npx prettier@3.2.5 --check "**/*.{md,json,mjs}"`. Do not run `npm install` on the host.
-   Shared defaults live in `config.json` and carry no organisation: a repository's own values go in its `dev-factory.config.json`, merged over them. Add a new setting to `config.json`, validate it in `scripts/config.mjs`, and document it in the README. Secrets only in `.env.local`. Nothing in the plugin may name a company, tracker site, project key or host; a new tracker is a new file under `scripts/sources/` plus `skills/task-source/<name>.md`, and a new MCP server is an entry in `mcp/catalog.json`.
-   Keep `README.md` in step with commands, scripts and the flow when you change them. `claude plugin validate .` must pass.

## Where things are

| Concern                           | File                                                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The scheduled pass                | `commands/tick.md`, `scripts/tick.sh`                                                                                                                          |
| The per-ticket phases             | `agents/factory-builder.md`, `skills/*`                                                                                                                        |
| Review                            | `agents/factory-reviewer.md`, `skills/review/SKILL.md`                                                                                                         |
| What an agent may run or edit     | `scripts/guard-lib.mjs`, `hooks/hooks.json`                                                                                                                    |
| When an agent may stop            | `scripts/stop-gate.mjs`                                                                                                                                        |
| Which run a hook event belongs to | `scripts/run-context.mjs`                                                                                                                                      |
| Evidence and review truth         | `bin/qa.mjs`                                                                                                                                                   |
| Debugging and telemetry           | `agents/factory-debugger.md`, `scripts/debug-lib.mjs`, `scripts/mcp-guard-lib.mjs`, `skills/diagnose`, `skills/telemetry`                                      |
| Self-improvement                  | `commands/improve.md`, `agents/factory-improver.md`, `scripts/factory-target.mjs`, `scripts/run-record.mjs`, `IMPROVEMENT-PLAN.md`                             |
| Scheduler preflight               | `scripts/frontier.mjs`, `scripts/tick.sh`                                                                                                                      |
| Task sources                      | `scripts/sources/*.mjs`, `scripts/tasks.mjs`, `skills/task-source/*`                                                                                           |
| Packaging, CLI and cloud          | `.claude-plugin/*`, `bin/dev-factory`, `scripts/cli.mjs`, `scripts/runtime.sh`, `scripts/cloud.mjs`, `templates/`, `scripts/install.sh`                        |
| Optional MCP servers              | `mcp/catalog.json`, `scripts/mcp.mjs`, `scripts/factory-settings.mjs`, `scripts/cli.mjs`, `scripts/cloud.mjs`, `scripts/plugin-root.mjs`, `scripts/runtime.sh` |
| Environments                      | `scripts/e2e-env.sh`, `scripts/mobile-env.sh`                                                                                                                  |
