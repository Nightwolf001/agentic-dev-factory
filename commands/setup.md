---
description: First-time setup - choose a task source, optional MCP servers and environment, and write dev-factory.config.json (usage /dev-factory:setup)
---

You set the factory up for this repository with a person. Nothing here needs an account the person does not already use, and every question has a working answer that needs no tracker and no MCP server. Never write a secret into a file other than `dev-factory/.env.local`.

1. Look first: `node dev-factory/scripts/config.mjs validate`, `ls dev-factory.config.json .mcp.json 2>/dev/null`, `gh repo view --json nameWithOwner 2>/dev/null`, `git remote -v`, the repository's default branch (`node dev-factory/scripts/worktree.mjs default-branch`), its test command and CI. Tell the person what you found in two lines.
2. Ask one question at a time, each with your recommendation:
    - **Where do tasks live?** `local` (markdown files in the repository, no account), `github` (Issues via `gh`, no MCP server, recommended when the repository is on GitHub), `notion` (a database; needs a Notion integration token and the Notion MCP server), `jira` (needs a Jira API token and the Atlassian MCP server). Details: `skills/task-source/`.
    - **What do they need to build a task?** The test command, whether there is a web UI to walk (Playwright), a mobile app (Maestro), a docker compose environment (`environment.type` `compose`, with its service, setup commands and ping URL) or neither (`none`, tests run on the host).
    - **Telemetry?** Sentry or Axiom for bug triage and post-merge validation. Skippable; bugs are then triaged from the task and a reproduction.
    - **Branches and PRs:** the base branch (default: the repository's), the branch types, size and area labels. Skippable; the defaults work.
3. Write only the keys that differ from `dev-factory/config.json` into `dev-factory.config.json` at the repository root (it merges over the defaults), for example `{"tasks": {"source": "github"}, "git": {"baseBranch": "main"}}`. If the repository's UI paths differ from the defaults, write `dev-factory.qa.yaml` (same shape as `dev-factory/qa/profiles.yaml`).
4. Enable MCP servers only for what was chosen: `node dev-factory/scripts/mcp.mjs recommend` lists suggestions; `node dev-factory/scripts/mcp.mjs enable <id>...` writes them to `.mcp.json`. Tell the person which ones need a one-time `/mcp` login.
5. Prepare the source: `node dev-factory/scripts/tasks.mjs init` (creates the labels or the folder; for notion and jira, say what to create by hand).
6. Run `node dev-factory/scripts/config.mjs validate` and `bash dev-factory/scripts/doctor.sh`; report each FAIL and warn with its fix. Do not edit anything the doctor flags without asking.
7. Finish with the next step: `/dev-factory:plan "<idea>"` to create tasks, `/dev-factory:quick "<change>"` for a small change with no task, or `bash dev-factory/scripts/install.sh --apply` to schedule unattended passes.
