---
name: task-source
description: How to read and move the factory's tasks in whichever tracker the repository uses (local files, GitHub Issues, Notion or Jira). Use before any step that lists, claims, comments on, blocks or creates a task.
---

# Task source

The factory never assumes a tracker. `tasks.source` in the config names one of `local`, `github`, `notion`, `jira`, and every command speaks the operations below. This file defines them; the file next to it for your source says how to perform each one.

Read the active source with `node dev-factory/scripts/config.mjs get tasks.source`. Read its status names with `node dev-factory/scripts/config.mjs get source.states.<state>`.

## The model every source maps onto

A task has a **key** (`PREFIX-<number>`: `TASK-3` local, `GH-12` GitHub, `APP-123` Jira, `TASK-12` Notion), a title, a description, labels, a type, blockers and comments. Its status is one of five logical states:

| State        | Meaning                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| `ready`      | Labelled for the factory, unblocked, nobody working on it. The queue.           |
| `inProgress` | Claimed by a pass or a person running `/dev-factory:build`.                     |
| `inReview`   | A draft PR exists and waits for a person.                                       |
| `reviewed`   | The PR was approved or merged; QA, release and anything after belong to people. |
| `done`       | Finished. A task that blocks another must be `done` before the other is built.  |

`tasks.label` (default `dev-factory`) marks a task as the factory's. `tasks.blockedLabel` (default `factory-blocked`) marks one it gave up on until a person removes the label.

Dependencies are written in the description as a `Blocked by:` line (`Blocked by: TASK-2, TASK-3`, or a `Blocked by` heading with a list) in every source, so a plan keeps its order everywhere; Jira and Notion also carry native links. `node dev-factory/bin/qa.mjs ticket blocked-by --file F` reads them back.

## Operations

| Operation                   | What it does                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIST state`                | Tasks in that state carrying `tasks.label`, oldest or highest-ranked first. `ready` leaves out tasks with `tasks.blockedLabel`.                     |
| `LIST stale`                | `inProgress` tasks not updated for `caps.stallMinutes`: orphans of a killed pass.                                                                   |
| `GET key`                   | Title, description, type, labels, blockers (each with whether it is done), comments.                                                                |
| `SET key state`             | Moves the task. Never assume a workflow allows it: if the source refuses, leave the task, comment, and carry on.                                    |
| `COMMENT key text`          | Adds a comment or activity line. Text that came from telemetry or a person's data goes through `qa.mjs scrub` first.                                |
| `BLOCK key reason decision` | Adds `tasks.blockedLabel`, comments `[dev-factory] blocked: <reason>. Decision needed: <decision>`, returns the task to `ready`. Never retry alone. |
| `CREATE ...`                | Makes a task with title, body, type, label `tasks.label`, blockers. Used by `/dev-factory:plan` and the improvement scan.                           |

Phase comments are the resume position: every phase exit writes `[dev-factory] phase: <name> <state> run=<run-id> head=<sha>`. The latest one says where to continue; a comment `tasks.fixComment` (default `/dev-factory fix`) asks for a fix pass.

## Scripted sources (`local`, `github`)

No MCP server is involved; `scripts/tasks.mjs` performs the operations and prints JSON:

```bash
node dev-factory/scripts/tasks.mjs list --state ready            # LIST
node dev-factory/scripts/tasks.mjs list --state inProgress --stale-minutes 90
node dev-factory/scripts/tasks.mjs list --label factory-blocked --updated-within-minutes 360
node dev-factory/scripts/tasks.mjs get GH-12                      # GET
node dev-factory/scripts/tasks.mjs set-state GH-12 inProgress     # SET
node dev-factory/scripts/tasks.mjs comment GH-12 --file c.txt     # COMMENT
node dev-factory/scripts/tasks.mjs block GH-12 --reason R --decision D
node dev-factory/scripts/tasks.mjs create --title T --file body.md [--type story] [--blocked-by GH-3,GH-4] [--parent GH-1]
node dev-factory/scripts/tasks.mjs init                           # labels or folder, once
```

## MCP sources (`notion`, `jira`)

Reads for the scheduler's cheap preflight use an API token from `.env.local`; everything a pass writes goes through the tracker's MCP server (enable it with `node dev-factory/scripts/mcp.mjs enable notion|atlassian`). See `notion.md` and `jira.md`. `tasks.mjs list` also works for them when the token is set.

## Rules that hold for every source

-   The builder, reviewer, debugger and researcher agents have no tracker access. Only the scheduler pass and the interactive commands touch the tracker.
-   Read state from the tracker and GitHub, never from an agent's narrative.
-   A situation you cannot resolve becomes `BLOCK`, not a question, in an unattended pass.
