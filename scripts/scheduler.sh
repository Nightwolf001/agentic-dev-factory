#!/usr/bin/env bash
# Switch the scheduled passes of this repository on or off, whichever scheduler runs them.
#   scheduler.sh status                  what is scheduled, and whether it is running or paused
#   scheduler.sh on  [tick|improve|all]  start the scheduled passes (default: all)
#   scheduler.sh off [tick|improve|all]  stop them
#
# launchd         `off` unloads the jobs and `on` loads them (rendering them first if they were never installed)
# github-actions  `off` disables the workflow and `on` enables it (needs gh and the workflow from `cloud init`)
# routine         a routine is switched in Claude itself (/schedule); this prints what to do
# any             `off` also sets a pause switch the scheduled passes read, so even a job that is already running
#                 its next tick does nothing; `on` clears it. Manual `dev-factory tick` runs ignore it.
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/scripts/runtime.sh"
REPO="$(df_repo)"; [ -n "$REPO" ] || { echo "run this from inside the repository (or set DF_REPO)" >&2; exit 1; }
STATE="$(df_state_dir)"; RUNTIME="$(df_runtime)"; SLUG="$(df_slug "$REPO")"; PAUSE="$(df_paused_file "$REPO")"
action="${1:-status}"; which="${2:-all}"
case "$action" in on|off|status) ;; *) echo "usage: scheduler.sh status | on [tick|improve|all] | off [tick|improve|all]" >&2; exit 3 ;; esac
case "$which" in tick) jobs="tick" ;; improve) jobs="improve" ;; all) jobs="tick improve" ;; *) echo "job must be tick, improve or all" >&2; exit 3 ;; esac

SCHED="$(node "$DIR/scripts/config.mjs" get runtime.scheduler 2>/dev/null || echo auto)"
if [ "$SCHED" = auto ]; then
  if [ "$(uname)" = Darwin ] && [ "$RUNTIME" = local ]; then SCHED=launchd
  elif [ -f "$REPO/.github/workflows/dev-factory-tick.yml" ]; then SCHED=github-actions
  else SCHED=none; fi
fi

UID_="$(id -u)"
label() { printf 'com.dev-factory.%s.%s' "$SLUG" "$1"; }
plist() { printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$(label "$1")"; }
loaded() { launchctl print "gui/$UID_/$(label "$1")" >/dev/null 2>&1; }
WORKFLOW=dev-factory-tick.yml

status() {
  echo "repository: $REPO"; echo "scheduler:  $SCHED ($RUNTIME)"
  if [ -f "$PAUSE" ]; then echo "pause switch: ON (scheduled passes do nothing)"; else echo "pause switch: off"; fi
  case "$SCHED" in
    launchd)
      for j in tick improve; do
        if [ ! -f "$(plist $j)" ]; then echo "$j: not installed (dev-factory scheduler on, or dev-factory install --apply --load)"
        elif loaded $j; then echo "$j: running"; else echo "$j: installed, stopped"; fi
      done ;;
    github-actions)
      if command -v gh >/dev/null 2>&1; then
        st="$(gh workflow list --all --json name,path,state --jq '.[] | select(.path | endswith("'$WORKFLOW'")) | .state' 2>/dev/null)"
        echo "workflow $WORKFLOW: ${st:-not found (dev-factory cloud init --github-actions)}"
      else echo "workflow $WORKFLOW: gh not installed, cannot tell"; fi ;;
    routine) echo "a routine is switched in Claude: run /schedule and list, pause or resume the dev-factory routine" ;;
    *) echo "no scheduler is configured here (runtime.scheduler is $SCHED): nothing runs by itself" ;;
  esac
}

turn_off() {
  mkdir -p "$STATE"; : > "$PAUSE"
  case "$SCHED" in
    launchd) for j in $jobs; do if loaded $j; then launchctl bootout "gui/$UID_/$(label $j)" 2>/dev/null && echo "stopped $j"; else echo "$j was not running"; fi; done ;;
    github-actions) gh workflow disable "$WORKFLOW" && echo "disabled workflow $WORKFLOW" ;;
    routine) echo "paused the pass here; also pause the routine in Claude (/schedule) so it stops starting sessions" ;;
    *) echo "no scheduler to stop; the pause switch is set" ;;
  esac
  echo "scheduled passes are off for $REPO. Turn them on again: dev-factory scheduler on"
}

turn_on() {
  rm -f "$PAUSE"
  case "$SCHED" in
    launchd)
      missing=0; for j in $jobs; do [ -f "$(plist $j)" ] || missing=1; done
      if [ $missing = 1 ]; then echo "jobs were never installed here; installing"; bash "$DIR/scripts/install.sh" --apply --load; return $?; fi
      for j in $jobs; do if loaded $j; then echo "$j already running"; else launchctl bootstrap "gui/$UID_" "$(plist $j)" && echo "started $j"; fi; done ;;
    github-actions) gh workflow enable "$WORKFLOW" && echo "enabled workflow $WORKFLOW" ;;
    routine) echo "resume the routine in Claude (/schedule); the pause switch here is cleared" ;;
    *) echo "no scheduler is configured here (runtime.scheduler is $SCHED). To schedule: dev-factory install --apply --load on a Mac, dev-factory cloud init --github-actions, or a routine" ; return 1 ;;
  esac
  echo "scheduled passes are on for $REPO"
}

case "$action" in status) status ;; off) turn_off ;; on) turn_on ;; esac
