#!/usr/bin/env bash
# Host-side half of the device lane: a simulator (iOS) or emulator (Android), Metro from this worktree, native build when native
# inputs changed. The backend stack is e2e-env.sh in device mode (canonical ports, machine-wide lock), or a deployed
# environment (e2e-env.sh up --remote ENV --device).
#
#   mobile-env.sh up [--worktree DIR]      prepare and record the device and Metro port in .dev-factory/env.json
#   mobile-env.sh down [--worktree DIR]    stop this worktree's Metro (the device is left booted; cleanup.mjs shuts down what this run booted)
#   mobile-env.sh pick                     print the udid (iOS) or serial (Android) that would be used (read-only)
#
# The platform is DF_MOBILE_PLATFORM, else mobile.platform, else `platform` in .dev-factory/run.json, else read from the ticket
# (scripts/mobile-platform.mjs), else ios.
#   iOS      the simulator named by DF_DEVICE_NAME or the profile, booted if it is not; pods; mobile.build
#   Android  a headless emulator (AVD named by DF_DEVICE_NAME or mobile.androidAvd), reused when it is running; `adb reverse` for
#            Metro and mobile.androidReversePorts; no pods; mobile.androidBuild
#
# Exit codes: 0 ok, 1 failure, 75 refused (Metro port held by something this script did not start).
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${DF_STATE_DIR:-$HOME/.dev-factory}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
cfg() { node "$SELF_DIR/config.mjs" get "mobile.$1" 2>/dev/null || true; }
METRO_PORT="${DF_METRO_PORT:-$(cfg metroPort)}"; METRO_PORT="${METRO_PORT:-8081}"
WORKTREE="$(pwd)"; cmd="${1:-}"; [ -n "$cmd" ] && shift
while [ $# -gt 0 ]; do case "$1" in --worktree) WORKTREE="$(cd "$2" && pwd)"; shift 2 ;; *) echo "unknown argument $1" >&2; exit 3 ;; esac; done
RUN_DIR="$WORKTREE/.dev-factory"; ENV_JSON="$RUN_DIR/env.json"; APP="$WORKTREE/$(cfg appDir)"
log() { echo "mobile-env: $*" >&2; }
die() { log "$*"; exit 1; }

case "${DF_MOBILE_PLATFORM:-}" in ''|ios|android) ;; *) die "DF_MOBILE_PLATFORM must be ios or android (got '${DF_MOBILE_PLATFORM}')" ;; esac
PLATFORM="$(node "$SELF_DIR/mobile-platform.mjs" resolve --worktree "$WORKTREE" 2>/dev/null)"; PLATFORM="${PLATFORM:-ios}"
case "$PLATFORM" in ios|android) ;; *) die "platform must be ios or android (got '$PLATFORM')" ;; esac

# ---- iOS ----
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

# The save-password dialog that follows a login covers the app and hides it from Maestro. mobile.iosAutofillOff is the command
# that turns password AutoFill off on a simulator ({udid} is filled in); it runs once per simulator on this machine.
ios_autofill_off() {
  local c stamp; c="$(cfg iosAutofillOff)"; [ -n "$c" ] || return 0
  stamp="$STATE_DIR/autofill-$1.done"; [ -f "$stamp" ] && return 0
  log "turning password AutoFill off on $1 (once per simulator)"
  if bash -c "${c//\{udid\}/$1}" >&2; then mkdir -p "$STATE_DIR"; touch "$stamp"; else log "warning: mobile.iosAutofillOff failed; a save-password dialog may hide the app"; fi
}

# ---- Android ----
android_sdk() { printf '%s' "${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"; }
adb_bin() { if command -v adb >/dev/null 2>&1; then command -v adb; else printf '%s' "$(android_sdk)/platform-tools/adb"; fi; }
emulator_bin() { if command -v emulator >/dev/null 2>&1; then command -v emulator; else printf '%s' "$(android_sdk)/emulator/emulator"; fi; }
adb_() { "$(adb_bin)" "$@"; }

avd_name() {
  local n="${DF_DEVICE_NAME:-$(cfg androidAvd)}"
  [ -n "$n" ] || n="$("$(emulator_bin)" -list-avds 2>/dev/null | head -1 | tr -d '\r')"
  printf '%s' "$n"
}
emulator_serials() { adb_ devices 2>/dev/null | awk '/^emulator-[0-9]+[ \t]+device/{print $1}'; }
serial_avd() { adb_ -s "$1" emu avd name 2>/dev/null | head -1 | tr -d '\r'; }
running_serial_for() { local s; for s in $(emulator_serials); do [ "$(serial_avd "$s")" = "$1" ] && { printf '%s' "$s"; return 0; }; done; return 1; }

