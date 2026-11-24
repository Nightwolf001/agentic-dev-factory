#!/usr/bin/env bash
# Isolated e2e environment per worktree, described by the `environment` block of the config:
#   type none      no environment: up/verify/down only record that, for repositories whose tests run on the host
#   type compose   a docker compose project named df-<key>: build, up, the `setup` commands inside `service`, a
#                  readiness poll of `pingUrl`, and an optional `processCheck` command that must exit 0
#
#   e2e-env.sh up     [--worktree DIR] --key KEY [--ports canonical|direct|none] [--device]   start and verify
#   e2e-env.sh verify [--worktree DIR]                        re-check the environment contract
#   e2e-env.sh down   [--worktree DIR]                        down -v and forget
#   e2e-env.sh sweep                                          remove df-* projects with no live owner
#
# --ports none (default) strips every published host port: services talk over the compose
# network, so any number of worktrees can coexist, but nothing on the host (a Playwright browser
# included) can reach the stack. --ports canonical keeps the published ports so the host can
# reach environment.webBaseUrl like a developer does; it takes a machine-wide lock, one such
# environment per Mac. --device alone implies canonical because the mobile app has the ports baked in.
# --ports direct strips the published ports as none does, and records the stack's own address instead: environment.webBaseUrl
# with its host replaced by environment.directHost ({service}.{project}.orb.local by default, the name an engine such as
# OrbStack gives each container). up probes that address itself from this machine (pingUrl stays the check inside the
# service) and counts any HTTP answer below 500 as reachable; no connection or a 5xx until the ready timeout fails, with no
# fallback. No lock: any number of direct environments coexist (they still count against the cap).
# --ports direct --device is the same stack for a simulator or an emulator: mode device, ports direct. An iOS simulator
# and this Mac resolve the name; an Android emulator's DNS cannot, so up also reads the IP address of the service's container,
# probes it the same way, and records it as directIp and directIpUrl (the base address with the IP as its host) beside webBaseUrl.
# Both hosts are in env.json's hosts, and mobile-env.sh picks the address for its platform.
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
# Host ports belong to the machine, not to one repository: a repository's own state folder (~/.dev-factory/<slug>) keeps the ports
# lock in the machine folder above it, so two repositories never publish the same canonical ports at once.
PORTS_DIR="$STATE_DIR"; [ "$(dirname "$STATE_DIR")" = "$HOME/.dev-factory" ] && PORTS_DIR="$HOME/.dev-factory"
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
WORKTREE="$(pwd)"; KEY=""; DEVICE=0; PORTS=none; PORTS_FLAG=""; REMOTE=""; ACCOUNT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WORKTREE="$(cd "$2" && pwd)"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --device) DEVICE=1; shift ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --account) ACCOUNT="${2:-}"; shift 2 ;;
    --ports) case "${2:-}" in canonical|direct|none) PORTS="$2"; PORTS_FLAG="$2" ;; *) die "--ports must be canonical, direct or none" ;; esac; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
# --device keeps the canonical ports (the app has them baked in) unless --ports direct asks for the stack's own address, in either order
if [ "$DEVICE" = 1 ] && [ "$PORTS_FLAG" != direct ]; then PORTS=canonical; fi

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

# direct_env_lines DIRECT_URL: the YAML lines (under the service's `environment:`) for environment.directEnv, with {host} (the direct
# address's host name) and {origin} (its scheme, host and port) filled in. Values are written as text: compose interpolates $, so each
# becomes $$, and \ and " are escaped for the YAML double-quoted string. Exit 1, saying why, when the setting is not a map of names to text.
direct_env_lines() {
  node -e '
    const [raw, direct] = process.argv.slice(1);
    let map;
    try { map = JSON.parse(raw || "{}"); } catch (e) { map = null; }
    const ok = map && typeof map === "object" && !Array.isArray(map) && Object.entries(map).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string" && !/[\0-\x1f\x7f]/.test(v));
    if (!ok) { console.error("environment.directEnv must map variable names (letters, digits and _) to text"); process.exit(1); }
    const u = new URL(direct);
    for (const [k, v] of Object.entries(map)) {
      const val = v.replaceAll("{host}", u.hostname).replaceAll("{origin}", u.origin).replace(/\$/g, "$$$$").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
      console.log("      " + k + ": \"" + val + "\"");
    }' "$(cfg directEnv)" "$1"
}

