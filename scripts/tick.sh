#!/usr/bin/env bash
# One scheduled pass. Safe to run by hand. Exit 0 on a normal pass (including an empty frontier),
# 75 when another pass is still running, non-zero on a failed run.
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$DIR/scripts/runtime.sh"
REPO="$(df_repo)"; [ -n "$REPO" ] || { echo "dev-factory: run this from inside a git repository (or set DF_REPO)" >&2; exit 1; }
STATE="$(df_state_dir)"; LOG="$(df_log_file tick)"
mkdir -p "$STATE" "$(dirname "$LOG")"
df_load_env
# the pause switch (dev-factory scheduler off): scheduled passes stop here, manual runs go on
if [ "${DF_SCHEDULED:-}" = 1 ] && df_job_paused "$REPO" tick; then
  mkdir -p "$(dirname "$LOG")"; echo "$(date -u +%FT%TZ) paused (dev-factory scheduler on resumes)" >> "$LOG"; exit 0
fi
export DF_ACTIVE=1
export DF_OWNER_PID=$$

# single flight, with stale-lock recovery
. "$DIR/scripts/lock.sh"
df_lock_acquire "$STATE" "$LOG" pass || exit $?
trap 'df_lock_release "$STATE"' EXIT

rm -f "$STATE/active-run.json"
cd "$REPO" || exit 1
STARTED="$(date -u +%FT%TZ)"
echo "$STARTED pass start" >> "$LOG"
alert() { node "$DIR/scripts/preflight-alert.mjs" "$@"; }
doctor_out="$(bash "$DIR/scripts/doctor.sh" --ci 2>&1)"; doctor_rc=$?
printf '%s\n' "$doctor_out" >> "$LOG"
if [ "$doctor_rc" -ne 0 ]; then
  echo "$(date -u +%FT%TZ) preflight failed" >> "$LOG"
  alert record --reason "doctor: $(printf '%s\n' "$doctor_out" | grep -m1 '^FAIL' | cut -c7-)" >> "$LOG" 2>&1 || true
  exit 1
fi
git fetch origin "$(node "$DIR/scripts/worktree.mjs" default-branch)" --quiet >> "$LOG" 2>&1 || true

# cheap preflight: a session starts only when the check says there is work, so a tracker or gh failure costs nothing
. "$DIR/scripts/preflight.sh"
if [ "${DF_PREFLIGHT:-on}" != off ]; then
  node "$DIR/scripts/frontier.mjs" check >> "$LOG" 2>&1
  fc=$?
  reason="$(df_preflight_gate "$fc")"; gate=$?
  if [ "$gate" -ne 0 ]; then
    echo "$(date -u +%FT%TZ) pass end: $reason" >> "$LOG"
    # nothing to do is a healthy answer; anything else is a failure somebody should hear about once
    if [ "$gate" -eq 20 ]; then alert clear >> "$LOG" 2>&1 || true; exit 0; fi
    alert record --reason "$reason" >> "$LOG" 2>&1 || true
    exit 1
  fi
fi

alert clear >> "$LOG" 2>&1 || true

# the settings this pass runs with: the base file plus the domains and MCP servers this repository enabled
node "$DIR/scripts/factory-settings.mjs" "$STATE/settings.json" || { echo "$(date -u +%FT%TZ) could not build settings" >> "$LOG"; exit 1; }
MCP_ARGS=(); [ -f "$REPO/.mcp.json" ] && MCP_ARGS=(--mcp-config "$REPO/.mcp.json")

claude -p "/dev-factory:tick" \
  --plugin-dir "$DIR" \
  ${MCP_ARGS[@]+"${MCP_ARGS[@]}"} \
  --settings "$STATE/settings.json" \
  --permission-prompts none \
  --model "$(node "$DIR/scripts/config.mjs" get models.orchestrator)" \
  --effort "$(node "$DIR/scripts/config.mjs" get models.effort)" \
  --max-budget-usd "$(node "$DIR/scripts/config.mjs" get caps.maxBudgetUsd)" \
  --output-format json \
  --no-session-persistence > "$STATE/last-pass.json" 2>> "$LOG"
rc=$?
cat "$STATE/last-pass.json" >> "$LOG" 2>/dev/null
# remember the frontier this session looked at only when it ended cleanly (a crash or budget stop must not hide tickets). A
# pass that printed `tick: aborted <reason>` could not reach a tool it needs and looked at nothing: the next pass reads the same queue.
if [ "$rc" = 0 ] && ! grep -Eq '"is_error" *: *true' "$STATE/last-pass.json" 2>/dev/null && ! grep -q 'tick: aborted' "$STATE/last-pass.json" 2>/dev/null; then
  node "$DIR/scripts/frontier.mjs" commit >> "$LOG" 2>&1 || true
else
  node "$DIR/scripts/frontier.mjs" discard >> "$LOG" 2>&1 || true
fi
node "$DIR/scripts/run-record.mjs" pass --result-file "$STATE/last-pass.json" --started "$STARTED" --exit "$rc" >> "$LOG" 2>&1 || true
echo "$(date -u +%FT%TZ) pass end rc=$rc" >> "$LOG"
exit $rc
