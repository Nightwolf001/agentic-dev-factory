#!/usr/bin/env bash
# Per-machine setup. Dry run by default; --apply writes files; --load also loads the scheduler jobs.
# Works from any installed copy of the plugin (marketplace cache, a clone loaded with --plugin-dir). Inside a repository it also
# renders that repository's scheduler jobs; anywhere else it sets up the machine only (launcher, env file, plugins).
# Prefer `dev-factory install`, which finds the plugin for you.
#   install.sh [--apply] [--load] [--isolate]
# --isolate gives this repository a state folder of its own (~/.dev-factory/<slug>) for its locks, run pointer, logs and ports lock, so a
# pass in another repository no longer holds this one back. The secrets, the launcher, the plugin path, your settings for all projects
# (config.json) and the record of what the factory added to Claude (managed.json) stay the machine's. Once the folder exists, later
# installs keep the repository isolated.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/scripts/runtime.sh"
REPO="$(df_repo)"
# the machine folder: not the repository's own folder, which df_state_dir would pick once it exists
STATE="${DF_STATE_DIR:-$(df_machine_dir)}"; RUNTIME="$(df_runtime)"
APPLY=0; LOAD=0; ISOLATE=0
for a in "$@"; do case "$a" in --apply) APPLY=1 ;; --load) APPLY=1; LOAD=1 ;; --isolate) ISOLATE=1 ;; *) echo "usage: install.sh [--apply] [--load] [--isolate]" >&2; exit 3 ;; esac; done
SLUG=""; OWN=""
if [ -n "$REPO" ]; then
  SLUG="$(df_slug "$REPO")"; OWN="$STATE/$SLUG"
  [ -d "$OWN" ] && ISOLATE=1
elif [ $ISOLATE = 1 ]; then
  echo "install --isolate gives one repository a state folder of its own: run it from inside that repository (or set DF_REPO)" >&2; exit 3
fi
JOBSTATE="$STATE"; [ $ISOLATE = 1 ] && JOBSTATE="$OWN"
say() { printf '%s %s\n' "$([ $APPLY = 1 ] && echo 'do  ' || echo 'plan')" "$1"; }

echo "plugin: $DIR"; echo "runtime: $RUNTIME"
if [ -n "$REPO" ]; then echo "repository: $REPO"
else echo "no repository here: machine setup only (launcher, env file, plugins); run it in a repository to add its scheduler"; fi
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

# 3b. a state folder of its own for this repository: its locks, run pointer, logs and ports lock stay apart from every other repository's.
# What is shared is linked, not copied, so one .env.local and one launcher serve them all. The settings for all projects and managed.json
# are not linked: the scripts read them from the machine folder (machineDir in scripts/state-env.mjs), so there is only ever one of each.
if [ $ISOLATE = 1 ]; then
  say "give this repository a state folder of its own: $OWN (the secrets, launcher and plugin path stay the machine's, by link)"
  if [ $APPLY = 1 ]; then
    mkdir -p "$OWN"
    for shared in .env.local bin plugin-dir; do
      if [ -e "$OWN/$shared" ] || [ -L "$OWN/$shared" ]; then continue; fi
      if [ -e "$STATE/$shared" ]; then ln -s "../$shared" "$OWN/$shared"; fi
    done
  fi
fi

# 4. plugins the factory relies on. The marketplaces are added here; the plugins are installed by plugins.mjs from the settings
# (plugins.enabled in the user settings for every project, or in this repository's for one; the required one is always on).
# Optional ones are installed too unless DF_INSTALL_OPTIONAL=0. A marketplace or plugin that fails to install fails the run
# (after the rest were tried), so a half-installed machine is never reported as set up.
FAILED=0
while read -r id source; do
  if claude plugin marketplace list 2>/dev/null | grep -q "$id"; then say "marketplace $id already added"
  else
    say "claude plugin marketplace add $source"
    if [ $APPLY = 1 ] && ! claude plugin marketplace add "$source" >/dev/null; then echo "FAILED: claude plugin marketplace add $source" >&2; FAILED=1; fi
  fi
