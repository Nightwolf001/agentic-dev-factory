#!/usr/bin/env bash
# Single-flight lock shared by tick.sh and improve.sh (both create worktrees and talk to the task source).
# Source it; do not run it.
#   df_lock_acquire STATE LOG NAME   0 when taken, 75 when a live holder has it (one line logged)
#   df_lock_release STATE            removes the lock and the active-run pointer
# A holder is live only when its pid is alive AND the process start time recorded with the lock still
# matches, so a recycled pid never keeps the lock, and a crashed pass never blocks the next one.

# mtime of a path in seconds, on macOS or Linux
df_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || date +%s; }

# Whether the lock directory belongs to a running pass. The winner of the mkdir fills in its start time and pid
# right after, so an empty directory is a lock being taken: wait for it, and call it abandoned only when it stays
# empty long enough that its owner must have died between the mkdir and the write.
df_lock_live() {
  local lock="$1" holder started tries=0
  [ -d "$lock" ] || return 1
  while :; do
    holder="$(cat "$lock/pid" 2>/dev/null || true)"
    started="$(cat "$lock/started" 2>/dev/null || true)"
    [ -n "$holder" ] && [ -n "$started" ] && break
    if [ $(( $(date +%s) - $(df_mtime "$lock") )) -ge 10 ] || [ "$tries" -ge 25 ]; then return 1; fi
    tries=$((tries + 1)); sleep 0.2
  done
  kill -0 "$holder" 2>/dev/null && [ "$(ps -o lstart= -p "$holder" 2>/dev/null | sed 's/^ *//;s/ *$//')" = "$started" ]
}

# start time first, pid last: a reader that sees the pid can already see the start time
df_lock_claim() {
  ps -o lstart= -p $$ | sed 's/^ *//;s/ *$//' > "$1/started"
  echo $$ > "$1/pid"
}

df_lock_acquire() {
  local state="$1" log="$2" name="$3" lock="$1/tick.lock" mutex="$1/tick.reclaim"
  if mkdir "$lock" 2>/dev/null; then df_lock_claim "$lock"; return 0; fi
  if df_lock_live "$lock"; then
    echo "$(date -u +%FT%TZ) $name skip: pass $(cat "$lock/pid" 2>/dev/null) still running" >> "$log"
    return 75
  fi
  # Replacing a dead lock is one process at a time: two reclaimers that each removed the directory would each
  # create their own and both run. A mutex left by a reclaimer that died is cleared after 30 seconds.
  if ! mkdir "$mutex" 2>/dev/null; then
    [ $(( $(date +%s) - $(df_mtime "$mutex") )) -gt 30 ] && rmdir "$mutex" 2>/dev/null
    echo "$(date -u +%FT%TZ) $name skip: lost the lock race" >> "$log"
    return 75
  fi
  if df_lock_live "$lock" || ! { rm -rf "$lock"; mkdir "$lock" 2>/dev/null; }; then
    rmdir "$mutex" 2>/dev/null
    echo "$(date -u +%FT%TZ) $name skip: lost the lock race" >> "$log"
    return 75
  fi
  df_lock_claim "$lock"
  rmdir "$mutex" 2>/dev/null
  return 0
}

df_lock_release() {
  rm -rf "$1/tick.lock" "$1/active-run.json"
}
