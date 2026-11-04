#!/usr/bin/env bash
# Signs the QA account in on the device with the plugin's Maestro login flow, without the account's password reaching the
# transcript of the agent that runs it.
#
#   qa-login.sh [--worktree DIR] [--app-id ID] [--flow FILE]
#
# The NAMES of the variables that hold the account come from .dev-factory/env.json (remote.userVar and remote.passwordVar, written
# by `e2e-env.sh up --remote ENV --account NAME`); the values are read from this process's environment and handed to Maestro
# only through its environment (MAESTRO_QA_USER, MAESTRO_QA_PASSWORD), never as arguments, where `ps` would show them. Everything
# Maestro prints passes through a filter that replaces the values with ***, and the masked log is kept in .dev-factory/qa-login.log.
# The element ids are mobile.login in the settings; the app id is --app-id, DF_APP_ID or mobile.appId.
#
# Exit codes: 0 signed in, 1 the flow failed, 2 not set up (no account recorded, a variable unset, no app id, no device).
set -uo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR="$(cd "$SELF_DIR/.." && pwd)"
WORKTREE="$(pwd)"; APP_ID="${DF_APP_ID:-}"; FLOW="$DIR/qa/maestro/login.yaml"
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WORKTREE="$(cd "${2:-.}" && pwd)"; shift 2 ;;
    --app-id) APP_ID="${2:-}"; shift 2 ;;
    --flow) FLOW="${2:-}"; shift 2 ;;
    *) echo "qa-login: unknown argument $1" >&2; exit 2 ;;
  esac
done
ENV_JSON="$WORKTREE/.dev-factory/env.json"
LOG="$WORKTREE/.dev-factory/qa-login.log"
setup() { echo "qa-login: $*" >&2; exit 2; }

[ -f "$ENV_JSON" ] || setup "no environment recorded in $ENV_JSON"
field() { node -e "try{const j=require('$ENV_JSON');process.stdout.write(String(('$1').split('.').reduce((o,k)=>o==null?undefined:o[k],j)??''))}catch(e){}"; }
USER_VAR="$(field remote.userVar)"; PASS_VAR="$(field remote.passwordVar)"
[ -n "$USER_VAR" ] && [ -n "$PASS_VAR" ] || setup "the recorded environment has no QA account (start it with e2e-env.sh up --remote ENV --account NAME)"
# only names that look like names are used as variable names
# only the QA account variables e2e-env.sh names: a forged record must not make this read some other secret of the environment
printf '%s\n%s\n' "$USER_VAR" "$PASS_VAR" | grep -Eqv '^DF_REMOTE_[A-Z0-9_]+_(USER|PASSWORD)$' && setup "the recorded variable names are not DF_REMOTE_<ENV>_<ACCOUNT>_USER and _PASSWORD"
[ -n "${!USER_VAR:-}" ] && [ -n "${!PASS_VAR:-}" ] || setup "$USER_VAR and $PASS_VAR are not both set in this environment"
[ -n "$APP_ID" ] || APP_ID="$(node "$SELF_DIR/config.mjs" get mobile.appId 2>/dev/null || true)"
[ -n "$APP_ID" ] || setup "no app id: pass --app-id, set DF_APP_ID or mobile.appId"
DEVICE="$(field device.udid)"; [ -n "$DEVICE" ] || DEVICE="$(field device.serial)"
[ -n "$DEVICE" ] || setup "no device recorded: the mobile lane has not been started"
[ -f "$FLOW" ] || setup "flow not found: $FLOW"
ui() { node "$SELF_DIR/config.mjs" get "mobile.login.$1" 2>/dev/null || true; }

export MAESTRO_QA_USER="${!USER_VAR}" MAESTRO_QA_PASSWORD="${!PASS_VAR}" MAESTRO_APP_ID="$APP_ID"
export MAESTRO_LOGIN_USER_FIELD="${MAESTRO_LOGIN_USER_FIELD:-$(ui userField)}" MAESTRO_LOGIN_PASSWORD_FIELD="${MAESTRO_LOGIN_PASSWORD_FIELD:-$(ui passwordField)}"
export MAESTRO_LOGIN_SUBMIT="${MAESTRO_LOGIN_SUBMIT:-$(ui submit)}" MAESTRO_LOGIN_SUCCESS="${MAESTRO_LOGIN_SUCCESS:-$(ui success)}"

# the filter reads the values from its own environment, not from its arguments
mask() { node -e '
  const secrets=[process.env.MAESTRO_QA_USER,process.env.MAESTRO_QA_PASSWORD].filter(s=>s&&s.length>=3);
  let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{for(const s of secrets)t=t.split(s).join("***");process.stdout.write(t)})'; }

mkdir -p "$(dirname "$LOG")"
OUT="$(maestro --device "$DEVICE" test "$FLOW" 2>&1)"; rc=$?
printf '%s\n' "$OUT" | mask | tee "$LOG"
if [ "$rc" -ne 0 ]; then echo "qa-login: the login flow failed (exit $rc); the masked log is $LOG" >&2; exit 1; fi
echo "qa-login: signed in as the QA account ($USER_VAR)" >&2