# Reuses a running emulator of the AVD, else boots one headless. Prints "serial booted" (booted: true when this call started it).
android_device() {
  local avd serial before pid end s
  avd="$(avd_name)"; [ -n "$avd" ] || die "no Android virtual device: set mobile.androidAvd (or DF_DEVICE_NAME); 'emulator -list-avds' lists them"
  if serial="$(running_serial_for "$avd")"; then printf '%s false' "$serial"; return 0; fi
  [ -x "$(emulator_bin)" ] || die "emulator not found: set ANDROID_SDK_ROOT (looked in $(emulator_bin))"
  before=" $(emulator_serials | tr '\n' ' ') "
  log "booting emulator $avd (headless)"
  nohup "$(emulator_bin)" -avd "$avd" -no-window -no-audio -no-boot-anim -no-snapshot-save > "$RUN_DIR/emulator.log" 2>&1 &
  pid=$!; echo "$pid" > "$RUN_DIR/emulator.pid"
  end=$((SECONDS + ${DF_EMULATOR_BOOT_TIMEOUT:-300}))
  serial=""
  while [ -z "$serial" ]; do
    for s in $(emulator_serials); do
      case "$before" in *" $s "*) ;; *) [ "$(serial_avd "$s")" = "$avd" ] && serial="$s" ;; esac
    done
    [ -n "$serial" ] && break
    [ "$SECONDS" -ge "$end" ] && die "the emulator did not appear in adb (see $RUN_DIR/emulator.log)"
    sleep 2
  done
  until [ "$(adb_ -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do
    [ "$SECONDS" -ge "$end" ] && die "the emulator did not finish booting (see $RUN_DIR/emulator.log)"
    sleep 3
  done
  printf '%s true' "$serial"
}

