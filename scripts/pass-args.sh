#!/usr/bin/env bash
# The arguments of a pass script (tick.sh, improve.sh). Source it; do not run it.
#   df_pass_args NAME ALLOWED -- "$@"   NAME is the script's name for messages, ALLOWED the space-separated flags it accepts ("" for none).
#                                       Sets DF_DRY_RUN to 1 when --dry-run is among the arguments, else 0. Any other argument is
#                                       refused with a line on stderr and exit 2, so a mistyped flag never starts a real pass.
# Call it first, before anything is read or created: a refused argument must leave no trace. Bash 3.2 safe.
df_pass_args() {
  local name="$1" allowed="$2" a f ok
  shift 2
  [ "${1:-}" = -- ] && shift
  DF_DRY_RUN=0
  for a in "$@"; do
    ok=0
    for f in $allowed; do [ "$a" = "$f" ] && ok=1; done
    if [ "$ok" = 0 ]; then
      echo "$name: unknown argument '$a' (accepted: ${allowed:-none})" >&2
      exit 2
    fi
    [ "$a" = --dry-run ] && DF_DRY_RUN=1
  done
  return 0
}
