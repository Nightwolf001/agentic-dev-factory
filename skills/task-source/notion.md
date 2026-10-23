# Notion

The task database is a Notion database with these properties (names are `sources.notion.properties`):

| Property     | Type                     | Use                                                                                 |
| ------------ | ------------------------ | ----------------------------------------------------------------------------------- |
| Name         | title                    | the task title                                                                      |
| Status       | status or select         | the five states, named in `sources.notion.states`                                   |
| Tags         | multi-select             | carries `tasks.label` and `tasks.blockedLabel`                                      |
| Type         | select                   | Bug, Story, Task, Improvement (optional; default task)                              |
| ID           | unique ID                | gives each page a stable key such as `TASK-12`                                      |
| Blocked by   | relation (this database) | optional native dependencies; a `Blocked by:` line in the page body works too       |
| Branch       | URL                      | the GitHub branch the work was built on (`sources.notion.properties.branch`)        |
| Pull request | URL                      | the draft PR (`properties.pullRequest`)                                             |
| QA verdict   | select                   | `pass`, `fail`, `not applicable` (`properties.qaVerdict`)                           |
| Evidence     | files                    | the QA screenshots, shown on the `QA evidence` gallery view (`properties.evidence`) |

The last four are optional: a database without them still works, and the pass records the same facts in a comment instead.

Set `sources.notion.databaseId`. The description is the page body. The scheduler's preflight reads the database with `NOTION_TOKEN` (an internal integration shared with the database); the rest of a pass uses the Notion MCP server (`node "${CLAUDE_PLUGIN_ROOT}/scripts/mcp.mjs" enable notion`, then `/mcp` to log in once).

Operations through the MCP server:

-   `LIST`: query the database (`notion-query-data-sources`, or `notion-search` scoped to it) for pages whose Tags contain `tasks.label` and whose Status is the state's name; `ready` also excludes pages tagged `tasks.blockedLabel`. Take the key from the ID property.
-   `GET`: `notion-fetch` the page; the body is the description; the page's comments (`notion-get-comments`) are the activity.
-   `SET`: `notion-update-page` with the Status property set to the state's name. If the property has no such option, comment and leave it.
-   `COMMENT`: `notion-create-comment` on the page.
-   `LINK`: `notion-update-page` with `Branch` (the branch URL), `Pull request` and `QA verdict` set. For each screenshot: `notion-create-file-upload` with the file name, send one multipart POST of the file to the returned `upload_url` with every header it lists (`curl -sS -X POST -H <header>… -F file=@<path> <upload_url>`), then set `Evidence` to the array of `{"type":"file_upload","file_upload":{"id":"<id>"}}` objects (keep any files already there). Files over 20 MiB or an upload that fails: leave `Evidence` as it is and say so in the comment; the screenshots are on the PR either way. Screenshots are walked in a test environment, but look at one before attaching if the task touched personal data.
-   `BLOCK`: add the tag, comment, set Status back to the first `ready` name.
-   `CREATE`: `notion-create-pages` in the database with Name, Status = first `ready` name, Tags = `tasks.label`, and the body; put blockers in the Blocked by relation and in a `Blocked by:` line.

Keys come from the unique-ID property: never invent one. A page without it is not buildable; block it with `needs an ID property`.
