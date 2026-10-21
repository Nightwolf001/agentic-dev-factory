# dev-factory: guidance for agents editing this directory

This directory is the factory itself: a Claude Code plugin that builds labelled Jira tickets into draft PRs. Read `README.md` first.

## Rules

-   Inside a ticket run (a worktree with `.dev-factory/run.json` whose role is builder, reviewer, debugger or researcher) you never edit anything under `dev-factory/`; a hook refuses it. The one exception is the `improver` role of `/dev-factory:improve`, which edits `dev-factory/` except the enforcement files named in `agents/factory-improver.md`, and the `promoter` role, which edits only the `## Learned rules` section of `AGENTS.md` files outside `dev-factory/`. Changes to the factory are ordinary tickets done by a person or an interactive session.
-   Keep the vocabulary clean: `bash dev-factory/scripts/lint-vocabulary.sh` must pass. Explain rules by their reason, not by where they came from.
-   Every behavioural change to `bin/qa.mjs`, `scripts/guard-lib.mjs`, `scripts/config.mjs` or `scripts/stop-gate.mjs` needs a test in `test/`. Run them with `node --test dev-factory/test/*.test.mjs`. The same holds for `scripts/promote-lib.mjs`, `scripts/learnings-lib.mjs`, `scripts/debug-lib.mjs`, `mcp-guard-lib.mjs`, `scrub-lib.mjs`, `ticket-lib.mjs`, `learnings-lib.mjs`, `frontier.mjs`, `run-record.mjs` and `stop-gate-lib.mjs`.
-   Shell scripts must work with the macOS default bash 3.2: no `mapfile`, no associative arrays.
-   Formatting follows the repository Prettier config for `.md`, `.json` and `.mjs`: `npx prettier@3.2.5 --check "dev-factory/**/*.{md,json,mjs}"`. Do not run `npm install` on the host.
-   Shared settings live in `config.json`; add a new setting there, validate it in `scripts/config.mjs`, and document it in the README. Secrets only in `.env.local`.
-   Keep `README.md` in step with commands, scripts and the flow when you change them. `claude plugin validate ./dev-factory` must pass.

## Where things are

| Concern                           | File                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| The scheduled pass                | `commands/tick.md`, `scripts/tick.sh`                                                                                     |
| The per-ticket phases             | `agents/factory-builder.md`, `skills/*`                                                                                   |
| Review                            | `agents/factory-reviewer.md`, `skills/review/SKILL.md`                                                                    |
| What an agent may run or edit     | `scripts/guard-lib.mjs`, `hooks/hooks.json`                                                                               |
| When an agent may stop            | `scripts/stop-gate.mjs`                                                                                                   |
| Which run a hook event belongs to | `scripts/run-context.mjs`                                                                                                 |
| Evidence and review truth         | `bin/qa.mjs`                                                                                                              |
| Debugging and telemetry           | `agents/factory-debugger.md`, `scripts/debug-lib.mjs`, `scripts/mcp-guard-lib.mjs`, `skills/diagnose`, `skills/telemetry` |
| Self-improvement                  | `commands/improve.md`, `agents/factory-improver.md`, `scripts/run-record.mjs`, `IMPROVEMENT-PLAN.md`                      |
| Scheduler preflight               | `scripts/frontier.mjs`, `scripts/tick.sh`                                                                                 |
| Environments                      | `scripts/e2e-env.sh`, `scripts/mobile-env.sh`                                                                             |
