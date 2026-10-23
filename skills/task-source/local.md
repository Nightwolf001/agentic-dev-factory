# Local files

Tasks are markdown files with a small frontmatter block under `sources.local.dir` (default `.factory/tasks/`), one per task, named `<KEY>-<slug>.md`. They are plain files in the repository: commit them to share a plan, or keep the folder out of git for a private queue. No account, no network, no MCP.

```markdown
---
key: TASK-3
title: Add CSV export
state: ready
type: story
labels: [dev-factory]
blockedBy: [TASK-2]
updated: 2026-01-01T10:00:00.000Z
---

## Summary

...

## Acceptance criteria

-   ...

## Activity

-   2026-01-01T10:00:00.000Z [dev-factory] phase: claim started
```

Use `scripts/tasks.mjs` for every operation (see `SKILL.md`); do not hand-edit `state` or `updated` during a pass. A person edits the file freely between passes: `state: ready` queues it, `labels: [dev-factory, factory-blocked]` parks it.

`LINK` writes `branch`, `pr` and `qaVerdict` into the frontmatter and copies the QA screenshots to `evidence/<KEY>/` beside the task files, listing them under `evidence:`.

`/dev-factory:plan` writes these files. `/dev-factory:quick` needs no task at all.

Without an MCP server the scheduler still works: the preflight reads the folder directly.
