---
description: Show the dev-factory frontier, in-flight issues, open factory PRs and environment state
---

Report, read-only. Read `skills/task-source/SKILL.md` and the file for the active source (`node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get tasks.source`) first.

1. Frontier: LIST `ready`, with each task's blockers and whether they are done.
2. In flight: LIST `inProgress`, `inReview` and `reviewed`. Flag any `inProgress` task older than `caps.stallMinutes` as a stray, and any task carrying `tasks.blockedLabel` with its last comment.
3. Open factory PRs: `node "${CLAUDE_PLUGIN_ROOT}/scripts/open-prs.mjs"` for the count against the cap (only PRs carrying the key of an in-flight task), then `gh pr list --state open --json number,title,headRefName,isDraft` for the list.
4. Environments (only when `environment.type` is `compose`): `docker compose ls -a | grep '^df-'` and `ls ~/.dev-factory/live 2>/dev/null`; ports lock: `ls ~/.dev-factory/ports.lock 2>/dev/null`.
5. Last tick: tail `~/Library/Logs/dev-factory-tick.log`.

Print one compact table per section.
