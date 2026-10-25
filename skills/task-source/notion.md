# Notion

The task database is a Notion database with these properties (names are `sources.notion.properties`):

| Property     | Type                     | Use                                                                                       |
| ------------ | ------------------------ | ----------------------------------------------------------------------------------------- |
| Name         | title                    | the task title                                                                            |
| Status       | status or select         | the five states, named in `sources.notion.states`                                         |
| Tags         | multi-select             | carries `tasks.label` and `tasks.blockedLabel`                                            |
| Type         | select                   | Bug, Story, Task, Improvement (optional; default task)                                    |
| ID           | unique ID                | gives each page a stable key such as `TASK-12`                                            |
| Blocked by   | relation (this database) | optional native dependencies; a `Blocked by:` line in the page body works too             |
| Branch       | URL                      | the GitHub branch the work was built on (`sources.notion.properties.branch`)              |
| Pull request | URL                      | the draft PR (`properties.pullRequest`)                                                   |
| QA verdict   | select                   | `pass`, `fail`, `not applicable` (`properties.qaVerdict`)                                 |
| Evidence     | files                    | the QA screenshots, shown on the `QA evidence` gallery view (`properties.evidence`)       |
| Project      | select (or text)         | the repository the task belongs to (`properties.project`, value `sources.notion.project`) |

The last five are optional: a database without them still works, and the pass records the same facts in a comment instead.

One database can serve several repositories. Set `sources.notion.project` (for example `acme/sa-weddings`, the repository's `owner/name`) and the factory lists only pages whose Project is that value, and writes it on every page it creates or links. To add the property once: `notion-fetch` the database for its data source id, then `notion-update-data-source` with `ADD COLUMN "Project" SELECT()` (a select takes new options by name). Leave `project` null and no Project clause is used.

Set `sources.notion.databaseId`. The description is the page body. The scheduler's preflight reads the database with `NOTION_TOKEN` (an internal integration shared with the database); the rest of a pass uses the Notion MCP server (`node "${CLAUDE_PLUGIN_ROOT}/scripts/mcp.mjs" enable notion`, then `/mcp` to log in once).

Operations through the MCP server:

-   `LIST`: query the database (`notion-query-data-sources`, or `notion-search` scoped to it) for pages whose Tags contain `tasks.label` and whose Status is the state's name; `ready` also excludes pages tagged `tasks.blockedLabel`. Take the key from the ID property.
-   `GET`: `notion-fetch` the page; the body is the description; the page's comments (`notion-get-comments`) are the activity.
-   `SET`: `notion-update-page` with the Status property set to the state's name. If the property has no such option, comment and leave it.
-   `COMMENT`: `notion-create-comment` on the page.
-   `LINK`: `notion-update-page` with `Branch` (the branch URL), `Pull request`, `QA verdict` and, when `sources.notion.project` is set, `Project` set. For each screenshot, one file at a time:
    1. `notion-create-file-upload` with the file name. It returns `upload_url` and `upload_headers`.
    2. Send the file with one plain command, typed out in full (the shell guard allows exactly this shape and nothing broader):
       `curl -sS -X POST -H "<header: value>" … -F file=@<worktree>/.dev-factory/evidence/<KEY>/run-<N>/<name>.png <upload_url>`
       Every returned header becomes one `-H`. No variables, `$(…)`, `-o` or other flags, and no second URL: the guard refuses a command that has them. The file must be under `.dev-factory/evidence/`, and the URL must be a Notion `file_uploads/<id>/send` URL.
    3. Set `Evidence` to the array of `{"type":"file_upload","file_upload":{"id":"<id>"}}` objects (keep any files already there). If the tool refuses a file property value, put the upload's `markdown_source` into the page body with `notion-update-page` instead and say so in the comment.
       Files over 20 MiB or an upload that fails: leave `Evidence` as it is and say why in the comment; the screenshots are on the PR either way. Screenshots are walked in a test environment, but look at one before attaching if the task touched personal data.
-   `BLOCK`: add the tag, comment, set Status back to the first `ready` name.
-   `CREATE`: `notion-create-pages` in the database with Name, Status = first `ready` name, Tags = `tasks.label`, Project = `sources.notion.project` (when set), and the body; put blockers in the Blocked by relation and in a `Blocked by:` line.

Keys come from the unique-ID property: never invent one. A page without it is not buildable; block it with `needs an ID property`.
