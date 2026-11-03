#!/usr/bin/env bash
# Isolated e2e environment per worktree, described by the `environment` block of the config:
#   type none      no environment: up/verify/down only record that, for repositories whose tests run on the host
#   type compose   a docker compose project named df-<key>: build, up, the `setup` commands inside `service`, a
#                  readiness poll of `pingUrl`, and an optional `processCheck` command that must exit 0
#
#   e2e-env.sh up     [--worktree DIR] --key KEY [--ports canonical|none] [--device]   start and verify
#   e2e-env.sh verify [--worktree DIR]                        re-check the environment contract
#   e2e-env.sh down   [--worktree DIR]                        down -v and forget
#   e2e-env.sh sweep                                          remove df-* projects with no live owner
#
# --ports none (default) strips every published host port: services talk over the compose
# network, so any number of worktrees can coexist, but nothing on the host (a Playwright browser
# included) can reach the stack. --ports canonical keeps the published ports so the host can
# reach environment.webBaseUrl like a developer does; it takes a machine-wide lock, one such
# environment per Mac. --device implies canonical because the mobile app has the ports baked in.
#
# Remote QA: `up --remote ENV [--account NAME] [--device]` starts nothing. It checks that the deployed address in
# environments.ENV.remote.url answers, and records mode remote in env.json with the NAMES of the variables that hold the QA
# account (DF_REMOTE_<ENV>_<ACCOUNT>_USER and _PASSWORD, set by the owner in the state folder's .env.local), never their values.
# `down` only forgets the record; `verify` checks the address again. With --device the mobile lane runs against it.
#
# With DF_TAKEOVER=1 (the owner's, see scripts/takeover.mjs) busy canonical ports are freed by scripts/cleanup.mjs instead of refusing.
#
# Exit codes: 0 ok, 1 failure, 75 refused (cap or device lock held; retry on a later pass).
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${DF_STATE_DIR:-$HOME/.dev-factory}"
MAX_STACKS="${DF_MAX_STACKS:-2}"

# one value of the environment block; empty when unset
cfg() { node "$SELF_DIR/config.mjs" get "environment.$1" 2>/dev/null || true; }
ENV_TYPE="$(cfg type)"; ENV_TYPE="${ENV_TYPE:-none}"
COMPOSE_REL="$(cfg composeFile)"; COMPOSE_REL="${COMPOSE_REL:-.devcontainer/docker-compose.yml}"
SERVICE="$(cfg service)"; SERVICE="${SERVICE:-app}"
SERVICE_USER="$(cfg user)"
PING_URL="${DF_PING_URL:-$(cfg pingUrl)}"
WEB_BASE_URL="$(cfg webBaseUrl)"
PROCESS_CHECK="$(cfg processCheck)"
# seconds to wait for a fresh stack to answer: DF_READY_TIMEOUT, else environment.readyTimeout, else 900 (a first start installs dependencies)
READY_TIMEOUT="${DF_READY_TIMEOUT:-$(cfg readyTimeout)}"; READY_TIMEOUT="${READY_TIMEOUT:-900}"
# `exec -T [-u user] service` as an array, so a user or service name with an odd character stays one word. Every call also
# gets </dev/null where it is not meant to read: `exec -T` reads standard input, and a loop over steps feeds it the steps.
EXEC_ARGS=(exec -T)
[ -n "$SERVICE_USER" ] && EXEC_ARGS+=(-u "$SERVICE_USER")
EXEC_ARGS+=("$SERVICE")

die()  { echo "e2e-env: $*" >&2; exit 1; }
refuse() { echo "e2e-env: $*" >&2; exit 75; }
log()  { echo "e2e-env: $*" >&2; }

cmd="${1:-}"; [ -n "$cmd" ] && shift
WORKTREE="$(pwd)"; KEY=""; DEVICE=0; PORTS=none; REMOTE=""; ACCOUNT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WORKTREE="$(cd "$2" && pwd)"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --device) DEVICE=1; PORTS=canonical; shift ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --account) ACCOUNT="${2:-}"; shift 2 ;;
    --ports) case "$2" in canonical|none) PORTS="$2" ;; *) die "--ports must be canonical or none" ;; esac; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# the remote environment and account name reach variable names and config paths: letters, digits, - and _ only
