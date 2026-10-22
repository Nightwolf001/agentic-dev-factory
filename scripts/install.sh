#!/usr/bin/env bash
# Per-machine setup. Dry run by default; --apply writes files; --load also loads the scheduler jobs.
# Works from any installed copy of the plugin (marketplace cache, a clone loaded with --plugin-dir) and for the repository
# you run it in. Prefer `dev-factory install`, which finds the plugin for you.
#   install.sh [--apply] [--load]
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/scripts/runtime.sh"
REPO="$(df_repo)"; [ -n "$REPO" ] || { echo "run this from inside the repository the factory should work on (or set DF_REPO)" >&2; exit 1; }
STATE="$(df_state_dir)"; RUNTIME="$(df_runtime)"
APPLY=0; LOAD=0
for a in "$@"; do case "$a" in --apply) APPLY=1 ;; --load) APPLY=1; LOAD=1 ;; *) echo "usage: install.sh [--apply] [--load]" >&2; exit 3 ;; esac; done
say() { printf '%s %s\n' "$([ $APPLY = 1 ] && echo 'do  ' || echo 'plan')" "$1"; }

echo "plugin: $DIR"; echo "repository: $REPO"; echo "runtime: $RUNTIME"
bash "$DIR/scripts/doctor.sh" || echo "doctor reported problems; fix them before loading the scheduler"

# 1. the plugin itself is installed by Claude Code, not by this script
if claude plugin list 2>/dev/null | grep -q 'dev-factory@'; then say "plugin dev-factory already installed"
else echo "note: dev-factory is not installed as a plugin here. Install it once: claude plugin marketplace add <owner>/<repo> && claude plugin install dev-factory@dev-factory (or run claude with --plugin-dir $DIR)"; fi

# 2. a stable launcher: finds the newest installed copy, so scheduled jobs survive plugin updates
LAUNCHER="$STATE/bin/dev-factory"
say "write the launcher $LAUNCHER (add $STATE/bin to PATH, or use /dev-factory:* commands)"
if [ $APPLY = 1 ]; then
  mkdir -p "$STATE/bin"; printf '%s\n' "$DIR" > "$STATE/plugin-dir"
  cat > "$LAUNCHER" <<'LAUNCH'
#!/usr/bin/env bash
# Runs the newest installed dev-factory plugin. DF_PLUGIN_DIR overrides; otherwise the marketplace cache, then the
# directory recorded when `install` last ran.
STATE="${DF_STATE_DIR:-$HOME/.dev-factory}"
DIR="${DF_PLUGIN_DIR:-}"
if [ -z "$DIR" ]; then
  DIR="$(ls -d "${CLAUDE_CODE_PLUGIN_CACHE_DIR:-$HOME/.claude/plugins/cache}"/*/dev-factory/*/ 2>/dev/null | sed 's#/$##' | sort -V | tail -1)"
fi
[ -n "$DIR" ] && [ -d "$DIR" ] || DIR="$(cat "$STATE/plugin-dir" 2>/dev/null)"
[ -n "$DIR" ] && [ -x "$DIR/bin/dev-factory" ] || { echo "dev-factory plugin not found (install it, or set DF_PLUGIN_DIR)" >&2; exit 1; }
exec "$DIR/bin/dev-factory" "$@"
LAUNCH
  chmod +x "$LAUNCHER"
fi

# 3. secrets for unattended runs live in the machine state folder, never in a repository
ENVF="$STATE/.env.local"
if [ ! -f "$ENVF" ]; then
  say "create $ENVF from .env.example (mode 600)"
  if [ $APPLY = 1 ]; then mkdir -p "$STATE"; cp "$DIR/.env.example" "$ENVF"; chmod 600 "$ENVF"; fi
else say "$ENVF exists, left alone"; fi

# 4. plugins the factory relies on
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

# 5. the scheduler, by runtime.scheduler
SCHED="$(node "$DIR/scripts/config.mjs" get runtime.scheduler 2>/dev/null || echo auto)"
if [ "$SCHED" = auto ]; then
  if [ "$(uname)" = Darwin ] && [ "$RUNTIME" = local ]; then SCHED=launchd; else SCHED=none; fi
fi
SLUG="$(basename "$REPO" | tr -c 'A-Za-z0-9\n' '-' | sed 's/-*$//')-$(printf '%s' "$REPO" | cksum | cut -d' ' -f1 | cut -c1-6)"
case "$SCHED" in
  launchd)
    for job in tick improve; do
      LABEL="com.dev-factory.$SLUG.$job"; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
      if [ "$job" = tick ]; then say "render $PLIST (every 15 minutes: dev-factory tick in $REPO)"; else say "render $PLIST (weekly, Monday 07:00: dev-factory improve in $REPO)"; fi
      if [ $APPLY = 1 ]; then
        mkdir -p "$(dirname "$PLIST")"
        sed -e "s#__LABEL__#$LABEL#g" -e "s#__LAUNCHER__#$LAUNCHER#g" -e "s#__JOB__#$job#g" -e "s#__REPO__#$REPO#g" -e "s#__STATE__#$STATE#g" -e "s#__HOME__#$HOME#g" -e "s#__PATH__#$PATH#g" "$DIR/launchd/$job.plist.template" > "$PLIST"
        plutil -lint "$PLIST"
      fi
      if [ $LOAD = 1 ]; then launchctl bootstrap "gui/$(id -u)" "$PLIST"; say "loaded $PLIST"
      else echo "to load: launchctl bootstrap gui/\$(id -u) $PLIST   (unload: launchctl bootout gui/\$(id -u)/$LABEL)"; fi
    done ;;
  github-actions) echo "scheduler: GitHub Actions. Run: dev-factory cloud init --github-actions   (writes .github/workflows/dev-factory-tick.yml)" ;;
  routine) echo "scheduler: a Claude Code routine. Run /schedule in claude and ask for a routine that runs /dev-factory:tick every 15 minutes in this repository (see README, Cloud and scheduled runs)" ;;
  *) echo "scheduler: none on this machine (runtime.scheduler is $SCHED). Run 'dev-factory tick' by hand, or see README, Cloud and scheduled runs" ;;
esac

cat <<TXT
manual steps:
  1. choose the task source: dev-factory.config.json at the repository root, or /dev-factory:setup inside claude (local needs nothing, github needs 'gh auth login')
  2. optional MCP servers: dev-factory mcp connect (a tracker's OAuth login is done once: run /mcp in claude)
  3. unattended runs only: run 'claude setup-token', put the value in $ENVF as CLAUDE_CODE_OAUTH_TOKEN,
     and for jira or notion also the API token the scheduler's preflight uses (see .env.example)
TXT
