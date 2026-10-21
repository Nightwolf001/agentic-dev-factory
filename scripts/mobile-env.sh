#!/usr/bin/env bash
# Host-side half of the device lane: simulator, Metro from this worktree, native build when native
# inputs changed. The backend stack is e2e-env.sh in device mode (canonical ports, machine-wide lock).
#
#   mobile-env.sh up [--worktree DIR]      prepare and record udid and Metro port in .dev-factory/env.json
#   mobile-env.sh down [--worktree DIR]    stop this worktree's Metro (the simulator is left booted)
#   mobile-env.sh pick                     print the udid that would be used (read-only)
#
# Exit codes: 0 ok, 1 failure, 75 refused (Metro port held by something this script did not start).
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${DF_STATE_DIR:-$HOME/.dev-factory}"
METRO_PORT="${DF_METRO_PORT:-8081}"
WORKTREE="$(pwd)"; cmd="${1:-}"; [ -n "$cmd" ] && shift
while [ $# -gt 0 ]; do case "$1" in --worktree) WORKTREE="$(cd "$2" && pwd)"; shift 2 ;; *) echo "unknown argument $1" >&2; exit 3 ;; esac; done
RUN_DIR="$WORKTREE/.dev-factory"; ENV_JSON="$RUN_DIR/env.json"; APP="$WORKTREE/clients/mobile"
log() { echo "mobile-env: $*" >&2; }
die() { log "$*"; exit 1; }

device_name() { sed -n '/^mobile:/,/^[a-z]/p' "$DIR/qa/profiles.yaml" | sed -n 's/^ *deviceProfile: *//p' | head -1; }

# udid of an already booted device with the profile's name, else the first available one with that name
pick_device() {
  local name; name="${DF_DEVICE_NAME:-$(device_name)}"
  xcrun simctl list devices available -j | node -e '
    const name=process.argv[1];let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{
      const all=Object.entries(JSON.parse(t).devices).filter(([r])=>/iOS/.test(r)).flatMap(([,d])=>d).filter(d=>d.name===name);
      let pick=all.find(d=>d.state==="Booted")||all[0];
      if(!pick){
        const any=Object.entries(JSON.parse(t).devices).filter(([r])=>/iOS/.test(r)).flatMap(([,d])=>d).filter(d=>/^iPhone/.test(d.name));
        pick=any.find(d=>d.state==="Booted")||any[0];
        if(!pick){console.error("no available iPhone simulator");process.exit(1)}
        console.error("mobile-env: no simulator named "+name+", using "+pick.name)}
      console.log(pick.udid+" "+pick.state)})' "$name"
}

metro_pid_file="$RUN_DIR/metro.pid"
port_holder() { lsof -nP -iTCP:"$METRO_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

native_hash() { cat "$APP/ios/Podfile.lock" "$APP"/ios/OlarmApp.xcodeproj/project.pbxproj 2>/dev/null | shasum -a 256 | cut -c1-16; }

json_merge() { node -e "const f='$ENV_JSON';const j=JSON.parse(require('fs').readFileSync(f,'utf8'));Object.assign(j,JSON.parse(process.argv[1]));require('fs').writeFileSync(f,JSON.stringify(j,null,2))" "$1"; }

do_up() {
  [ -f "$ENV_JSON" ] || die "no environment recorded; start the backend with e2e-env.sh up --device first"
  [ "$(node -p "require('$ENV_JSON').mode")" = "device" ] || die "backend environment is not in device mode"
  [ -d "$APP" ] || die "missing $APP"

  local line udid state; line="$(pick_device)" || die "$line"; udid="${line% *}"; state="${line#* }"
  if [ "$state" != "Booted" ]; then
    log "booting $udid"; xcrun simctl boot "$udid" >&2 || die "simulator boot failed"
  fi
  xcrun simctl bootstatus "$udid" -b >&2 || die "simulator did not finish booting"

  if [ -z "$(port_holder)" ]; then :; else
    if [ -f "$metro_pid_file" ] && kill -0 "$(cat "$metro_pid_file")" 2>/dev/null; then log "Metro already started by this worktree"
    else echo "mobile-env: port $METRO_PORT is held by pid $(port_holder), not started by this worktree" >&2; exit 75; fi
  fi

  cd "$APP" || exit 1
  bash scripts/set-e2e-environment.sh local >&2 || die "could not point .env at the local backend"
  [ -d node_modules ] || { log "yarn install"; yarn install --frozen-lockfile >&2 || die "yarn install failed"; }
  [ -d ios/Pods ] || { log "pod install"; yarn pods >&2 || die "pod install failed"; }

  if [ -z "$(port_holder)" ]; then
    log "starting Metro on $METRO_PORT from $APP"
    nohup yarn start:port "$METRO_PORT" > "$RUN_DIR/metro.log" 2>&1 &
    echo $! > "$metro_pid_file"
    local end=$((SECONDS + 300))
    until curl -sf "http://localhost:$METRO_PORT/status" 2>/dev/null | grep -q running; do
      [ "$SECONDS" -ge "$end" ] && die "Metro did not come up (see $RUN_DIR/metro.log)"; sleep 3
    done
  fi

  # Native build and install only when native inputs changed since the last build on this machine.
  local stamp="$STATE_DIR/native-$(native_hash).stamp"
  if [ ! -f "$stamp" ] || [ "${DF_FORCE_NATIVE_BUILD:-0}" = 1 ]; then
    log "native inputs changed (or first run): building and installing the app"
    yarn ios --udid "$udid" --port "$METRO_PORT" >&2 || die "native build failed"
    mkdir -p "$STATE_DIR"; touch "$stamp"
  else log "native build skipped (inputs unchanged)"; fi

  log "warming the JS bundle"
  curl -sf -m 900 -o /dev/null "http://localhost:$METRO_PORT/index.bundle?platform=ios&dev=true&minify=false" || die "bundle did not build"
  json_merge "{\"device\":{\"udid\":\"$udid\",\"profile\":\"$(device_name)\",\"metroPort\":$METRO_PORT,\"readyAt\":\"$(date -u +%FT%TZ)\"}}"
  log "ready: device $udid, Metro $METRO_PORT"
}

do_down() {
  if [ -f "$metro_pid_file" ]; then
    local pid; pid="$(cat "$metro_pid_file")"
    kill "$pid" 2>/dev/null; pkill -P "$pid" 2>/dev/null
    rm -f "$metro_pid_file"; log "stopped Metro"
  fi
}

case "$cmd" in
  up) do_up ;;
  down) do_down ;;
  pick) pick_device ;;
  *) echo "usage: mobile-env.sh up|down|pick [--worktree DIR]" >&2; exit 3 ;;
esac
