#!/usr/bin/env bash
# Walks a person through the steps only they can do: choosing a task source, optional MCP servers, unattended login.
# Usage: dev-factory doctor --wizard
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/scripts/runtime.sh"
ENVF="$(df_state_dir)/.env.local"
[ -f "$ENVF" ] || { mkdir -p "$(dirname "$ENVF")"; cp "$DIR/.env.example" "$ENVF"; chmod 600 "$ENVF"; echo "created $ENVF"; }
SOURCE="$(node "$DIR/scripts/config.mjs" get tasks.source 2>/dev/null)"
echo "dev-factory setup wizard (task source: ${SOURCE:-unset})"
echo; echo "1. Task source: pick one in dev-factory.config.json at the repository root ({\"tasks\": {\"source\": \"local|github|notion|jira\"}}), or run /dev-factory:setup to be asked."
case "$SOURCE" in
  github) echo "   GitHub: run 'dev-factory tasks init' once to create the labels. No token needed beyond 'gh auth login'." ;;
  local) echo "   Local: tasks are markdown files under $(node "$DIR/scripts/config.mjs" get sources.local.dir 2>/dev/null); 'dev-factory tasks init' creates the folder." ;;
  notion) echo "   Notion: share the task database with an internal integration, put its secret in NOTION_TOKEN in $ENVF, set sources.notion.databaseId, and enable the MCP: dev-factory mcp enable notion" ;;
  jira) echo "   Jira: set sources.jira.site, cloudId and projects, put JIRA_EMAIL and JIRA_API_TOKEN in $ENVF, enable the MCP: dev-factory mcp enable atlassian, and ask an admin to allow the labels the factory adds." ;;
esac
echo; echo "2. Optional MCP servers: dev-factory mcp list   (enable with: dev-factory mcp enable ID). Servers that use OAuth need one login: start 'claude' and run /mcp."
echo; echo "3. Unattended runs only: run 'claude setup-token' and put the result in CLAUDE_CODE_OAUTH_TOKEN in $ENVF."
echo; echo "Then run: dev-factory doctor"