done < <(node -e '
  const p=require(process.argv[1]);
  for(const [n,m] of Object.entries(p.marketplaces)) console.log(n+" "+m.repo);' "$DIR/plugins.json")
PLUGIN_FLAGS="--dry-run"; [ $APPLY = 1 ] && PLUGIN_FLAGS=""
# inside a repository its own settings count too; the sync reads them from the main checkout
(cd "${REPO:-.}" && node "$DIR/scripts/plugins.mjs" sync $PLUGIN_FLAGS) || FAILED=1
# the MCP servers the settings turn on: run after the launcher is written (step 2), which a server such as jira is started through, so
# one saved by setup before this install is added now
(cd "${REPO:-.}" && node "$DIR/scripts/mcp.mjs" sync $PLUGIN_FLAGS) || FAILED=1

# 5. the scheduler, by runtime.scheduler: it belongs to a repository, so outside one there is none to set up
SCHED=none
if [ -n "$REPO" ]; then
SCHED="$(node "$DIR/scripts/config.mjs" get runtime.scheduler 2>/dev/null || echo auto)"
if [ "$SCHED" = auto ]; then
  if [ "$(uname)" = Darwin ] && [ "$RUNTIME" = local ]; then SCHED=launchd; else SCHED=none; fi
fi
INTERVAL="$(df_interval_minutes)"
fi
case "$SCHED" in
  launchd)
    for job in tick improve; do
      LABEL="com.dev-factory.$SLUG.$job"; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
      if [ "$job" = tick ]; then say "render $PLIST (every $INTERVAL minutes: dev-factory tick in $REPO)"; else say "render $PLIST (weekly, Monday 07:00: dev-factory improve in $REPO)"; fi
      if [ $APPLY = 1 ]; then
        mkdir -p "$(dirname "$PLIST")" "$JOBSTATE"   # the job runs in its state folder, which must exist
        sed -e "s#__LABEL__#$LABEL#g" -e "s#__LAUNCHER__#$LAUNCHER#g" -e "s#__JOB__#$job#g" -e "s#__REPO__#$REPO#g" -e "s#__STATE__#$JOBSTATE#g" -e "s#__HOME__#$HOME#g" -e "s#__INTERVAL__#$((INTERVAL * 60))#g" -e "s#__PATH__#$PATH#g" "$DIR/launchd/$job.plist.template" > "$PLIST"
        plutil -lint "$PLIST"
      fi
      if [ $LOAD = 1 ]; then
        launchctl bootstrap "gui/$(id -u)" "$PLIST"; say "loaded $PLIST"
        # do not wait a whole interval for the first tick
        [ "$job" = tick ] && launchctl kickstart "gui/$(id -u)/$LABEL" 2>/dev/null && say "started a tick now"
      else echo "to load: launchctl bootstrap gui/\$(id -u) $PLIST   (unload: launchctl bootout gui/\$(id -u)/$LABEL)"; fi
    done ;;
  github-actions) echo "scheduler: GitHub Actions. Run: dev-factory cloud init --github-actions   (writes .github/workflows/dev-factory-tick.yml)" ;;
  routine) echo "scheduler: a Claude Code routine. Run /schedule in claude and ask for a routine that runs /dev-factory:tick every $INTERVAL minutes in this repository (see docs/reference.md, Cloud and Claude environments)" ;;
  *) if [ -z "$REPO" ]; then echo "scheduler: skipped, there is no repository here (run install in one to add its scheduler)"
     else echo "scheduler: none on this machine (runtime.scheduler is $SCHED). Run 'dev-factory tick' by hand, or see docs/reference.md, Cloud and Claude environments"; fi ;;
esac

cat <<TXT
manual steps:
  1. in each repository, run /dev-factory:setup inside claude: it asks where tasks live (local needs nothing, github needs 'gh auth login'),
     which MCP servers and plugins you want for all projects or one, and the secrets they read
  2. change any choice later on the settings page: dev-factory settings (a tracker's OAuth login is done once: run /mcp in claude)
  3. unattended runs only: run 'claude setup-token' and save it with: pbpaste | dev-factory settings set secret:CLAUDE_CODE_OAUTH_TOKEN
     (it goes to $ENVF), and for jira or notion also the API token the scheduler's preflight uses (see .env.example)
TXT
[ $ISOLATE = 1 ] && echo "  4. this repository keeps its state in $OWN: dev-factory finds it from inside the repository; export DF_STATE_DIR=$OWN to run a script by hand"
[ "$FAILED" = 0 ] || { echo "install: a plugin, marketplace or MCP server could not be installed (see above); fix it and run again" >&2; exit 1; }
