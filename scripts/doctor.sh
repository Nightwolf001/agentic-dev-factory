#!/usr/bin/env bash
# Machine preflight. Usage: doctor.sh [--ci] [--wizard]
set -uo pipefail
CI=0; [ "${1:-}" = "--ci" ] && CI=1
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/scripts/runtime.sh"
REPO="$(df_repo)"; REPO="${REPO:-$PWD}"; RUNTIME="$(df_runtime)"
df_load_env   # the machine secrets file, so a token kept there counts as set (as it does for a scheduled pass)
if [ "${1:-}" = "--wizard" ]; then exec bash "$DIR/scripts/wizard.sh"; fi
fail=0
ok()   { printf 'ok    %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }
warn() { printf 'warn  %s\n' "$1"; }

cfg() { node "$DIR/scripts/config.mjs" get "$1" 2>/dev/null || true; }
SOURCE="$(cfg tasks.source)"; ENV_TYPE="$(cfg environment.type)"
ok "plugin at $DIR; repository $REPO; runtime $RUNTIME"

have_full="$(node -v 2>/dev/null | sed 's/^v//')"; have="${have_full%%.*}"
if [ -f "$REPO/.nvmrc" ]; then
  want="$(tr -d ' \r\n' < "$REPO/.nvmrc" | sed 's/^v//')"
  case "$want" in
    [0-9]*)
      if [ "$have" != "${want%%.*}" ]; then bad "node $have_full but .nvmrc wants $want (nvm use)"
      elif [ "$want" != "$have_full" ] && [ "$want" != "$have" ]; then ok "node $have_full (.nvmrc says $want: same major)"
      else ok "node $have_full matches .nvmrc"; fi ;;
    *) command -v node >/dev/null && ok "node $have_full (.nvmrc says $want, not a version number: not compared)" || bad "node not installed" ;;
  esac
else
  command -v node >/dev/null && ok "node v$have_full" || bad "node not installed"
fi
command -v git >/dev/null && ok "git present" || bad "git not installed"
gid="$(git -C "$REPO" config user.name 2>/dev/null) <$(git -C "$REPO" config user.email 2>/dev/null)>"
if [ "$gid" = " <>" ]; then bad "git user.name and user.email are not set: commits would have no author (git config --global user.name ...)"
elif printf '%s' "$gid" | grep -qiE 'claude|anthropic'; then bad "git identity is an agent ($gid): set your own user.name and user.email"
else ok "commits are made as $gid"; fi
command -v claude >/dev/null && ok "claude $(claude --version 2>/dev/null | head -1)" || bad "claude not installed"
# one retry: a scheduled pass that starts while the network is still waking would otherwise fail on a blip
if gh auth status >/dev/null 2>&1 || { sleep "${DF_GH_RETRY_SECONDS:-2}"; gh auth status >/dev/null 2>&1; }; then ok "gh authenticated (pull requests)"; else bad "gh not authenticated (gh auth login)"; fi

if [ "$ENV_TYPE" = compose ]; then
  docker info >/dev/null 2>&1 && ok "docker reachable" || bad "docker daemon unreachable"
  if docker compose version >/dev/null 2>&1; then
    cv="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
    # the isolated environments strip published ports with `ports: !reset []`, which needs Compose 2.24
    if [ -n "$cv" ] && [ "$(printf '%s\n2.24.0\n' "$cv" | sort -V | head -1)" != 2.24.0 ]; then bad "docker compose $cv is older than 2.24 (needed to isolate ports): update Docker"
    else ok "docker compose ${cv:-present}"; fi
  else bad "docker compose missing"; fi
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

case "${DF_TAKEOVER:-}" in 1|true|yes|on|TRUE|YES|ON|True|Yes|On) warn "DF_TAKEOVER is on: agents may stop any process, container or simulator that blocks a run (never the shell, Claude or the terminal)" ;; esac
[ -f "$DIR/.env.local" ] && warn "$DIR/.env.local is ignored: secrets are read only from $(df_state_dir)/.env.local (move the values there and delete this file)"