if [ -n "$REMOTE" ] && ! printf '%s' "$REMOTE" | grep -Eq '^[A-Za-z0-9_-]+$'; then die "--remote must be an environment name (letters, digits, - and _)"; fi
if [ -n "$ACCOUNT" ] && { [ -z "$REMOTE" ] || ! printf '%s' "$ACCOUNT" | grep -Eq '^[A-Za-z0-9_-]+$'; }; then die "--account names a QA account of a --remote environment (letters, digits, - and _)"; fi

# the key reaches node -e snippets and docker project names: accept only a task key
if [ -n "$KEY" ] && ! printf '%s' "$KEY" | grep -Eq '^[A-Za-z][A-Za-z0-9]*-[0-9]+$'; then die "--key must look like TASK-123 (got '$KEY')"; fi

RUN_DIR="$WORKTREE/.dev-factory"
ENV_JSON="$RUN_DIR/env.json"
COMPOSE_FILE="$WORKTREE/$COMPOSE_REL"
OVERRIDE="$RUN_DIR/compose.override.yml"

project_for() { echo "df-$(echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g')"; }
# Values reach node as arguments and environment, never as text inside the program: a path or a setting with a quote in it must not
# become code. (A recorded value is data the run wrote; the script that reads it is the scheduler's.)
env_get() { ENV_JSON="$ENV_JSON" node -e "try{const j=JSON.parse(require('fs').readFileSync(process.env.ENV_JSON,'utf8'));process.stdout.write(String(j[process.argv[1]]??''))}catch(e){}" "$1"; }
# write_env key=value ...: the environment record, in the order given, with the time it was made
write_env() {
  ENV_JSON="$ENV_JSON" node -e 'const o={};for(const a of process.argv.slice(1)){const i=a.indexOf("=");o[a.slice(0,i)]=a.slice(i+1)}o.createdAt=new Date().toISOString();require("fs").writeFileSync(process.env.ENV_JSON,JSON.stringify(o,null,2))' "$@"
}
# a project name this script can have made: refuse to take down anything else, whatever env.json says
valid_project() { printf '%s' "$1" | grep -Eq '^df-[a-z0-9_-]+$'; }
env_get_path() { ENV_JSON="$ENV_JSON" node -e "try{const j=JSON.parse(require('fs').readFileSync(process.env.ENV_JSON,'utf8'));process.stdout.write(String(process.argv[1].split('.').reduce((o,k)=>o==null?undefined:o[k],j)??''))}catch(e){}" "$1"; }

compose() { # compose <args...> using the recorded project
  local project="$1"; shift
  local files=(-f "$COMPOSE_FILE")
  [ -f "$OVERRIDE" ] && files+=(-f "$OVERRIDE")
  docker compose "${files[@]}" -p "$project" "$@"
}

# Writes the override: no host ports and a label on every service, so isolated environments never
# collide on host ports and every object this script owns can be found by label.
write_override() {
  mkdir -p "$RUN_DIR"
  local services
  services="$(docker compose -f "$COMPOSE_FILE" config --services)" || die "compose file does not render"
  {
    echo "services:"
    for s in $services; do
      echo "  $s:"
      echo "    labels:"
      echo "      dev-factory: \"1\""
      [ "$PORTS" = none ] && echo "    ports: !reset []"
    done
  } > "$OVERRIDE"
}

