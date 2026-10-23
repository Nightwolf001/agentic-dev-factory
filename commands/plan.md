---
description: Interactive planning - turn a request of any size into factory-ready tasks in the configured task source (usage /dev-factory:plan "<idea>")
argument-hint: '"<what you want built>"'
---

You plan with a person; never run this unattended. The output is tasks the scheduled factory can build without asking anyone anything, in whichever tracker `tasks.source` names (`node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" get tasks.source`). Read `skills/task-source/SKILL.md` and the file for that source first.

1. Read the request in $ARGUMENTS, the code it touches and the repository's `CLAUDE.md` or `AGENTS.md`.
2. Interview first: one question at a time, each with your recommended answer, until the goal, the user-visible behaviour, the edge cases and the test seams are settled. Use a grilling or brainstorming skill if one is installed. Ask nothing the code or the docs can answer.
3. Size the plan, say which size it is, and let the person overrule you:

    | Size         | Shape                                                                      | Output                                         |
    | ------------ | -------------------------------------------------------------------------- | ---------------------------------------------- |
    | Quick change | One small edit, no ordering, nothing to track                              | No task: suggest `/dev-factory:quick` and stop |
    | Single task  | One demoable slice that fits one fresh build session                       | One task                                       |
    | Feature      | Several slices that depend on each other                                   | A tracking task plus ordered slices            |
    | Initiative   | Several features or phases; later phases depend on what earlier ones teach | Phase tasks; slice only the first phase now    |

4. Slice into tracer-bullet tasks: each is a thin vertical slice that can be demoed alone (behaviour, not a layer) and fits one fresh build session. Order them so a slice only depends on an earlier one; give each its blockers. For a feature, make the tracking task first (it describes the whole and lists the slices; it does not get `tasks.label`, so the factory builds the slices, not the whole). For an initiative, later phases are written as tracking tasks without `tasks.label` until the earlier phase has landed; say so in the report.
5. Draft every description with these sections: Summary, Acceptance criteria (concrete, checkable bullets), Out of scope (at least one bullet), Testing decisions (the seam and the first red test; the repository's own test command), `Blocked by:` (task keys, or `none`), and optionally `Base branch:` (a pushed branch to build on instead of the default; leave it out for the default), `Research:` (questions for the researcher; also add the label `needs-research`) and `Telemetry:` (Sentry issue ids or log queries, plus `env:<name>`). No file paths or line numbers beyond a short snippet. A single small task may drop Testing decisions if the repository's tests already cover the area; the lint below is the arbiter.
6. Lint each draft before creating anything: write it to a temp file and run `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" ticket lint --strict true --file <file>` (`--strict true` for every size above Quick change); fix until it exits 0. Then run `node "${CLAUDE_PLUGIN_ROOT}/bin/qa.mjs" scrub --file <file>`.
7. Show the person the slice list and each description; create nothing until they approve. Then CREATE the tasks, blockers first, so each `Blocked by:` can name a real key. Label `tasks.label`. In `local` and `github` use `node "${CLAUDE_PLUGIN_ROOT}/scripts/tasks.mjs" create --title T --file F [--type story] [--blocked-by KEY,KEY] [--parent KEY]`; in `notion` and `jira` follow the source file. Run `tasks.mjs init` first when the source is new.
8. Report the keys in dependency order, which ones the factory will pick up first, and which were left out of the queue on purpose.

Done when every approved task exists in the source with the label and its blockers, and each passed the strict lint.
