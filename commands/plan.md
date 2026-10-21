---
description: Interactive planning - grill a request into tracer-bullet Jira issues with acceptance criteria and the dev-factory label (usage /dev-factory:plan "<idea>")
argument-hint: '"<what you want built>"'
---

You plan with a person; never run this unattended. The output is Jira issues the scheduled factory can build without asking anyone anything.

1. Read `dev-factory/config.json` (projects, label, cloud id) and, for the request in $ARGUMENTS, the code it touches and `CLAUDE.md`.
2. Interview first. Use the repository's `ol-grill-me` skill: one question at a time, each with your recommended answer, until the goal, the user-visible behaviour, the edge cases and the test seams are settled. Ask nothing the code or the docs can answer.
3. Slice into tracer-bullet issues: each is a thin vertical slice that can be demoed alone (behaviour, not a layer) and fits one fresh build session. Order them so a slice only depends on an earlier one; give each its blocking edges ("is blocked by").
4. Draft every description with exactly these sections: Summary, Acceptance criteria (concrete, checkable bullets), Out of scope (at least one bullet), Testing decisions (the seam and first red test; the repo's own test command), Blocked by, and optionally `Base branch:` (a pushed branch to build on instead of develop; leave it out for develop) and `Research:` (questions for the researcher, also add the label `needs-research`) and `Telemetry:` (Sentry issue ids or Axiom queries, plus `env:<name>`). No file paths or line numbers beyond a short snippet.
5. Lint each draft before creating anything: write it to a temp file and run `node dev-factory/bin/qa.mjs ticket lint --strict true --file <file>`; fix until it exits 0. Then run `node dev-factory/bin/qa.mjs scrub --file <file>`.
6. Show the person the slice list and each description; create nothing until they approve. Then create the issues with the `ol-jira-ticket-creation` skill (project from config, label `dev-factory`, assignee the factory user, links for the blocking edges), blockers first.
7. Report the keys in dependency order.

Done when every approved issue exists in Jira with the label and its links, and each passed the strict lint.