# Writes the override: no host ports and labels on every service, so isolated environments never collide on host ports and
# every object this script owns can be found by label. The owner (the pid mark_live records) and the worktree are labels too:
# a sweep run from another state folder has no live/ file for the stack, but it can read who owns it from the stack itself.
# environment.directEnv goes to environment.service of a direct stack, whose address it names, and to no other service or mode.
write_override() { # write_override [DIRECT_URL]
  mkdir -p "$RUN_DIR"
  local services owner wt env_lines=""
  if [ "$PORTS" = direct ] && [ -n "${1:-}" ] && [ -n "$(cfg directEnv | tr -d '{} \n')" ]; then
    env_lines="$(direct_env_lines "$1")" || die "environment.directEnv is not usable (see above)"
  fi
  services="$(docker compose -f "$COMPOSE_FILE" config --services)" || die "compose file does not render"
  owner="${DF_OWNER_PID:-$PPID}"
  # compose interpolates every value of every -f file, so a literal $ is written $$; then, inside a YAML double-quoted string, \ and " are escaped
  wt="$(printf '%s' "$WORKTREE" | sed -e 's/\$/$$/g' -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  {
    echo "services:"
    for s in $services; do
      echo "  $s:"
      echo "    labels:"
      echo "      dev-factory: \"1\""
      echo "      dev-factory.owner: \"$owner\""
      echo "      dev-factory.worktree: \"$wt\""
      case "$PORTS" in none|direct) echo "    ports: !reset []" ;; esac
      if [ -n "$env_lines" ] && [ "$s" = "$SERVICE" ]; then echo "    environment:"; printf '%s\n' "$env_lines"; fi
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

# The ping inside the service, with whichever client the image has: curl, else wget (Alpine and BusyBox images), else node's fetch.
PING_SH='u="$1"; if command -v curl >/dev/null 2>&1; then exec curl -ksf -o /dev/null "$u"; elif command -v wget >/dev/null 2>&1; then exec wget -q -O /dev/null "$u"; else exec node -e "fetch(process.argv[1]).then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))" "$u"; fi'
ping_in_service() { compose "$1" "${EXEC_ARGS[@]}" sh -c "$PING_SH" ping "$PING_URL" </dev/null; }

wait_ping() { # inside the service, as the stack's own hostnames resolve there
  local project="$1" end=$((SECONDS + READY_TIMEOUT))
  [ -n "$PING_URL" ] || return 0
  until ping_in_service "$project"; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 5
  done
}

# direct_url BASEURL PROJECT: BASEURL with its host replaced by environment.directHost, {service} (environment.service) and
# {project} filled in; scheme, port, path and query kept. Exit 2 when BASEURL is not an http(s) address; exit 1, printing the
# host it made (printable characters only), when that is not a valid host name.
direct_url() {
  node -e '
    const [base, tpl, service, project] = process.argv.slice(1);
    let u;
    try { u = new URL(base); } catch (e) { process.exit(2); }
    if (!/^https?:$/.test(u.protocol)) process.exit(2);
    const host = tpl.replaceAll("{service}", service).replaceAll("{project}", project);
    const bad = () => { process.stdout.write(host.replace(/[^\x21-\x7e]/g, "?").slice(0, 200)); process.exit(1); };
    if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) bad();
    const out = u.protocol + "//" + host + (u.port ? ":" + u.port : "") + (u.pathname === "/" ? "" : u.pathname) + u.search + u.hash;
    try { if (new URL(out).hostname !== host.toLowerCase()) bad(); } catch (e) { bad(); }
    process.stdout.write(out);' "$1" "$(cfg directHost)" "$SERVICE" "$2"
}
# url_shown URL: origin and path only, for logs and messages (a query can carry a token)
url_shown() { node -e 'try{const u=new URL(process.argv[1]);process.stdout.write(u.origin+(u.pathname==="/"?"":u.pathname))}catch(e){process.stdout.write("(not an address)")}' "$1"; }

