---
description: Show the dev-factory frontier, in-flight issues, open factory PRs and environment state
---

Report, read-only:

1. Frontier: Jira search `project in ("OAPP", "PLAT", "ONE", "MAX") AND sprint in openSprints() AND status in ("Ready for Dev", "To Do") AND assignee = currentUser() AND labels = dev-factory ORDER BY Rank ASC`, with each issue's blocked-by links.
2. In flight: same query with `status in ("In Progress", "Peer review", "Ready for QA")` (use `jira.statuses.*`).
3. Open factory PRs: `gh pr list --author @me --state open --label ai-tooling --json number,title,headRefName,isDraft` (adjust the label to what the tick applies).
4. Environments: `docker compose ls -a | grep '^df-'` and `ls ~/.dev-factory/live 2>/dev/null`; ports lock: `ls ~/.dev-factory/ports.lock 2>/dev/null`.
5. Last tick: tail `~/Library/Logs/dev-factory-tick.log`.

Print one compact table per section.
