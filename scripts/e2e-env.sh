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
# `exec -T [-u user] service`
exec_args() { if [ -n "$SERVICE_USER" ]; then echo "exec -T -u $SERVICE_USER $SERVICE"; else echo "exec -T $SERVICE"; fi; }

die()  { echo "e2e-env: $*" >&2; exit 1; }
refuse() { echo "e2e-env: $*" >&2; exit 75; }
log()  { echo "e2e-env: $*" >&2; }

cmd="${1:-}"; [ -n "$cmd" ] && shift
WORKTREE="$(pwd)"; KEY=""; DEVICE=0; PORTS=none
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WORKTREE="$(cd "$2" && pwd)"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --device) DEVICE=1; PORTS=canonical; shift ;;
    --ports) case "$2" in canonical|none) PORTS="$2" ;; *) die "--ports must be canonical or none" ;; esac; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# the key reaches node -e snippets and docker project names: accept only a task key
if [ -n "$KEY" ] && ! printf '%s' "$KEY" | grep -Eq '^[A-Za-z][A-Za-z0-9]*-[0-9]+$'; then die "--key must look like TASK-123 (got '$KEY')"; fi

RUN_DIR="$WORKTREE/.dev-factory"
ENV_JSON="$RUN_DIR/env.json"
COMPOSE_FILE="$WORKTREE/$COMPOSE_REL"
OVERRIDE="$RUN_DIR/compose.override.yml"

project_for() { echo "df-$(echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g')"; }
env_get() { node -e "try{const j=require('$ENV_JSON');process.stdout.write(String(j['$1']??''))}catch(e){}"; }

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
  until compose "$project" $(exec_args) curl -ksf -o /dev/null "$PING_URL"; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 5
  done
}

do_verify() {
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
    compose "$project" $(exec_args) bash -c "$PROCESS_CHECK" >/dev/null 2>&1 || add "process check failed: $PROCESS_CHECK"
  fi
  if [ -n "$PING_URL" ]; then
    compose "$project" $(exec_args) curl -ksf -o /dev/null "$PING_URL" || add "ping failed: $PING_URL"
  fi

  if [ -n "$problems" ]; then
    printf 'e2e-env: verify FAILED for %s\n%s' "$project" "$problems" >&2
    return 1
  fi
  node -e "const f='$ENV_JSON';const j=require(f);j.verifiedAt=new Date().toISOString();require('fs').writeFileSync(f,JSON.stringify(j,null,2))"
  log "verify ok: $project"
}

do_up_none() {
  mkdir -p "$RUN_DIR"
  node -e "require('fs').writeFileSync('$ENV_JSON',JSON.stringify({project:'',key:'$KEY',worktree:'$WORKTREE',mode:'none',ports:'none',webBaseUrl:'$WEB_BASE_URL',createdAt:new Date().toISOString()},null,2))"
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

do_up() {
  [ -n "$KEY" ] || die "up needs --key KEY"
  [ "$ENV_TYPE" = none ] && { do_up_none; return 0; }
  [ -f "$COMPOSE_FILE" ] || die "missing $COMPOSE_FILE (run from a worktree of the repository)"
  local project; project="$(project_for "$KEY")"

  # Idempotent: a resumed ticket finds its stack still healthy and just takes ownership of it again.
  local recorded; recorded="$(env_get project)"
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
    if [ -n "$busy" ]; then
      for p in $busy; do who="$who $p$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{printf " (%s, pid %s)", $1, $2}')"; done
      refuse "host port(s) already in use:$who. Something else is running this stack's ports (your own docker compose or dev servers): stop it, then retry"
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
  node -e "require('fs').writeFileSync('$ENV_JSON',JSON.stringify({project:'$project',key:'$KEY',worktree:'$WORKTREE',composeFile:'$COMPOSE_FILE',override:'$OVERRIDE',mode:'$([ "$DEVICE" = 1 ] && echo device || { [ "$PORTS" = canonical ] && echo canonical || echo isolated; })',ports:'$PORTS',webBaseUrl:'$([ "$PORTS" = canonical ] && echo "$WEB_BASE_URL")',createdAt:new Date().toISOString()},null,2))"
  mark_live "$project"

  local ok=0
  trap '[ "$ok" = 1 ] || { log "up failed, tearing down $project"; do_down_quiet "$project"; }' EXIT
  init_submodules || die "could not populate the submodules listed in environment.submodules"
  log "starting $project (ports $PORTS$([ "$DEVICE" = 1 ] && echo ", device"))"
  compose "$project" build >&2 || die "compose build failed"
  compose "$project" up -d >&2 || die "compose up failed"
  local step
  while IFS= read -r step; do
    [ -n "$step" ] || continue
    log "setup: $step"
    compose "$project" $(exec_args) bash -c "$step" >&2 || die "setup step failed: $step"
  done < <(node -e 'for (const c of JSON.parse(process.argv[1]||"[]")) console.log(c)' "$(cfg setup)")
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
    [ -f "$ENV_JSON" ] && rm -f "$ENV_JSON"
    log "nothing to take down for this worktree"; return 0
  fi
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
  *) echo "usage: e2e-env.sh up|verify|down|sweep [--worktree DIR] [--key KEY] [--ports canonical|none] [--device]" >&2; exit 3 ;;
esac