metro_pid_file="$RUN_DIR/metro.pid"
port_holder() { lsof -nP -iTCP:"$METRO_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

# hash of the files named in mobile.nativeInputs / mobile.androidNativeInputs (globs, relative to appDir): a change means a native
# rebuild. On iOS the Xcode version is part of it: a simulator runtime newer than the Xcode that built the app refuses its binary.
native_hash() {
  local key="nativeInputs"; [ "$PLATFORM" = android ] && key="androidNativeInputs"
  ( cd "$APP" && for g in $(node -e 'for (const p of JSON.parse(process.argv[1]||"[]")) console.log(p)' "$(cfg $key)"); do cat $g 2>/dev/null; done
    if [ "$PLATFORM" = ios ]; then xcodebuild -version 2>/dev/null; fi ) | shasum -a 256 | cut -c1-16
}
# a configured command with {port}, {udid} and {serial} filled in; empty when not configured
mobile_cmd() { local c; c="$(cfg "$1")"; c="${c//\{port\}/$METRO_PORT}"; c="${c//\{udid\}/${udid:-}}"; echo "${c//\{serial\}/${serial:-}}"; }

json_merge() { node -e "const f='$ENV_JSON';const j=JSON.parse(require('fs').readFileSync(f,'utf8'));Object.assign(j,JSON.parse(process.argv[1]));require('fs').writeFileSync(f,JSON.stringify(j,null,2))" "$1"; }

do_up() {
  [ -f "$ENV_JSON" ] || die "no environment recorded; start the backend with e2e-env.sh up --device first"
  local mode dev
  mode="$(node -p "require('$ENV_JSON').mode")"; dev="$(node -p "String(require('$ENV_JSON').device===true)")"
  if [ "$mode" != device ] && { [ "$mode" != remote ] || [ "$dev" != true ]; }; then die "backend environment is not in device mode"; fi
  [ -n "$(cfg appDir)" ] || die "mobile.appDir is not configured, the device lane is disabled"
  [ -d "$APP" ] || die "missing $APP"

  local line udid="" serial="" state booted=false
  if [ "$PLATFORM" = android ]; then
    line="$(android_device)" || exit 1; serial="${line% *}"; [ "${line#* }" = true ] && booted=true
    log "Android device $serial"
  else
    line="$(pick_device)" || die "$line"; udid="${line% *}"; state="${line#* }"
    if [ "$state" != "Booted" ]; then
      log "booting $udid"; xcrun simctl boot "$udid" >&2 || die "simulator boot failed"; booted=true   # ours: cleanup shuts it down again
    fi
    xcrun simctl bootstatus "$udid" -b >&2 || die "simulator did not finish booting"
    ios_autofill_off "$udid"
  fi

  if [ -z "$(port_holder)" ]; then :; else
    if [ -f "$metro_pid_file" ] && kill -0 "$(cat "$metro_pid_file")" 2>/dev/null; then log "Metro already started by this worktree"
    else echo "mobile-env: port $METRO_PORT is held by pid $(port_holder), not started by this worktree" >&2; exit 75; fi
  fi

  cd "$APP" || exit 1
  local step p
  step="$(mobile_cmd prepare)"; [ -z "$step" ] || bash -c "$step" >&2 || die "prepare failed: $step"
  step="$(mobile_cmd install)"; if [ -n "$step" ] && [ ! -d node_modules ]; then log "$step"; bash -c "$step" >&2 || die "install failed"; fi
  if [ "$PLATFORM" = ios ]; then
    step="$(mobile_cmd pods)"; if [ -n "$step" ] && [ ! -d ios/Pods ]; then log "$step"; bash -c "$step" >&2 || die "pod install failed"; fi
  else
    # the emulator reaches this machine's Metro (and the backend ports the app needs) through adb reverse
    for p in "$METRO_PORT" $(node -e 'for (const p of JSON.parse(process.argv[1]||"[]")) console.log(p)' "$(cfg androidReversePorts)"); do
      adb_ -s "$serial" reverse "tcp:$p" "tcp:$p" >&2 || die "adb reverse tcp:$p failed"
    done
  fi

  if [ -z "$(port_holder)" ]; then
    local start_cmd; start_cmd="$(node "$SELF_DIR/mobile-platform.mjs" metro-command "$(mobile_cmd start)")"
    log "starting Metro on $METRO_PORT from $APP"
    nohup bash -c "$start_cmd" > "$RUN_DIR/metro.log" 2>&1 &
    echo $! > "$metro_pid_file"
    local end=$((SECONDS + 300))
    until curl -sf "http://localhost:$METRO_PORT/status" 2>/dev/null | grep -q running; do
      [ "$SECONDS" -ge "$end" ] && die "Metro did not come up (see $RUN_DIR/metro.log)"
      sleep 3
    done
  fi

  # Native build and install only when native inputs changed since the last build on this machine.
  local stamp="$STATE_DIR/native-$PLATFORM-$(native_hash).stamp" build_key="build"
  [ "$PLATFORM" = android ] && build_key="androidBuild"
  if [ ! -f "$stamp" ] || [ "${DF_FORCE_NATIVE_BUILD:-0}" = 1 ]; then
    log "native inputs changed (or first run): building and installing the app"
    bash -c "$(mobile_cmd $build_key)" >&2 || die "native build failed"
    mkdir -p "$STATE_DIR"; touch "$stamp"
  else log "native build skipped (inputs unchanged)"; fi

  # pod install and the native build rewrite tracked project files: seal them so QA does not read them as the ticket's edits
  node "$SELF_DIR/env-build-files.mjs" seal --worktree "$WORKTREE" >&2 || true

  log "warming the JS bundle"
  curl -sf -m 900 -o /dev/null "http://localhost:$METRO_PORT/index.bundle?platform=$PLATFORM&dev=true&minify=false" || die "bundle did not build"
  if [ "$PLATFORM" = android ]; then
    json_merge "{\"device\":{\"platform\":\"android\",\"serial\":\"$serial\",\"avd\":\"$(avd_name)\",\"bootedByFactory\":$booted,\"metroPort\":$METRO_PORT,\"readyAt\":\"$(date -u +%FT%TZ)\"}}"
    log "ready: Android $serial, Metro $METRO_PORT"
  else
    json_merge "{\"device\":{\"platform\":\"ios\",\"udid\":\"$udid\",\"profile\":\"$(device_name)\",\"bootedByFactory\":$booted,\"metroPort\":$METRO_PORT,\"readyAt\":\"$(date -u +%FT%TZ)\"}}"
    log "ready: device $udid, Metro $METRO_PORT"
  fi
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
  pick)
    if [ "$PLATFORM" = android ]; then
      if s="$(running_serial_for "$(avd_name)")"; then echo "$s running"; else echo "- not-running"; fi
    else pick_device; fi ;;
  *) echo "usage: mobile-env.sh up|down|pick [--worktree DIR]" >&2; exit 3 ;;
esac
