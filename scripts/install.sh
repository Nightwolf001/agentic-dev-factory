#!/usr/bin/env bash
# Per-machine setup. Dry run by default; --apply writes files; --load also loads the scheduler.
# The plugin itself and its hooks are committed in dev-factory/; step 'enable the plugin' below turns them on for
# this machine only, in an uncommitted settings file, so no other developer's session loads them.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"; REPO="$(cd "$DIR/.." && pwd)"
APPLY=0; LOAD=0
for a in "$@"; do case "$a" in --apply) APPLY=1 ;; --load) APPLY=1; LOAD=1 ;; *) echo "usage: install.sh [--apply] [--load]" >&2; exit 3 ;; esac; done
say() { printf '%s %s\n' "$([ $APPLY = 1 ] && echo 'do  ' || echo 'plan')" "$1"; }

bash "$DIR/scripts/doctor.sh" || echo "doctor reported problems; fix them before loading the scheduler"

if [ ! -f "$DIR/.env.local" ]; then
  say "create dev-factory/.env.local from .env.example (mode 600)"
  [ $APPLY = 1 ] && { cp "$DIR/.env.example" "$DIR/.env.local"; chmod 600 "$DIR/.env.local"; }
else say "dev-factory/.env.local exists, left alone"; fi

# Turn the plugin on for this checkout only: .claude/settings.local.json is not committed
LOCAL_SETTINGS="$REPO/.claude/settings.local.json"
say "enable the dev-factory plugin in $LOCAL_SETTINGS (not committed)"
[ $APPLY = 1 ] && node "$DIR/scripts/enable-plugin.mjs" "$LOCAL_SETTINGS" "$DIR"

# Plugins the factory relies on, installed per user and project (scope local, not committed)
node -e '
  const p=require(process.argv[1]);
  for(const [n,m] of Object.entries(p.marketplaces)) console.log("marketplace "+n+" "+m.repo);
  for(const x of p.plugins) console.log("plugin "+x.id+" "+(x.required?"required":"optional"));' "$DIR/plugins.json" | while read -r kind id extra; do
  if [ "$kind" = marketplace ]; then
    if claude plugin marketplace list 2>/dev/null | grep -q "$id"; then say "marketplace $id already added"
    else say "claude plugin marketplace add $extra"; [ $APPLY = 1 ] && claude plugin marketplace add "$extra" >/dev/null; fi
  else
    if claude plugin list 2>/dev/null | grep -q "$id"; then say "plugin $id already installed"
    elif [ "$extra" = required ] || [ "${DF_INSTALL_OPTIONAL:-0}" = 1 ]; then say "claude plugin install $id --scope local"; [ $APPLY = 1 ] && claude plugin install "$id" --scope local >/dev/null
    else say "plugin $id is optional, skipped (DF_INSTALL_OPTIONAL=1 to install)"; fi
  fi
done

for job in tick improve; do
  PLIST="$HOME/Library/LaunchAgents/com.dev-factory.$job.plist"
  if [ "$job" = tick ]; then say "render $PLIST (every 15 minutes, runs scripts/tick.sh)"; else say "render $PLIST (weekly, Monday 07:00, runs scripts/improve.sh)"; fi
  if [ $APPLY = 1 ]; then
    mkdir -p "$(dirname "$PLIST")"
    sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" -e "s#__PATH__#$PATH#g" "$DIR/launchd/com.dev-factory.$job.plist.template" > "$PLIST"
    plutil -lint "$PLIST"
  fi
  if [ $LOAD = 1 ]; then launchctl bootstrap "gui/$(id -u)" "$PLIST"; say "loaded $PLIST"
  else echo "to load: launchctl bootstrap gui/\$(id -u) $PLIST   (unload: launchctl bootout gui/\$(id -u)/com.dev-factory.$job)"; fi
done

cat <<TXT
manual steps:
  1. choose the task source: dev-factory.config.json at the repository root, or /dev-factory:setup inside claude (local needs nothing, github needs 'gh auth login')
  2. optional MCP servers: node dev-factory/scripts/mcp.mjs list, then enable the ones you want (a tracker's OAuth login is done once: run /mcp in claude)
  3. unattended runs only: run 'claude setup-token', put the value in dev-factory/.env.local as CLAUDE_CODE_OAUTH_TOKEN,
     and for jira or notion also the API token the scheduler's preflight uses (see .env.example)
TXT
