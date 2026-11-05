#!/usr/bin/env bash
# Where the factory is running and where it keeps things. Source it; do not run it.
#   df_runtime            local or cloud: DF_RUNTIME, else runtime.mode from the config, else detected
#                         (Claude Code on the web and GitHub Actions are cloud)
#   df_repo               the repository under work: DF_REPO, else the git top level of the current directory
#   df_state_dir          machine state: DF_STATE_DIR, else ~/.dev-factory
#   df_log_file JOB       DF_LOG, else the macOS log folder for a local Mac, else <state>/logs/JOB.log
#   df_slug REPO          a name for the repository, used in launchd labels and the pause switch
#   df_paused_file REPO   the pause switch file of the repository (see scripts/scheduler.sh)
#   df_job_paused_file REPO JOB   the pause switch of one job (tick or improve) of the repository
#   df_job_paused REPO JOB        true while that job's switch is set (or the older switch that paused both jobs)
#   df_interval_minutes           minutes between scheduled ticks: DF_SCHEDULER_INTERVAL_MINUTES, else scheduler.intervalMinutes
#   df_load_env           secrets: <state>/.env.local only, never a file inside the plugin directory
#   df_mcp_args REPO LOG  into DF_MCP_ARGS: the Claude arguments for the MCP servers of a pass (from mcp.mjs write-config)
# DIR is the plugin directory and must be set by the caller.
df_runtime() {
  case "${DF_RUNTIME:-}" in local|cloud) echo "$DF_RUNTIME"; return ;; esac
  local mode; mode="$(node "$DIR/scripts/config.mjs" get runtime.mode 2>/dev/null)"
  case "$mode" in local|cloud) echo "$mode"; return ;; esac
  if [ "${CLAUDE_CODE_REMOTE:-}" = true ] || [ "${GITHUB_ACTIONS:-}" = true ]; then echo cloud; else echo local; fi
}
df_repo() { printf '%s' "${DF_REPO:-$(git rev-parse --show-toplevel 2>/dev/null)}"; }
df_state_dir() { printf '%s' "${DF_STATE_DIR:-$HOME/.dev-factory}"; }
df_log_file() {
  if [ -n "${DF_LOG:-}" ]; then printf '%s' "$DF_LOG"; return; fi
  if [ "$(uname)" = Darwin ] && [ "$(df_runtime)" = local ]; then printf '%s' "$HOME/Library/Logs/dev-factory-$1.log"
  else printf '%s' "$(df_state_dir)/logs/$1.log"; fi
}
# A short name for a repository, unique to its path: launchd labels and the pause switch are per repository.
df_slug() { printf '%s-%s' "$(basename "$1" | tr -c 'A-Za-z0-9\n' '-' | sed 's/-*$//')" "$(printf '%s' "$1" | cksum | cut -d' ' -f1 | cut -c1-6)"; }
# The pause switch: while a job's file exists (df_job_paused_file), that job's scheduled passes (DF_SCHEDULED=1) do nothing; manual runs are unaffected.
# This one file is the older switch for both jobs; it is still honoured.
df_paused_file() { printf '%s' "$(df_state_dir)/paused.$(df_slug "$1")"; }
df_job_paused_file() { printf '%s.%s' "$(df_paused_file "$1")" "$2"; }
df_job_paused() { [ -f "$(df_job_paused_file "$1" "$2")" ] || [ -f "$(df_paused_file "$1")" ]; }
df_interval_minutes() {
  local m="${DF_SCHEDULER_INTERVAL_MINUTES:-}"
  [ -n "$m" ] || m="$(node "$DIR/scripts/config.mjs" get scheduler.intervalMinutes 2>/dev/null)"
  case "$m" in ''|*[!0-9]*) m=5 ;; esac
  # a leading zero is not octal here (08 would be an arithmetic error in the installer), and an absurd value is not a schedule
  m=$((10#${m:-5}))
  { [ "$m" -ge 1 ] && [ "$m" -le 1440 ]; } || m=5
  printf '%s' "$m"
}
df_load_env() {
  # Only the state folder: a run working in a clone of the plugin can write a file inside it, and the scheduler would load it.
  local f; f="$(df_state_dir)/.env.local"
  [ -f "$f" ] && { set -a; . "$f"; set +a; }
  return 0
}
df_mcp_args() {
  # The Claude arguments for the MCP servers of a pass, into the array DF_MCP_ARGS: whatever `mcp.mjs write-config` prints, one per line
  # (the strict flag only when nothing wanted is outside the generated file). Its note goes to LOG. If it fails the pass goes on with
  # the legacy .mcp.json when there is one, and LOG says why: a pass must not stop for this.
  local repo="$1" log="$2" out err l why
  DF_MCP_ARGS=()
  err="$(mktemp "${TMPDIR:-/tmp}/df-mcp-err.XXXXXX" 2>/dev/null)" || err=/dev/null
  if out="$(cd "$repo" && node "$DIR/scripts/mcp.mjs" write-config 2>"$err")"; then
    [ -s "$err" ] && sed "s/^/$(date -u +%FT%TZ) mcp: /" "$err" >> "$log"
    while IFS= read -r l; do [ -n "$l" ] && DF_MCP_ARGS+=("$l"); done <<EOF
$out
EOF
  else
    why="$(tr "\n" " " < "$err")"
    echo "$(date -u +%FT%TZ) could not write the MCP config${why:+ ($why)}; using .mcp.json when present" >> "$log"
    DF_MCP_ARGS=(); [ -f "$repo/.mcp.json" ] && DF_MCP_ARGS=(--mcp-config "$repo/.mcp.json")
  fi
  [ "$err" = /dev/null ] || rm -f "$err"
  return 0
}
