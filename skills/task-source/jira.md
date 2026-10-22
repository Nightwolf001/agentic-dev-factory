# Jira

Needs `sources.jira.site`, `cloudId` and `projects`. The scheduler's preflight reads Jira with `JIRA_EMAIL` and `JIRA_API_TOKEN`; the rest of a pass uses the Atlassian MCP server (`node "${CLAUDE_PLUGIN_ROOT}/scripts/mcp.mjs" enable atlassian`, then `/mcp` to log in once). If that login does not survive unattended runs, put the API token in `.env.local` and use an API-token MCP server in `.mcp.json` instead.

Status names are `sources.jira.states`; the defaults are Ready for Dev / To Do (ready), In Progress, Peer review (inReview), Ready for QA (reviewed), Done. Add the statuses your workflow uses after review to `states.done` (for example UAT, Ready for Release); they count as done for blockers and validation. `requireSprint: true` limits the queue to issues in an open sprint.

Workflows differ per issue type and project, so never assume a transition exists or is called what you expect: to move an issue, fetch its transitions and pick the one whose target status (`to.name`) is the status you want, whatever the transition is named. If none is offered, do not improvise: leave the status, comment `[dev-factory] transition to <status> not available for this issue type`, and carry on.

Searches (always quote project keys: `MAX` and others are reserved words):

-   ready: `project in ("A","B") AND assignee = currentUser() AND labels = "<tasks.label>" AND labels != "<tasks.blockedLabel>" AND status in (<ready names>) ORDER BY Rank ASC` (add `AND sprint in openSprints()` when `requireSprint`)
-   stale: same filter with `status = "<inProgress>" AND updated <= -<caps.stallMinutes>m`
-   breaker: `labels = "<tasks.blockedLabel>" AND updated >= -<caps.breakerWindowHours>h`
-   validation: `... AND labels not in ("factory-validated","factory-regression") AND status in (<done names>) AND updated <= -<validation.minHoursAfterMerge>h AND updated >= -30d`

Blockers are `is blocked by` links: a blocker counts as done when its status is in `states.done` or its status category is Done. Read them with the issue. `kind` comes from the issue type: a type in `tasks.bugTypes` is `bug`; Story, Epic and Feature are `story`; Improvement is `improvement`; everything else is `task`.

Create issues with the project's own issue-creation skill if one exists, else with the MCP create tool: label `tasks.label`, assignee the factory user, a link for each blocker, blockers first.
