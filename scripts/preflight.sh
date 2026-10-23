#!/usr/bin/env bash
# Maps the exit code of `frontier.mjs check` to what a pass does. Source it; do not run it.
#   df_preflight_gate CODE   prints one reason line; returns 0 only for CODE 0 (claimable work), 20 for nothing to do,
#                            1 otherwise, so a tracker or gh failure, or a missing token, never starts a paid session
df_preflight_gate() {
  case "$1" in
    0) echo "claimable work"; return 0 ;;
    20) echo "nothing to do"; return 20 ;;
    21) echo "the task source needs a token this machine lacks, preflight cannot run (see the frontier line above, or DF_PREFLIGHT=off to start a session anyway)"; return 1 ;;
    *) echo "frontier check failed with exit $1, no session started"; return 1 ;;
  esac
}