if [ "$CI" = 0 ]; then
  if [ "$(cfg mobile.appDir)" != "" ]; then
    command -v xcrun >/dev/null && xcrun simctl list runtimes 2>/dev/null | grep -q iOS && ok "iOS simulator runtime" || warn "no iOS simulator runtime (mobile lane disabled)"
    command -v maestro >/dev/null && ok "maestro $(maestro --version 2>/dev/null | head -1)" || warn "maestro missing (mobile lane disabled)"
    # Maestro is a Java program: a machine without a runtime fails at the first flow
    if command -v maestro >/dev/null; then java -version >/dev/null 2>&1 && ok "java runtime (Maestro needs one)" || warn "no java runtime: Maestro cannot run a flow (install a JDK)"; fi
    # the Android lane: only reported, since iOS is the default
    SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
    if command -v adb >/dev/null || [ -x "$SDK/platform-tools/adb" ]; then
      ok "Android: adb present"
      { command -v emulator >/dev/null || [ -x "$SDK/emulator/emulator" ]; } && ok "Android: emulator present" || warn "Android: no emulator binary (set ANDROID_SDK_ROOT); the Android lane is disabled"
    else warn "Android SDK not found (adb): the Android lane is disabled; iOS tickets are not affected"; fi
  fi
  # remote QA: every account of every remote environment needs its two variables, by name
  while read -r renv racct; do
    [ -n "$racct" ] || continue
    u="$(printf 'DF_REMOTE_%s_%s_USER' "$renv" "$racct" | tr '[:lower:]-' '[:upper:]_')"; p="$(printf 'DF_REMOTE_%s_%s_PASSWORD' "$renv" "$racct" | tr '[:lower:]-' '[:upper:]_')"
    if [ -n "${!u:-}" ] && [ -n "${!p:-}" ]; then ok "remote QA account $racct for $renv: $u and $p are set"
    else warn "remote QA account $racct for $renv: set $u and $p in $(df_state_dir)/.env.local (a remote ticket cannot sign in without them)"; fi
  done < <(node -e 'try{const c=require("child_process").execFileSync("node",[process.argv[1],"get","environments"],{encoding:"utf8"});for(const [n,e] of Object.entries(JSON.parse(c)))for(const a of e?.remote?.accounts??[])console.log(n,a)}catch(e){}' "$DIR/scripts/config.mjs")
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

# optional plugins are reported, not required: say what a missing one costs and how to add it
for pl in $(node -e 'for(const x of require(process.argv[1]).plugins) if(!x.required) console.log(x.id)' "$DIR/plugins.json"); do
  claude plugin list 2>/dev/null | grep -q "$pl" && ok "optional plugin $pl" || warn "optional plugin $pl is not installed (dev-factory install --apply installs it; DF_INSTALL_OPTIONAL=0 skips optional plugins)"
done

# a scheduled job needs a real terminal type and a UTF-8 locale (project scripts that call tput or pod install fail without them)
if [ "$(uname)" = Darwin ] && [ "$CI" = 0 ]; then
  for job in tick improve; do
    pl="$HOME/Library/LaunchAgents/com.dev-factory.$(df_slug "$REPO").$job.plist"
    [ -f "$pl" ] || continue
    miss=""
    for k in TERM LANG LC_ALL; do grep -q "<key>$k</key>" "$pl" || miss="$miss $k"; done
    grep -A1 '<key>WorkingDirectory</key>' "$pl" | grep -q "$(df_state_dir)" || miss="$miss WorkingDirectory"
    [ -z "$miss" ] && ok "scheduled job $job has TERM, LANG, LC_ALL and the state folder as working directory" || warn "the installed $job job lacks:$miss (dev-factory install --apply --load renders it again)"
  done
fi
alert="$(node "$DIR/scripts/preflight-alert.mjs" show 2>/dev/null)"
[ -z "$alert" ] || warn "$alert"

# MCP servers are all optional: report what is in use, wherever it is configured, and say what a missing one costs
MCP_FILE="${DF_MCP_FILE:-$REPO/.mcp.json}"
while IFS= read -r line; do
  case "$line" in ok*) ok "${line#ok }" ;; warn*) warn "${line#warn }" ;; esac
done < <(DF_MCP_FILE="$MCP_FILE" node "$DIR/scripts/mcp.mjs" doctor 2>/dev/null | sed 's/^ok   */ok /;s/^warn  */warn /')
node "$DIR/scripts/config.mjs" validate >/dev/null 2>&1 && ok "config.json valid" || bad "config.json invalid (dev-factory config validate)"
bash "$DIR/scripts/lint-vocabulary.sh" >/dev/null && ok "vocabulary lint" || bad "vocabulary lint"
exit $fail
