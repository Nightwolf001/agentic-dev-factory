#!/usr/bin/env bash
# One scheduled pass. Safe to run by hand. Exit 0 on a normal pass (including an empty frontier),
# 75 when another pass is still running, non-zero on a failed run.
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"; REPO="$(cd "$DIR/.." && pwd)"
STATE="${DF_STATE_DIR:-$HOME/.dev-factory}"; LOG="${DF_LOG:-$HOME/Library/Logs/dev-factory-tick.log}"
mkdir -p "$STATE" "$(dirname "$LOG")"

if [ -f "$DIR/.env.local" ]; then set -a; . "$DIR/.env.local"; set +a; fi
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
bash "$DIR/scripts/doctor.sh" --ci >> "$LOG" 2>&1 || { echo "$(date -u +%FT%TZ) preflight failed" >> "$LOG"; exit 1; }
git fetch origin develop --quiet >> "$LOG" 2>&1 || true

# cheap preflight: a session starts only when the check says there is work, so a Jira or gh failure costs nothing
. "$DIR/scripts/preflight.sh"
if [ "${DF_PREFLIGHT:-on}" != off ]; then
  node "$DIR/scripts/frontier.mjs" check >> "$LOG" 2>&1
  fc=$?
  reason="$(df_preflight_gate "$fc")"; gate=$?
  if [ "$gate" -ne 0 ]; then
    echo "$(date -u +%FT%TZ) pass end: $reason" >> "$LOG"
    [ "$gate" -eq 20 ] && exit 0
    exit 1
  fi
fi

claude -p "/dev-factory:tick" \
  --plugin-dir "$DIR" \
  --mcp-config "$DIR/.mcp.json" \
  --settings "$DIR/settings.factory.json" \
  --permission-prompts none \
  --model "$(node "$DIR/scripts/config.mjs" get models.orchestrator)" \
  --effort "$(node "$DIR/scripts/config.mjs" get models.effort)" \
  --max-budget-usd "$(node "$DIR/scripts/config.mjs" get caps.maxBudgetUsd)" \
  --output-format json \
  --no-session-persistence > "$STATE/last-pass.json" 2>> "$LOG"
rc=$?
cat "$STATE/last-pass.json" >> "$LOG" 2>/dev/null
# remember the frontier this session looked at only when it ended cleanly (a crash or budget stop must not hide tickets)
if [ "$rc" = 0 ] && ! grep -Eq '"is_error" *: *true' "$STATE/last-pass.json" 2>/dev/null; then
  node "$DIR/scripts/frontier.mjs" commit >> "$LOG" 2>&1 || true
else
  node "$DIR/scripts/frontier.mjs" discard >> "$LOG" 2>&1 || true
fi
node "$DIR/scripts/run-record.mjs" pass --result-file "$STATE/last-pass.json" --started "$STARTED" --exit "$rc" >> "$LOG" 2>&1 || true
echo "$(date -u +%FT%TZ) pass end rc=$rc" >> "$LOG"
exit $rc
