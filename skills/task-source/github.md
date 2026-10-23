# GitHub Issues

Driven entirely by the `gh` CLI the PR flow already needs; no MCP server and no extra token. Keys are `GH-<issue number>`.

| Logical state | On GitHub                                                                     |
| ------------- | ----------------------------------------------------------------------------- |
| `ready`       | open, labelled `tasks.label`, none of the state labels, not `factory-blocked` |
| `inProgress`  | label `df:in-progress`                                                        |
| `inReview`    | label `df:in-review`                                                          |
| `reviewed`    | label `df:reviewed`                                                           |
| `done`        | the issue is closed                                                           |

The state label names live in `sources.github.states`. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/tasks.mjs" init` once to create all the labels. `sources.github.repo` (`owner/name`) defaults to the current repository; `sources.github.assignee` (for example `@me`) restricts the queue to issues assigned to the factory's account, otherwise any issue with the label qualifies.

Dependencies: a `Blocked by: #12, #13` line (or `GH-12`) in the issue body. A blocker that is closed counts as done; one that cannot be read counts as open.

Plans: `/dev-factory:plan` creates one issue per slice with `gh issue create`, blockers first, and links each to its parent with a `Parent: GH-<n>` line (a parent issue is a tracking issue; the factory builds the slices, not the parent).

Link PRs to issues with `Closes #<n>` in the PR body only when the repository wants merges to close issues; the factory moves state labels itself and closes the issue when a person merges.