# container_ip PROJECT: the IP address of environment.service's container on the stack's network; exit 1 when it has none
container_ip() {
  local id; id="$(compose "$1" ps -q "$SERVICE" 2>/dev/null | head -1)"
  [ -n "$id" ] || return 1
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$id" 2>/dev/null | node -e '
    const ip = require("fs").readFileSync(0, "utf8").split(/\s+/).find((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x));
    if (!ip) process.exit(1);
    process.stdout.write(ip);'
}
# ip_url BASEURL IP: BASEURL with its host replaced by IP; scheme, port, path and query kept
ip_url() {
  node -e '
    const [base, ip] = process.argv.slice(1);
    const u = new URL(base);
    process.stdout.write(u.protocol + "//" + ip + (u.port ? ":" + u.port : "") + (u.pathname === "/" ? "" : u.pathname) + u.search + u.hash);' "$1" "$2"
}
# record_ip IP IPURL DIRECTURL: the container address and both hosts a probe may reach, added to env.json
record_ip() {
  ENV_JSON="$ENV_JSON" node -e '
    const f = process.env.ENV_JSON, [ip, ipUrl, direct] = process.argv.slice(1);
    const j = JSON.parse(require("fs").readFileSync(f, "utf8"));
    Object.assign(j, { directIp: ip, directIpUrl: ipUrl, hosts: [new URL(direct).hostname, ip] });
    require("fs").writeFileSync(f, JSON.stringify(j, null, 2));' "$1" "$2" "$3"
}

