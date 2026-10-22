#!/usr/bin/env bash
# Where the factory is running and where it keeps things. Source it; do not run it.
#   df_runtime            local or cloud: DF_RUNTIME, else runtime.mode from the config, else detected
#                         (Claude Code on the web and GitHub Actions are cloud)
#   df_repo               the repository under work: DF_REPO, else the git top level of the current directory
#   df_state_dir          machine state: DF_STATE_DIR, else ~/.dev-factory
#   df_log_file JOB       DF_LOG, else the macOS log folder for a local Mac, else <state>/logs/JOB.log
#   df_load_env           secrets: <state>/.env.local, then the plugin's own .env.local when an older setup has one
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
df_load_env() {
  local f
  for f in "$(df_state_dir)/.env.local" "$DIR/.env.local"; do
    [ -f "$f" ] && { set -a; . "$f"; set +a; }
  done
  return 0
}
