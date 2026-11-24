#!/usr/bin/env bash
# Weekly self-improvement pass. Safe to run by hand. Exit 75 when another pass or improvement scan is running.
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# refuse an unknown argument before anything is read or created; --dry-run sets DF_DRY_RUN=1
. "$DIR/scripts/pass-args.sh"; df_pass_args improve.sh "--dry-run" -- "$@"
. "$DIR/scripts/runtime.sh"
REPO="$(df_repo)"; [ -n "$REPO" ] || { echo "dev-factory: run this from inside a git repository (or set DF_REPO)" >&2; exit 1; }
# A job rendered before every repository had its own folder names the machine folder in DF_STATE_DIR: that pin would put this
# repository's pass lock back in the one folder all repositories share, so it is dropped and the repository's own folder used.
if [ "${DF_STATE_DIR:-}" = "$HOME/.dev-factory" ] && [ -n "$(df_main_repo)" ]; then unset DF_STATE_DIR; fi
STATE="$(df_state_dir)"; LOG="$(df_log_file improve)"
mkdir -p "$STATE" "$(dirname "$LOG")"
# every repository has a state folder of its own, so a pass here never waits on a pass in another repository; the session and every
# script it starts read the same folder
df_ensure_state_dir "$STATE"; export DF_STATE_DIR="$STATE"
df_load_env
# the pause switch (dev-factory scheduler off): scheduled passes stop here, manual runs go on; a dry run is a person's request, so it ignores the switch
if [ "$DF_DRY_RUN" = 0 ] && [ "${DF_SCHEDULED:-}" = 1 ] && df_job_paused "$REPO" improve; then
  mkdir -p "$(dirname "$LOG")"; echo "$(date -u +%FT%TZ) paused (dev-factory scheduler on resumes)" >> "$LOG"; exit 0
fi
export DF_ACTIVE=1
export DF_OWNER_PID=$$

# share the single-flight lock with the tick: both create worktrees and talk to the task source
. "$DIR/scripts/lock.sh"
df_lock_acquire "$STATE" "$LOG" improve; rc=$?
if [ "$rc" != 0 ]; then
  [ "$DF_DRY_RUN" = 1 ] && echo "improve: dry run skipped: another pass holds the lock (log: $LOG)" >&2
  exit $rc
fi
trap 'df_lock_release "$STATE"' EXIT

# the old pointer only; agent bindings stay, since interactive sessions share this folder (a binding expires on its own)
rm -f "$STATE/active-run.json"
cd "$REPO" || exit 1
echo "$(date -u +%FT%TZ) improve start" >> "$LOG"
bash "$DIR/scripts/doctor.sh" --ci >> "$LOG" 2>&1 || {
  echo "$(date -u +%FT%TZ) preflight failed" >> "$LOG"
  [ "$DF_DRY_RUN" = 1 ] && echo "improve: dry run stopped: the doctor failed (log: $LOG)" >&2
  exit 1
}
# a dry run changes nothing, so it does not fetch
[ "$DF_DRY_RUN" = 1 ] || git fetch origin "$(node "$DIR/scripts/worktree.mjs" default-branch)" --quiet >> "$LOG" 2>&1 || true

# the worktree folder must exist before the settings name it, or the sandbox has no folder to allow writes in
mkdir -p "$(node "$DIR/scripts/worktree.mjs" root 2>/dev/null || echo "$REPO/../.worktrees")" 2>/dev/null || true
node "$DIR/scripts/factory-settings.mjs" "$STATE/settings.json" || {
  echo "$(date -u +%FT%TZ) could not build settings" >> "$LOG"
  [ "$DF_DRY_RUN" = 1 ] && echo "improve: dry run stopped: could not build the settings (log: $LOG)" >&2
  exit 1
}
# the MCP servers this pass starts from: the generated .devfactory/mcp.json, with the flags write-config chose
df_mcp_args "$REPO" "$LOG"

PROMPT="/dev-factory:improve"; [ "$DF_DRY_RUN" = 1 ] && PROMPT="$PROMPT --dry-run"
run_claude() {
  claude -p "$PROMPT" \
    --plugin-dir "$DIR" \
    ${DF_MCP_ARGS[@]+"${DF_MCP_ARGS[@]}"} \
    --settings "$STATE/settings.json" \
    --permission-prompts none \
    --model "$(node "$DIR/scripts/config.mjs" get models.improver)" \
    --effort "$(node "$DIR/scripts/config.mjs" get models.efforts.improver)" \
    --max-budget-usd "$(node "$DIR/scripts/config.mjs" get caps.maxBudgetUsd)" \
    --output-format json \
    --no-session-persistence
}
# a dry run is read by a person: its output goes to the terminal as well as the log (pipefail keeps rc claude's)
if [ "$DF_DRY_RUN" = 1 ]; then run_claude 2>&1 | tee -a "$LOG"; else run_claude >> "$LOG" 2>&1; fi
rc=$?
echo "$(date -u +%FT%TZ) improve end rc=$rc" >> "$LOG"
exit $rc
