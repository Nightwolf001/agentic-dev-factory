# Contributing

This repository is the factory itself. Read `README.md` for what it does and `AGENTS.md` for the rules and the map of where things live. This file is the loop for a change.

## The loop

1. Branch off `main` (`feat/...` or `fix/...`). Never commit to `main`.
2. Write the failing test first. A change to a guard, the config, the QA recorder, the stop gate or a task source needs a test in `test/`.
3. Make it pass. Scripts must run on macOS bash 3.2 (no `mapfile`, no associative arrays) and on plain Node with no dependencies.
4. Keep the docs in step. A new setting goes in `config.json`, `scripts/config.mjs`, `settings/options.json` and the table in `docs/reference.md`. A changed command or flow changes the README or the reference in the same commit.
5. Run the checks below. All must pass.
6. Open a draft PR: what changed and why, how you verified it, and what you could not verify. Commits and PR text carry no agent attribution lines.

## The checks

```bash
node --test test/*.test.mjs                        # tests
npx prettier@3.2.5 --check "**/*.{md,json,mjs}"    # formatting (--write fixes); do not run npm install on the host
bash scripts/lint-vocabulary.sh                    # vocabulary lint
claude plugin validate .                           # plugin manifest
```

## Rules that are easy to break

-   Name no company, tracker site, project key or host. A new tracker is a file under `scripts/sources/` plus `skills/task-source/<name>.md`; a new MCP server is an entry in `mcp/catalog.json`.
-   Never assume the plugin sits inside the repository it works on. Scripts run as `node "${CLAUDE_PLUGIN_ROOT}/..."`.
-   Project state goes in `.devfactory/` and `.factory/tasks/`; machine state and secrets in `~/.dev-factory`. Secrets only in `~/.dev-factory/.env.local`.
-   Explain a rule by its reason, not by where it came from.

## Versions

Bump `version` in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` together, and say which level and why in the commit and PR:

-   **patch**: a fix with no new behaviour or setting
-   **minor**: new backwards-compatible behaviour or settings (while below 1.0, a breaking change is also a minor)
-   **major**: a removed or renamed setting, or a changed default that alters behaviour
