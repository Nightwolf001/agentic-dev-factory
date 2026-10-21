#!/usr/bin/env bash
# Isolated e2e environment per worktree: the same sequence the CI e2e workflows run inline
# (compose up, startup.sh, startup-pm2.sh, readiness poll), made reusable and verifiable.
#
#   e2e-env.sh up     [--worktree DIR] --key KEY [--ports canonical|none] [--device]   start and verify
#   e2e-env.sh verify [--worktree DIR]                        re-check the environment contract
#   e2e-env.sh down   [--worktree DIR]                        down -v and forget
#   e2e-env.sh sweep                                          remove df-* projects with no live owner
#
# --ports none (default) strips every published host port: services talk over the compose
# network, so any number of worktrees can coexist, but nothing on the host (a Playwright browser
# included) can reach the stack. --ports canonical keeps the published ports so the host can
# reach https://login.olarm.local like a developer does; it takes a machine-wide lock, one such
# environment per Mac. --device implies canonical because the mobile app has the ports baked in.
#
# Exit codes: 0 ok, 1 failure, 75 refused (cap or device lock held; retry on a later pass).
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${DF_STATE_DIR:-$HOME/.dev-factory}"
MAX_STACKS="${DF_MAX_STACKS:-2}"
READY_TIMEOUT="${DF_READY_TIMEOUT:-900}"
PING_URL="${DF_PING_URL:-https://api.olarm.local/api/v4/ping}"
COMPOSE_REL=".devcontainer/docker-compose.yml"

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

# the key reaches node -e snippets and docker project names: accept only a Jira key
if [ -n "$KEY" ] && ! printf '%s' "$KEY" | grep -Eq '^[A-Za-z][A-Za-z0-9]*-[0-9]+$'; then die "--key must look like OAPP-123 (got '$KEY')"; fi

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

# A fresh worktree has an empty services/olarm-proto submodule, so npm ci cannot link it as a workspace and the API,
# MQTT and worker crash on '#olarm-proto/...'. Clone it from the main checkout's copy when there is one (no SSH needed).
init_proto_submodule() {
  local sub=services/olarm-proto
  [ -n "$(ls -A "$WORKTREE/$sub" 2>/dev/null)" ] && return 0
  git -C "$WORKTREE" ls-files --error-unmatch "$sub" >/dev/null 2>&1 || return 0
  local common url; common="$(git -C "$WORKTREE" rev-parse --path-format=absolute --git-common-dir)"
  url="$(git -C "$WORKTREE" config -f .gitmodules "submodule.$sub.url")"
  if [ -d "$common/modules/$sub" ]; then
    git -C "$WORKTREE" -c protocol.file.allow=always -c "submodule.$sub.url=$common/modules/$sub" submodule update --init "$sub" >&2 || return 1
    git -C "$WORKTREE/$sub" remote set-url origin "$url"
  else
    git -C "$WORKTREE" submodule update --init "$sub" >&2 || return 1
  fi
}

wait_ping() { # inside the devcontainer, as the stack's own hostnames resolve there
  local project="$1" end=$((SECONDS + READY_TIMEOUT))
  until compose "$project" exec -T devcontainer curl -ksf -o /dev/null "$PING_URL"; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 5
  done
}

do_verify() {
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

  local expected actual
  expected="$(compose "$project" exec -T -u node devcontainer node -e 'console.log(require("/workspace/ecosystem.config.js").apps.map(a=>a.name).sort().join("\n"))' 2>/dev/null)"
  actual="$(compose "$project" exec -T -u node devcontainer pm2 jlist 2>/dev/null | node -e '
    let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{const a=JSON.parse(t.slice(t.indexOf("[")));
    for(const p of a.sort((x,y)=>x.name<y.name?-1:1))console.log(p.pm2_env.status==="online"?p.name:p.name+" (NOT ONLINE: "+p.pm2_env.status+")")})' 2>/dev/null)"
  if [ -z "$expected" ] || [ -z "$actual" ]; then
    add "could not read the pm2 process list from the devcontainer"
  else
    local diff_out; diff_out="$(diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") 2>&1)" || add "pm2 processes differ from ecosystem.config.js:"$'\n'"$diff_out"
  fi

  compose "$project" exec -T devcontainer curl -ksf -o /dev/null "$PING_URL" || add "ping failed: $PING_URL"

  if [ -n "$problems" ]; then
    printf 'e2e-env: verify FAILED for %s\n%s' "$project" "$problems" >&2
    return 1
  fi
  node -e "const f='$ENV_JSON';const j=require(f);j.verifiedAt=new Date().toISOString();require('fs').writeFileSync(f,JSON.stringify(j,null,2))"
  log "verify ok: $project"
}

do_up() {
  [ -n "$KEY" ] || die "up needs --key KEY"
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
    mkdir -p "$STATE_DIR"
    mkdir "$STATE_DIR/ports.lock" 2>/dev/null || {
      local holder; holder="$(cat "$STATE_DIR/ports.lock/owner" 2>/dev/null || true)"
      if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$STATE_DIR/ports.lock"; mkdir "$STATE_DIR/ports.lock"
      else refuse "canonical-ports environment lock held by pid ${holder:-unknown}"; fi
    }
    echo "${DF_OWNER_PID:-$PPID}" > "$STATE_DIR/ports.lock/owner"
  fi

  write_override
  node -e "require('fs').writeFileSync('$ENV_JSON',JSON.stringify({project:'$project',key:'$KEY',worktree:'$WORKTREE',composeFile:'$COMPOSE_FILE',override:'$OVERRIDE',mode:'$([ "$DEVICE" = 1 ] && echo device || { [ "$PORTS" = canonical ] && echo canonical || echo isolated; })',ports:'$PORTS',webBaseUrl:'$([ "$PORTS" = canonical ] && echo https://login.olarm.local)',createdAt:new Date().toISOString()},null,2))"
  mark_live "$project"

  local ok=0
  trap '[ "$ok" = 1 ] || { log "up failed, tearing down $project"; do_down_quiet "$project"; }' EXIT
  init_proto_submodule || die "could not populate services/olarm-proto"
  log "starting $project (ports $PORTS$([ "$DEVICE" = 1 ] && echo ", device"))"
  compose "$project" build >&2 || die "compose build failed"
  compose "$project" up -d >&2 || die "compose up failed"
  compose "$project" exec -T devcontainer chown -R node:node /workspace >&2 || true
  compose "$project" exec -T -u node devcontainer bash /workspace/.devcontainer/startup.sh --use-npmci >&2 || die "startup.sh failed"
  # lighthouse-2 is outside the npm workspaces and setup.sh skips services/*
  compose "$project" exec -T -u node devcontainer bash -c 'cd /workspace/services/lighthouse-2 && npm install' >&2 || die "lighthouse-2 install failed"
  compose "$project" exec -T -u node devcontainer bash /workspace/.devcontainer/startup-pm2.sh >&2 || die "startup-pm2.sh failed"
  wait_ping "$project" || die "timed out waiting for $PING_URL"
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
  [ -n "$project" ] || { log "nothing recorded for this worktree"; return 0; }
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
