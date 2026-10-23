#!/usr/bin/env bash
# Machine preflight. Usage: doctor.sh [--ci] [--wizard]
set -uo pipefail
CI=0; [ "${1:-}" = "--ci" ] && CI=1
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/scripts/runtime.sh"
REPO="$(df_repo)"; REPO="${REPO:-$PWD}"; RUNTIME="$(df_runtime)"
if [ "${1:-}" = "--wizard" ]; then exec bash "$DIR/scripts/wizard.sh"; fi
fail=0
ok()   { printf 'ok    %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }
warn() { printf 'warn  %s\n' "$1"; }

cfg() { node "$DIR/scripts/config.mjs" get "$1" 2>/dev/null || true; }
SOURCE="$(cfg tasks.source)"; ENV_TYPE="$(cfg environment.type)"
ok "plugin at $DIR; repository $REPO; runtime $RUNTIME"

if [ -f "$REPO/.nvmrc" ]; then
  want="$(tr -d ' v\n' < "$REPO/.nvmrc")"; have="$(node -v 2>/dev/null | sed 's/^v//;s/\..*//')"
  [ "$have" = "$want" ] && ok "node $have matches .nvmrc" || bad "node major '$have' != .nvmrc '$want'"
else
  command -v node >/dev/null && ok "node $(node -v)" || bad "node not installed"
fi
command -v git >/dev/null && ok "git present" || bad "git not installed"
gid="$(git -C "$REPO" config user.name 2>/dev/null) <$(git -C "$REPO" config user.email 2>/dev/null)>"
if [ "$gid" = " <>" ]; then bad "git user.name and user.email are not set: commits would have no author (git config --global user.name ...)"
elif printf '%s' "$gid" | grep -qiE 'claude|anthropic'; then bad "git identity is an agent ($gid): set your own user.name and user.email"
else ok "commits are made as $gid"; fi
command -v claude >/dev/null && ok "claude $(claude --version 2>/dev/null | head -1)" || bad "claude not installed"
gh auth status >/dev/null 2>&1 && ok "gh authenticated (pull requests)" || bad "gh not authenticated (gh auth login)"

if [ "$ENV_TYPE" = compose ]; then
  docker info >/dev/null 2>&1 && ok "docker reachable" || bad "docker daemon unreachable"
  docker compose version >/dev/null 2>&1 && ok "docker compose present" || bad "docker compose missing"
else
  ok "environment.type is ${ENV_TYPE:-none}: tests run on the host, no docker needed"
fi

# the task source: what it needs on this machine
case "$SOURCE" in
  local) ok "task source: local files in $(cfg sources.local.dir)" ;;
  github) ok "task source: GitHub issues (via gh)" ;;
  jira)
    [ -n "${JIRA_API_TOKEN:-}" ] && [ -n "${JIRA_EMAIL:-}" ] && ok "Jira API token set (preflight and unattended runs)" || warn "no JIRA_API_TOKEN/JIRA_EMAIL: the scheduler cannot preflight (set them in .env.local)" ;;
  notion)
    [ -n "${NOTION_TOKEN:-}" ] && ok "Notion token set (preflight and unattended runs)" || warn "no NOTION_TOKEN: the scheduler cannot preflight (set it in .env.local)" ;;
  *) bad "tasks.source '$SOURCE' is not one of local, github, notion, jira" ;;
esac

if [ "$CI" = 0 ]; then
  if [ "$(cfg mobile.appDir)" != "" ]; then
    command -v xcrun >/dev/null && xcrun simctl list runtimes 2>/dev/null | grep -q iOS && ok "iOS simulator runtime" || warn "no iOS simulator runtime (mobile lane disabled)"
    command -v maestro >/dev/null && ok "maestro $(maestro --version 2>/dev/null | head -1)" || warn "maestro missing (mobile lane disabled)"
  fi
  ENVF="$(df_state_dir)/.env.local"
  if [ -f "$ENVF" ]; then
    ok "$ENVF present"
    [ "$(stat -f %Lp "$ENVF" 2>/dev/null || stat -c %a "$ENVF" 2>/dev/null)" = 600 ] || warn "$ENVF should be mode 600 (chmod 600 $ENVF)"
  else warn "$ENVF missing (only needed for unattended runs and tracker API tokens; copy .env.example from the plugin)"; fi
else
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ]; then ok "claude credential in env"
  elif [ "${CLAUDE_CODE_REMOTE:-}" = true ]; then ok "Claude Code on the web supplies the login"
  else bad "no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (claude setup-token; in GitHub Actions a repository secret)"; fi
fi

for pl in $(node -e 'for(const x of require(process.argv[1]).plugins) if(x.required) console.log(x.id)' "$DIR/plugins.json"); do
  claude plugin list 2>/dev/null | grep -q "$pl" && ok "plugin $pl" || bad "plugin $pl not installed (claude plugin install superpowers@claude-plugins-official, or: dev-factory install --apply)"
done

# MCP servers are all optional: report what this repository enabled, and say what a missing one costs
MCP_FILE="${DF_MCP_FILE:-$REPO/.mcp.json}"
mcp_list="$(claude mcp list 2>/dev/null)"
enabled="$(DF_MCP_FILE="$MCP_FILE" node "$DIR/scripts/mcp.mjs" list 2>/dev/null | grep '^on ' | awk '{print $2}')"
if [ -z "$enabled" ]; then ok "no MCP servers enabled (all are optional: dev-factory mcp list)"; fi
for srv in $enabled; do
  if printf '%s\n' "$mcp_list" | grep -E "^($srv|plugin:dev-factory:$srv):" | grep -q 'Connected'; then ok "MCP $srv connected"
  else warn "MCP $srv enabled but not connected (in claude run /mcp; its entry in .mcp.json can be removed with: dev-factory mcp disable $srv)"; fi
done
node "$DIR/scripts/config.mjs" validate >/dev/null 2>&1 && ok "config.json valid" || bad "config.json invalid (dev-factory config validate)"
bash "$DIR/scripts/lint-vocabulary.sh" >/dev/null && ok "vocabulary lint" || bad "vocabulary lint"
exit $fail
