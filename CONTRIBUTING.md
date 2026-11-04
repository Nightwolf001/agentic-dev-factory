# Contributing

This repository is the factory itself: a Claude Code plugin that plans, builds, verifies and ships tasks to draft PRs. Read `README.md` first, then `AGENTS.md`, which holds the rules and the map of where each concern lives. This file is the loop for making a change.

## The loop

1. Branch off `main` (`feat/...` or `fix/...`); never commit to `main`. Changes to the factory are ordinary tickets done by a person or an interactive session, not by a ticket run.
2. Write the failing test first. Every behavioural change to a guard, the configuration, the QA recorder, the stop gate or a task source needs a test in `test/`. A fix without the test that failed before it is not finished.
3. Make it pass, and keep the scripts working on the macOS default bash 3.2 (no `mapfile`, no associative arrays) and on plain Node, with no dependencies.
4. Keep the documentation in step: a new setting goes in `config.json`, is validated in `scripts/config.mjs` and is documented in the README reference; a changed command, script or flow changes the README in the same commit.
5. Run the checks (below). All of them pass before a PR is opened.
6. Open a draft PR with a summary of what changed and why, how it was verified, and anything you could not verify. Commits and PR text carry no agent attribution lines.

## The checks

```bash
node --test test/*.test.mjs                        # the tests
npx prettier@3.2.5 --check "**/*.{md,json,mjs}"    # formatting (use --write to fix); do not run npm install on the host
bash scripts/lint-vocabulary.sh                    # the vocabulary lint
claude plugin validate .                           # the plugin manifest
```

`test/hygiene.test.mjs` also sweeps every tracked file for a committed `.env.local`, secret-shaped strings and the words the vocabulary lint forbids, and `test/docs.test.mjs` checks that the documentation's commands, links and anchors are real.

## Rules that are easy to break

-   Nothing in the plugin may name a company, a tracker site, a project key or a host. A host is a setting; a new tracker is a new file under `scripts/sources/` plus `skills/task-source/<name>.md`; a new MCP server is an entry in `mcp/catalog.json`.
-   The plugin is installable: commands, skills and agents run its scripts as `node "${CLAUDE_PLUGIN_ROOT}/..."`, and nothing may assume the plugin sits inside the repository it works on. State for a project goes in `.factory/` and `dev-factory.config.json`; machine state in `~/.dev-factory` (`DF_STATE_DIR`).
-   Secrets live only in `~/.dev-factory/.env.local`. Takeover (`DF_TAKEOVER`) is the machine owner's alone and is read from the environment, never from a file a run can edit.
-   Explain a rule by its reason, not by where it came from.

## Versions

Bump `version` in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` together, and say which level and why in the commit and the PR: a patch for a fix with no new behaviour or setting, a minor for new backwards-compatible behaviour or settings, a major for a removed or renamed setting or a changed default that alters behaviour (while the plugin is below 1.0, a breaking change is a minor bump).