# The probe from this machine checks reachability only, as remote_answers does: any HTTP answer below 500 means the engine routes
# to the stack (a login redirect, a 401 and a 404 all count); 000 (no connection) and 5xx do not. pingUrl is not used here: it
# stays the readiness check inside the service, and its query can carry a token.
direct_status() { # prints the HTTP status, 000 for no connection
  local code; code="$(curl -ks -o /dev/null -m 10 -w '%{http_code}' "$1" </dev/null 2>/dev/null)"
  case "$code" in [0-9][0-9][0-9]) printf '%s' "$code" ;; *) printf '000' ;; esac
}
direct_reachable() { case "$1" in 000|5*) return 1 ;; esac; return 0; }
DIRECT_CODE=000
wait_direct() { # wait_direct URL: until it answers below 500 or READY_TIMEOUT passes; the last status is left in DIRECT_CODE
  local url="$1" end=$((SECONDS + READY_TIMEOUT))
  while :; do
    DIRECT_CODE="$(direct_status "$url")"
    direct_reachable "$DIRECT_CODE" && return 0
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
    ping_in_service "$project" || add "ping failed: $(url_shown "$PING_URL")"
  fi
  # the direct address is worked out again from the settings, never read back from env.json, which the run can write
  if [ "$(env_get mode)" = direct ] || [ "$(env_get ports)" = direct ]; then
    local addr code ip
    if ! valid_project "$project"; then
      add "the recorded project is not one this script makes (df-<key>): no direct address was probed"
    elif ! addr="$(direct_url "$WEB_BASE_URL" "$project")"; then
      add "environment.webBaseUrl and environment.directHost do not make a direct address"
    else
      code="$(direct_status "$addr")"
      if [ "$code" = 000 ]; then add "direct address does not answer: $(url_shown "$addr")"
      elif ! direct_reachable "$code"; then add "direct address answered HTTP $code: $(url_shown "$addr")"; fi
      # a device stack is also reached by its container's IP, which an Android emulator needs: read again, not trusted from env.json
      if [ "$(env_get mode)" = device ]; then
        if ! ip="$(container_ip "$project")"; then add "could not read the IP address of the service $SERVICE"
        else
          addr="$(ip_url "$WEB_BASE_URL" "$ip")"; code="$(direct_status "$addr")"
          if [ "$code" = 000 ]; then add "container address does not answer: $(url_shown "$addr")"
          elif ! direct_reachable "$code"; then add "container address answered HTTP $code: $(url_shown "$addr")"; fi
        fi
      fi
    fi
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

mode_rank() { case "$1" in device) echo 3 ;; canonical) echo 2 ;; direct) echo 1 ;; *) echo 0 ;; esac; }
# the mode this run asks for
want_mode() { if [ "$DEVICE" = 1 ]; then echo device; else case "$PORTS" in canonical|direct) echo "$PORTS" ;; *) echo isolated ;; esac; fi; }

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
  # an address with a user or password in it would be logged, recorded in env.json and sent to every probe: credentials are variables
  node -e 'try{const u=new URL(process.argv[1]);process.exit(/^https?:$/.test(u.protocol)&&!u.username&&!u.password?0:1)}catch(e){process.exit(1)}' "$url" || die "environments.$REMOTE.remote.url must be an http(s) address with no user or password in it (the QA account is DF_REMOTE_<ENV>_<ACCOUNT>_USER and _PASSWORD)"
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
  log "remote environment $REMOTE: $(node -e 'const u=new URL(process.argv[1]);console.log(u.origin+u.pathname)' "$url") answers${account:+; QA account $account ($userVar, $passVar)}"
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
  local direct="" rc
  if [ "$PORTS" = direct ]; then
    [ -n "$WEB_BASE_URL" ] || die "--ports direct needs environment.webBaseUrl (the address a browser would use, with its port)"
    direct="$(direct_url "$WEB_BASE_URL" "$project")" || {
      rc=$?
      [ "$rc" = 2 ] && die "environment.webBaseUrl must be an http(s) address for --ports direct"
      die "environment.directHost ($(cfg directHost)) with {service} = environment.service ($SERVICE) and {project} = $project makes $direct, which is not a valid host name: a service name with _ (or another character a host name cannot have) is not a valid host label, so put the name of the service that serves the web in environment.directHost instead (web.{project}.orb.local)"
    }
  fi

  # Idempotent: a resumed ticket finds its stack still healthy and just takes ownership of it again. A stack started with
  # fewer ports than this run needs (isolated < direct < canonical < device) is not reused: a browser or device ticket would
  # find no address, no ports or no simulator. It is taken down and replaced.
  local recorded; recorded="$(env_get project)"
  local want have
  want="$(mode_rank "$(want_mode)")"
  have="$(mode_rank "$(env_get mode)")"
  # a device stack also has to be the kind of ports the run asked for: a canonical one holds the lock a direct run must not take
  local replace=0
  if [ "$have" -lt "$want" ]; then replace=1
  elif [ "$DEVICE" = 1 ] && [ "$(env_get mode)" = device ] && [ "$(env_get ports)" != "$PORTS" ]; then replace=1; fi
  if [ "$recorded" = "$project" ] && [ "$replace" = 1 ]; then
    log "recorded stack is $(env_get mode) with ports $(env_get ports), this run needs $(want_mode) with ports $PORTS: replacing $project"
    do_down_quiet "$project"
    rm -f "$ENV_JSON"
    recorded=""
  fi
  if [ "$recorded" = "$project" ] && ( do_verify ) >/dev/null 2>&1; then
    mark_live "$project"
    case "$(env_get mode)" in
      device|canonical) [ "$(env_get ports)" = direct ] || { mkdir -p "$PORTS_DIR/ports.lock"; echo "${DF_OWNER_PID:-$PPID}" > "$PORTS_DIR/ports.lock/owner"; } ;;
    esac
    [ "$(env_get mode)" = device ] && { ( cd "$WORKTREE" && bash "$SELF_DIR/mobile-env.sh" up --worktree "$WORKTREE" ) || die "mobile lane failed"; }
    log "ready (reused, $(env_get mode)): $project"
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
    mkdir "$PORTS_DIR/ports.lock" 2>/dev/null || {
      local holder; holder="$(cat "$PORTS_DIR/ports.lock/owner" 2>/dev/null || true)"
      if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$PORTS_DIR/ports.lock"; mkdir "$PORTS_DIR/ports.lock"
      else refuse "canonical-ports environment lock held by pid ${holder:-unknown}"; fi
    }
    echo "${DF_OWNER_PID:-$PPID}" > "$PORTS_DIR/ports.lock/owner"
  fi

  write_override "$direct"
  local web=""
  case "$PORTS" in canonical) web="$WEB_BASE_URL" ;; direct) web="$direct" ;; esac
  write_env project="$project" key="$KEY" worktree="$WORKTREE" composeFile="$COMPOSE_FILE" override="$OVERRIDE" \
    mode="$(want_mode)" ports="$PORTS" webBaseUrl="$web"
  mark_live "$project"

  local ok=0
  trap '[ "$ok" = 1 ] || { log "up failed, tearing down $project"; do_down_quiet "$project"; }' EXIT
  # files the ticket itself already changed (an adopted worktree) are not the environment's rewrites: note them before anything runs
  node "$SELF_DIR/env-build-files.mjs" snapshot --worktree "$WORKTREE" >&2 || true
  init_submodules || die "could not populate the submodules listed in environment.submodules"
  log "starting $project (ports $PORTS$([ "$DEVICE" = 1 ] && echo ", device"))"
  compose "$project" build >&2 || die "compose build failed"
  compose "$project" up -d >&2 || die "compose up failed"
  run_setup "$project" || die "setup step failed"
  # setup steps may refresh lockfiles: seal them so QA does not read them as the ticket's edits
  node "$SELF_DIR/env-build-files.mjs" seal --worktree "$WORKTREE" >&2 || true
  wait_ping "$project" || die "timed out waiting for the ping URL"
  if [ "$PORTS" = direct ]; then
    local shown; shown="$(url_shown "$direct")"
    log "probing the direct address from this machine: $shown"
    if ! wait_direct "$direct"; then
      [ "$DIRECT_CODE" = 000 ] && die "the engine did not make the stack reachable from this machine: $shown did not answer within ${READY_TIMEOUT}s (environment.directHost is $(cfg directHost); an engine that does not name containers that way needs another value)"
      die "the stack is reachable at its direct address but not serving: $shown still answered HTTP $DIRECT_CODE after ${READY_TIMEOUT}s"
    fi
    if [ "$DEVICE" = 1 ]; then
      local ip ipurl ipshown
      ip="$(container_ip "$project")" || die "could not read the IP address of the service $SERVICE (docker inspect): an Android emulator reaches a direct stack only by that address"
      ipurl="$(ip_url "$WEB_BASE_URL" "$ip")"; ipshown="$(url_shown "$ipurl")"
      log "probing the container address from this machine: $ipshown"
      if ! wait_direct "$ipurl"; then
        [ "$DIRECT_CODE" = 000 ] && die "the stack answers by name but its container address $ipshown did not answer within ${READY_TIMEOUT}s: an Android emulator reaches a direct stack only by that address (its DNS cannot see the name)"
        die "the container address $ipshown answered HTTP $DIRECT_CODE after ${READY_TIMEOUT}s: an Android emulator reaches a direct stack only by that address"
      fi
      record_ip "$ip" "$ipurl" "$direct"
    fi
  fi
  if [ "$DEVICE" = 1 ]; then
    ( cd "$WORKTREE" && bash "$SELF_DIR/mobile-env.sh" up --worktree "$WORKTREE" ) || { rc=$?; [ "$rc" = 75 ] && refuse "Metro port busy"; die "mobile lane failed"; }
  fi
  do_verify || die "environment did not meet the contract"
  ok=1
  trap - EXIT
  log "ready: $project"
}