live_projects() { # one per line: projects with a live owner file whose pid is alive
  [ -d "$STATE_DIR/live" ] || return 0
  for f in "$STATE_DIR"/live/*; do
    [ -f "$f" ] || continue
    local pid; pid="$(sed -n 1p "$f")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then basename "$f"; fi
  done
}

mark_live()   { mkdir -p "$STATE_DIR/live"; printf '%s\n%s\n' "${DF_OWNER_PID:-$PPID}" "$WORKTREE" > "$STATE_DIR/live/$1"; }
forget_live() { rm -f "$STATE_DIR/live/$1"; }

# A fresh worktree has empty submodule directories. Populate each path listed in environment.submodules from the main
# checkout's copy when there is one (no network or SSH needed), so installs that link them as workspaces work.
init_submodules() {
  local sub common url
  for sub in $(node -e 'for (const p of JSON.parse(process.argv[1]||"[]")) console.log(p)' "$(cfg submodules)"); do
    [ -n "$(ls -A "$WORKTREE/$sub" 2>/dev/null)" ] && continue
    git -C "$WORKTREE" ls-files --error-unmatch "$sub" >/dev/null 2>&1 || continue
    common="$(git -C "$WORKTREE" rev-parse --path-format=absolute --git-common-dir)"
    url="$(git -C "$WORKTREE" config -f .gitmodules "submodule.$sub.url")"
    if [ -d "$common/modules/$sub" ]; then
      git -C "$WORKTREE" -c protocol.file.allow=always -c "submodule.$sub.url=$common/modules/$sub" submodule update --init "$sub" >&2 || return 1
      git -C "$WORKTREE/$sub" remote set-url origin "$url"
    else
      git -C "$WORKTREE" submodule update --init "$sub" >&2 || return 1
    fi
  done
}

wait_ping() { # inside the service, as the stack's own hostnames resolve there
  local project="$1" end=$((SECONDS + READY_TIMEOUT))
  [ -n "$PING_URL" ] || return 0
  until compose "$project" "${EXEC_ARGS[@]}" curl -ksf -o /dev/null "$PING_URL" </dev/null; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 5
  done
}

# DF_REMOTE_<ENV>_<ACCOUNT>_<KIND>: upper case, anything else becomes _
remote_var() { printf 'DF_REMOTE_%s_%s_%s' "$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')" "$(printf '%s' "$2" | tr '[:lower:]-' '[:upper:]_')" "$3"; }

# the deployed address answers with anything below 500 (a login page and a 401 both mean the service is there)
remote_answers() {
  local code; code="$(curl -ks -o /dev/null -m 20 -w '%{http_code}' "$1" 2>/dev/null)"
  case "$code" in 000|'') return 1 ;; 5*) return 1 ;; esac
  return 0
}

do_verify_remote() {
  local url; url="$(env_get_path remote.url)"
  [ -n "$url" ] || die "no remote address recorded in $ENV_JSON"
  remote_answers "$url" || { printf 'e2e-env: verify FAILED for the remote environment %s: the address does not answer\n' "$(env_get_path remote.env)" >&2; return 1; }
  node -e "const f='$ENV_JSON';const j=require(f);j.verifiedAt=new Date().toISOString();require('fs').writeFileSync(f,JSON.stringify(j,null,2))"
  log "verify ok: remote $(env_get_path remote.env)"
}

do_verify() {
  if [ "$(env_get mode)" = remote ]; then do_verify_remote; return $?; fi
  if [ "$ENV_TYPE" = none ]; then
    [ -f "$ENV_JSON" ] || die "no environment recorded in $ENV_JSON"
    return 0
  fi
  local project; project="$(env_get project)"
  [ -n "$project" ] || die "no environment recorded in $ENV_JSON"
  local problems=""
  add() { problems="$problems$1"$'\n'; }

  compose "$project" config -q 2>/dev/null || add "compose configuration does not render"

  local ps_out
  ps_out="$(compose "$project" ps -a --format json 2>/dev/null)" || add "docker compose ps failed"
  local svc_report
  svc_report="$(printf '%s\n' "$ps_out" | node -e '
    const lines=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l));
    const bad=lines.filter(s=>s.State!=="running"||(s.Health&&s.Health!=="healthy"));
    if(lines.length===0)console.log("no services found");
    for(const s of bad)console.log(`service ${s.Service}: state=${s.State} health=${s.Health||"-"}`);')"
  [ -n "$svc_report" ] && add "$svc_report"

  if [ -n "$PROCESS_CHECK" ]; then
    compose "$project" "${EXEC_ARGS[@]}" bash -c "$PROCESS_CHECK" </dev/null >/dev/null 2>&1 || add "process check failed: $PROCESS_CHECK"
  fi
  if [ -n "$PING_URL" ]; then
    compose "$project" "${EXEC_ARGS[@]}" curl -ksf -o /dev/null "$PING_URL" </dev/null || add "ping failed: $PING_URL"
  fi

  if [ -n "$problems" ]; then
    printf 'e2e-env: verify FAILED for %s\n%s' "$project" "$problems" >&2
    return 1
  fi
  ENV_JSON="$ENV_JSON" node -e "const f=process.env.ENV_JSON;const j=JSON.parse(require('fs').readFileSync(f,'utf8'));j.verifiedAt=new Date().toISOString();require('fs').writeFileSync(f,JSON.stringify(j,null,2))"
  log "verify ok: $project"
}

do_up_none() {
  mkdir -p "$RUN_DIR"
  write_env project= key="$KEY" worktree="$WORKTREE" mode=none ports=none webBaseUrl="$WEB_BASE_URL"
  log "no environment configured (environment.type is none): tests run on the host"
}

# Published host ports of the compose file that something already listens on, one per line. A stack that publishes fixed
# ports (3000, 1337...) cannot start next to a developer's own copy of it, and compose says so only after a long build.
busy_ports() {
  docker compose -f "$COMPOSE_FILE" config --format json 2>/dev/null | node -e '
    let t="";process.stdin.on("data",d=>t+=d).on("end",async()=>{
      const ports=[];
      try{for(const s of Object.values(JSON.parse(t).services||{}))for(const p of s.ports||[]){
        const n=Number(typeof p==="object"?p.published:String(p).split(":").slice(-2)[0]);if(n)ports.push(n)}}catch(e){}
      const net=require("net");
      for(const n of [...new Set(ports)])await new Promise(r=>{const s=net.createServer();
        s.once("error",e=>{if(e.code==="EADDRINUSE")console.log(n);r()});s.once("listening",()=>s.close(()=>r()));s.listen(n)})})'
}

mode_rank() { case "$1" in device) echo 2 ;; canonical) echo 1 ;; *) echo 0 ;; esac; }

# environment.setup: each entry is a command (a string, which may span lines) or {"run": "...", "user": "root"} to run as
# another user than environment.user. Every step runs in full: the steps are read by index, not from a stream the first
# `exec` would consume.
setup_field() { # setup_field INDEX run|user
  node -e '
    const e = JSON.parse(process.argv[1] || "[]")[Number(process.argv[2])];
    const v = typeof e === "string" ? (process.argv[3] === "run" ? e : "") : (e && e[process.argv[3]]) || "";
    process.stdout.write(String(v));' "$(cfg setup)" "$1" "$2"
}
run_setup() {
  local project="$1" count i step user args
  count="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]||"[]").length))' "$(cfg setup)")"
  i=0
  while [ "$i" -lt "$count" ]; do
    step="$(setup_field "$i" run)"; user="$(setup_field "$i" user)"
    i=$((i + 1))
    [ -n "$step" ] || continue
    args=("${EXEC_ARGS[@]}")
    if [ -n "$user" ]; then args=(exec -T -u "$user" "$SERVICE"); fi
    log "setup: $(printf '%s' "$step" | head -n 1)$([ "$(printf '%s' "$step" | wc -l)" -gt 0 ] && echo ' ...')"
    compose "$project" "${args[@]}" bash -c "$step" </dev/null >&2 || { log "step $i failed: $(printf '%s' "$step" | head -n 1)"; return 1; }
  done
}

do_up_remote() {
  local url accounts account="" userVar="" passVar="" host
  url="$(node "$SELF_DIR/config.mjs" get "environments.$REMOTE.remote.url" 2>/dev/null)"
  [ -n "$url" ] || die "environments.$REMOTE.remote.url is not set: there is no remote environment called $REMOTE"
  accounts="$(node "$SELF_DIR/config.mjs" get "environments.$REMOTE.remote.accounts" 2>/dev/null || true)"
  account="$ACCOUNT"
  [ -n "$account" ] || account="$(node "$SELF_DIR/config.mjs" get "environments.$REMOTE.remote.defaultAccount" 2>/dev/null || true)"
  [ -n "$account" ] || account="$(node -e 'try{console.log(JSON.parse(process.argv[1])[0]||"")}catch(e){}' "${accounts:-[]}")"
  if [ -n "$account" ]; then
    node -e 'process.exit(JSON.parse(process.argv[1]||"[]").includes(process.argv[2])?0:1)' "${accounts:-[]}" "$account" || die "$account is not one of environments.$REMOTE.remote.accounts"
    userVar="$(remote_var "$REMOTE" "$account" USER)"; passVar="$(remote_var "$REMOTE" "$account" PASSWORD)"
    # names only in the message: the values never appear in output
    [ -n "${!userVar:-}" ] && [ -n "${!passVar:-}" ] || die "the QA account $account for $REMOTE has no credentials here: set $userVar and $passVar in the state folder's .env.local"
  fi
  remote_answers "$url" || die "the remote environment $REMOTE does not answer at its address (environments.$REMOTE.remote.url)"
  host="$(node -e 'console.log(new URL(process.argv[1]).host)' "$url")"
  mkdir -p "$RUN_DIR"
  DF_R_ENV="$REMOTE" DF_R_URL="$url" DF_R_ACCOUNT="$account" DF_R_USERVAR="$userVar" DF_R_PASSVAR="$passVar" DF_R_HOST="$host" DF_R_KEY="$KEY" DF_R_WT="$WORKTREE" DF_R_DEVICE="$DEVICE" ENV_JSON="$ENV_JSON" node -e '
    const e=process.env;
    const j={project:"",key:e.DF_R_KEY,worktree:e.DF_R_WT,mode:"remote",ports:"none",device:e.DF_R_DEVICE==="1",webBaseUrl:e.DF_R_URL,hosts:[e.DF_R_HOST],
      remote:{env:e.DF_R_ENV,url:e.DF_R_URL,account:e.DF_R_ACCOUNT||null,userVar:e.DF_R_USERVAR||null,passwordVar:e.DF_R_PASSVAR||null},
      secretEnv:e.DF_R_PASSVAR?[e.DF_R_PASSVAR]:[],createdAt:new Date().toISOString()};
    require("fs").writeFileSync(e.ENV_JSON,JSON.stringify(j,null,2))'
  log "remote environment $REMOTE: $url answers${account:+; QA account $account ($userVar, $passVar)}"
  if [ "$DEVICE" = 1 ]; then
    ( cd "$WORKTREE" && bash "$SELF_DIR/mobile-env.sh" up --worktree "$WORKTREE" ) || { rc=$?; [ "$rc" = 75 ] && refuse "Metro port busy"; die "mobile lane failed"; }
  fi
}

do_up() {
  [ -n "$KEY" ] || die "up needs --key KEY"
  [ -n "$REMOTE" ] && { do_up_remote; return 0; }
  [ "$ENV_TYPE" = none ] && { do_up_none; return 0; }
  [ -f "$COMPOSE_FILE" ] || die "missing $COMPOSE_FILE (run from a worktree of the repository)"
  local project; project="$(project_for "$KEY")"

  # Idempotent: a resumed ticket finds its stack still healthy and just takes ownership of it again. A stack started with
  # fewer ports than this run needs (isolated < canonical < device) is not reused: a browser or device ticket would find
  # no ports or no simulator. It is taken down and replaced.
  local recorded; recorded="$(env_get project)"
  local want have
  want="$(mode_rank "$([ "$DEVICE" = 1 ] && echo device || { [ "$PORTS" = canonical ] && echo canonical || echo isolated; })")"
  have="$(mode_rank "$(env_get mode)")"
  if [ "$recorded" = "$project" ] && [ "$have" -lt "$want" ]; then
    log "recorded stack is $(env_get mode), this run needs more: replacing $project"
    [ "$(env_get mode)" = device ] && bash "$SELF_DIR/mobile-env.sh" down --worktree "$WORKTREE"
    do_down_quiet "$project"
    rm -f "$ENV_JSON"
    recorded=""
  fi
  if [ "$recorded" = "$project" ] && ( do_verify ) >/dev/null 2>&1; then
    mark_live "$project"
    case "$(env_get mode)" in
      device|canonical) mkdir -p "$STATE_DIR/ports.lock"; echo "${DF_OWNER_PID:-$PPID}" > "$STATE_DIR/ports.lock/owner" ;;
    esac
    [ "$(env_get mode)" = device ] && { ( cd "$WORKTREE" && bash "$SELF_DIR/mobile-env.sh" up --worktree "$WORKTREE" ) || die "mobile lane failed"; }
    log "ready (reused): $project"
    return 0
  fi

  local live_count; live_count="$(live_projects | grep -c . || true)"
  [ "$live_count" -ge "$MAX_STACKS" ] && refuse "$live_count environments already live (cap $MAX_STACKS)"
  if [ "$PORTS" = canonical ]; then
    local busy p who=""; busy="$(busy_ports | tr '\n' ' ')"
    if [ -n "$busy" ] && node "$SELF_DIR/takeover.mjs"; then
      log "takeover is on: freeing host port(s) $busy"
      node "$SELF_DIR/cleanup.mjs" --worktree "$WORKTREE" --ports "$(echo $busy | tr ' ' ',')" >&2 || true
      busy="$(busy_ports | tr '\n' ' ')"
    fi
    if [ -n "$busy" ]; then
      for p in $busy; do who="$who $p$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{printf " (%s, pid %s)", $1, $2}')"; done
      refuse "host port(s) already in use:$who. Something else is running this stack's ports (your own docker compose or dev servers): stop it, or have the owner set DF_TAKEOVER=1 so the run may stop it, then retry"
    fi
    mkdir -p "$STATE_DIR"
    mkdir "$STATE_DIR/ports.lock" 2>/dev/null || {
      local holder; holder="$(cat "$STATE_DIR/ports.lock/owner" 2>/dev/null || true)"
      if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$STATE_DIR/ports.lock"; mkdir "$STATE_DIR/ports.lock"
      else refuse "canonical-ports environment lock held by pid ${holder:-unknown}"; fi
    }
    echo "${DF_OWNER_PID:-$PPID}" > "$STATE_DIR/ports.lock/owner"
  fi

  write_override
  write_env project="$project" key="$KEY" worktree="$WORKTREE" composeFile="$COMPOSE_FILE" override="$OVERRIDE" \
    mode="$([ "$DEVICE" = 1 ] && echo device || { [ "$PORTS" = canonical ] && echo canonical || echo isolated; })" \
    ports="$PORTS" webBaseUrl="$([ "$PORTS" = canonical ] && echo "$WEB_BASE_URL")"
  mark_live "$project"

  local ok=0
  trap '[ "$ok" = 1 ] || { log "up failed, tearing down $project"; do_down_quiet "$project"; }' EXIT
  init_submodules || die "could not populate the submodules listed in environment.submodules"
  log "starting $project (ports $PORTS$([ "$DEVICE" = 1 ] && echo ", device"))"
  compose "$project" build >&2 || die "compose build failed"
  compose "$project" up -d >&2 || die "compose up failed"
  run_setup "$project" || die "setup step failed"
  # setup steps may refresh lockfiles: seal them so QA does not read them as the ticket's edits
  node "$SELF_DIR/env-build-files.mjs" seal --worktree "$WORKTREE" >&2 || true
  wait_ping "$project" || die "timed out waiting for the ping URL"
  if [ "$DEVICE" = 1 ]; then
    ( cd "$WORKTREE" && bash "$SELF_DIR/mobile-env.sh" up --worktree "$WORKTREE" ) || { rc=$?; [ "$rc" = 75 ] && refuse "Metro port busy"; die "mobile lane failed"; }
  fi
  do_verify || die "environment did not meet the contract"
  ok=1
  trap - EXIT
  log "ready: $project"
}

do_down_quiet() {
  local project="$1"
  compose "$project" down -v --remove-orphans >/dev/null 2>&1 || \
    docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker rm -f >/dev/null 2>&1
  forget_live "$project"
  [ -d "$STATE_DIR/ports.lock" ] && [ "$(cat "$STATE_DIR/ports.lock/owner" 2>/dev/null)" = "${DF_OWNER_PID:-$PPID}" ] && rm -rf "$STATE_DIR/ports.lock"
  return 0
}

do_down() {
  local project; project="$(env_get project)"
  if [ -z "$project" ]; then
    # a remote environment started nothing: only the record and, with --device, the dev server are ours
    [ "$(env_get device)" = true ] && bash "$SELF_DIR/mobile-env.sh" down --worktree "$WORKTREE"
    [ -f "$ENV_JSON" ] && rm -f "$ENV_JSON"
    log "nothing to take down for this worktree"; return 0
  fi
  # env.json is written by the run, so it is not trusted to name what to remove: only a project this script makes (df-<key>)
  valid_project "$project" || die "refusing to take down '$(printf '%s' "$project" | cut -c1-40)': not a project this script started (df-<key>); env.json was not used"
  [ "$(env_get mode)" = "device" ] && bash "$SELF_DIR/mobile-env.sh" down --worktree "$WORKTREE"
  do_down_quiet "$project"
  rm -f "$ENV_JSON"
  log "down: $project"
}

# A stack whose worktree still exists and whose run.json changed within SPARE_MINUTES belongs to a ticket
# that is about to be resumed (its pass died, the work did not); sweeping it would resume against nothing.
SPARE_MINUTES="${DF_SWEEP_SPARE_MINUTES:-180}"
fresh_stray() {
  local wt; wt="$(sed -n 2p "$STATE_DIR/live/$1" 2>/dev/null)"
  [ -n "$wt" ] && [ -f "$wt/.dev-factory/run.json" ] && [ -n "$(find "$wt/.dev-factory/run.json" -mmin "-$SPARE_MINUTES" 2>/dev/null)" ]
}

do_sweep() {
  command -v docker >/dev/null 2>&1 || { log "docker not installed, nothing to sweep"; return 0; }
  local live; live="$(live_projects)"
  local projects
  projects="$(docker compose ls -a --format json 2>/dev/null | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{try{for(const p of JSON.parse(t))if(p.Name.startsWith("df-"))console.log(p.Name)}catch(e){}})')"
  local swept=0
  for p in $projects; do
    if ! printf '%s\n' "$live" | grep -qx "$p" && ! fresh_stray "$p"; then
      log "sweeping orphan $p"
      docker ps -aq --filter "label=com.docker.compose.project=$p" | xargs -r docker rm -f >/dev/null 2>&1
      docker network ls -q --filter "label=com.docker.compose.project=$p" | xargs -r docker network rm >/dev/null 2>&1
      docker volume ls -q --filter "label=com.docker.compose.project=$p" | xargs -r docker volume rm >/dev/null 2>&1
      forget_live "$p"; swept=$((swept + 1))
    fi
  done
  if [ -d "$STATE_DIR/ports.lock" ]; then
    local holder; holder="$(cat "$STATE_DIR/ports.lock/owner" 2>/dev/null || true)"
    if [ -z "$holder" ] || ! kill -0 "$holder" 2>/dev/null; then rm -rf "$STATE_DIR/ports.lock"; log "released stale ports lock"; fi
  fi
  log "sweep done ($swept removed)"
}

case "$cmd" in
  up) do_up ;;
  verify) do_verify ;;
  down) do_down ;;
  sweep) do_sweep ;;
  *) echo "usage: e2e-env.sh up|verify|down|sweep [--worktree DIR] [--key KEY] [--ports canonical|none] [--device] [--remote ENV [--account NAME]]" >&2; exit 3 ;;
esac
