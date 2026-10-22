# Notion

The task database is a Notion database with these properties (names are `sources.notion.properties`):

| Property   | Type                     | Use                                                                           |
| ---------- | ------------------------ | ----------------------------------------------------------------------------- |
| Name       | title                    | the task title                                                                |
| Status     | status or select         | the five states, named in `sources.notion.states`                             |
| Tags       | multi-select             | carries `tasks.label` and `tasks.blockedLabel`                                |
| Type       | select                   | Bug, Story, Task, Improvement (optional; default task)                        |
| ID         | unique ID                | gives each page a stable key such as `TASK-12`                                |
| Blocked by | relation (this database) | optional native dependencies; a `Blocked by:` line in the page body works too |

Set `sources.notion.databaseId`. The description is the page body. The scheduler's preflight reads the database with `NOTION_TOKEN` (an internal integration shared with the database); the rest of a pass uses the Notion MCP server (`node dev-factory/scripts/mcp.mjs enable notion`, then `/mcp` to log in once).

Operations through the MCP server:

-   `LIST`: query the database (`notion-query-data-sources`, or `notion-search` scoped to it) for pages whose Tags contain `tasks.label` and whose Status is the state's name; `ready` also excludes pages tagged `tasks.blockedLabel`. Take the key from the ID property.
-   `GET`: `notion-fetch` the page; the body is the description; the page's comments (`notion-get-comments`) are the activity.
-   `SET`: `notion-update-page` with the Status property set to the state's name. If the property has no such option, comment and leave it.
-   `COMMENT`: `notion-create-comment` on the page.
-   `BLOCK`: add the tag, comment, set Status back to the first `ready` name.
-   `CREATE`: `notion-create-pages` in the database with Name, Status = first `ready` name, Tags = `tasks.label`, and the body; put blockers in the Blocked by relation and in a `Blocked by:` line.

Keys come from the unique-ID property: never invent one. A page without it is not buildable; block it with `needs an ID property`.
