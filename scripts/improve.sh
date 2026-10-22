#!/usr/bin/env bash
# Weekly self-improvement pass. Safe to run by hand. Exit 75 when another pass or improvement scan is running.
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"; REPO="$(cd "$DIR/.." && pwd)"
STATE="${DF_STATE_DIR:-$HOME/.dev-factory}"; LOG="${DF_LOG:-$HOME/Library/Logs/dev-factory-improve.log}"
mkdir -p "$STATE" "$(dirname "$LOG")"
if [ -f "$DIR/.env.local" ]; then set -a; . "$DIR/.env.local"; set +a; fi
export DF_ACTIVE=1
export DF_OWNER_PID=$$

# share the single-flight lock with the tick: both create worktrees and talk to the task source
. "$DIR/scripts/lock.sh"
df_lock_acquire "$STATE" "$LOG" improve || exit $?
trap 'df_lock_release "$STATE"' EXIT

rm -f "$STATE/active-run.json"
cd "$REPO" || exit 1
echo "$(date -u +%FT%TZ) improve start" >> "$LOG"
bash "$DIR/scripts/doctor.sh" --ci >> "$LOG" 2>&1 || { echo "$(date -u +%FT%TZ) preflight failed" >> "$LOG"; exit 1; }
git fetch origin "$(node "$DIR/scripts/worktree.mjs" default-branch)" --quiet >> "$LOG" 2>&1 || true

node "$DIR/scripts/factory-settings.mjs" "$STATE/settings.json" || { echo "$(date -u +%FT%TZ) could not build settings" >> "$LOG"; exit 1; }
MCP_ARGS=(); [ -f "$REPO/.mcp.json" ] && MCP_ARGS=(--mcp-config "$REPO/.mcp.json")

claude -p "/dev-factory:improve" \
  --plugin-dir "$DIR" \
  ${MCP_ARGS[@]+"${MCP_ARGS[@]}"} \
  --settings "$STATE/settings.json" \
  --permission-prompts none \
  --model "$(node "$DIR/scripts/config.mjs" get models.improver)" \
  --effort "$(node "$DIR/scripts/config.mjs" get models.efforts.improver)" \
  --max-budget-usd "$(node "$DIR/scripts/config.mjs" get caps.maxBudgetUsd)" \
  --output-format json \
  --no-session-persistence >> "$LOG" 2>&1
rc=$?
echo "$(date -u +%FT%TZ) improve end rc=$rc" >> "$LOG"
exit $rc