# do_down_quiet PROJECT: every caller runs it while env.json still records the stack being taken down (do_down and the
# replace path remove the record after it; the EXIT trap of up runs after write_env), so the recorded mode says whether the
# stack held the ports lock: only a canonical or device stack takes it. The same owner pid can hold the lock for a canonical
# stack elsewhere, and a direct or isolated stack going down must not release that.
do_down_quiet() {
  local project="$1"
  compose "$project" down -v --remove-orphans >/dev/null 2>&1 || \
    docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker rm -f >/dev/null 2>&1
  forget_live "$project"
  case "$(env_get mode)" in
    canonical|device)
      [ "$(env_get ports)" != direct ] && [ -d "$PORTS_DIR/ports.lock" ] && [ "$(cat "$PORTS_DIR/ports.lock/owner" 2>/dev/null)" = "${DF_OWNER_PID:-$PPID}" ] && rm -rf "$PORTS_DIR/ports.lock" ;;
  esac
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
fresh_worktree() { # a worktree that still exists and whose run.json changed within SPARE_MINUTES
  local wt="$1"
  [ -n "$wt" ] && [ -f "$wt/.dev-factory/run.json" ] && [ -n "$(find "$wt/.dev-factory/run.json" -mmin "-$SPARE_MINUTES" 2>/dev/null)" ]
}
fresh_stray() { fresh_worktree "$(sed -n 2p "$STATE_DIR/live/$1" 2>/dev/null)"; }

# A stack that names its owner on its own containers is in use when that owner's pid is alive, or when its worktree is still
# being worked on. This holds from any state folder, which the live/ file does not. No labels (a stack started before they
# existed) or a docker that does not answer: not in use by this rule, so the live-file rule alone decides. Limits: the owner label
# is written when the stack is created and is not updated when a resumed ticket reuses it, so after a resume the worktree check
# is what protects it from a sweep in another state folder (the live file still protects it in its own); and kill -0 treats a pid
# of another user as dead, while a reused pid keeps a dead stack until that pid exits, the same convention live_projects uses.
labelled_in_use() {
  local first owner wt
  first="$(docker ps -a --filter "label=com.docker.compose.project=$1" --format '{{.Label "dev-factory.owner"}}|{{.Label "dev-factory.worktree"}}' 2>/dev/null | sed -n 1p)"
  owner="${first%%|*}"; wt=""
  case "$first" in *'|'*) wt="${first#*|}" ;; esac
  case "$owner" in ''|*[!0-9]*|0) ;; *) kill -0 "$owner" 2>/dev/null && return 0 ;; esac
  fresh_worktree "$wt"
}

do_sweep() {
  command -v docker >/dev/null 2>&1 || { log "docker not installed, nothing to sweep"; return 0; }
  local live; live="$(live_projects)"
  local projects
  projects="$(docker compose ls -a --format json 2>/dev/null | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{try{for(const p of JSON.parse(t))if(p.Name.startsWith("df-"))console.log(p.Name)}catch(e){}})')"
  local swept=0
  for p in $projects; do
    if ! printf '%s\n' "$live" | grep -qx "$p" && ! fresh_stray "$p" && ! labelled_in_use "$p"; then
      log "sweeping orphan $p"
      docker ps -aq --filter "label=com.docker.compose.project=$p" | xargs -r docker rm -f >/dev/null 2>&1
      docker network ls -q --filter "label=com.docker.compose.project=$p" | xargs -r docker network rm >/dev/null 2>&1
      docker volume ls -q --filter "label=com.docker.compose.project=$p" | xargs -r docker volume rm >/dev/null 2>&1
      forget_live "$p"; swept=$((swept + 1))
    fi
  done
  if [ -d "$PORTS_DIR/ports.lock" ]; then
    local holder; holder="$(cat "$PORTS_DIR/ports.lock/owner" 2>/dev/null || true)"
    if [ -z "$holder" ] || ! kill -0 "$holder" 2>/dev/null; then rm -rf "$PORTS_DIR/ports.lock"; log "released stale ports lock"; fi
  fi
  log "sweep done ($swept removed)"
}

case "$cmd" in
  up) do_up ;;
  verify) do_verify ;;
  down) do_down ;;
  sweep) do_sweep ;;
  *) echo "usage: e2e-env.sh up|verify|down|sweep [--worktree DIR] [--key KEY] [--ports canonical|direct|none] [--device] [--remote ENV [--account NAME]]" >&2; exit 3 ;;
esac
