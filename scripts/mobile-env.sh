#!/usr/bin/env bash
# Host-side half of the device lane: a simulator (iOS) or emulator (Android), Metro from this worktree, native build when native
# inputs changed. The backend stack is e2e-env.sh in device mode (canonical ports under a machine-wide lock, or direct ports with
# no lock), or a deployed environment (e2e-env.sh up --remote ENV --device).
#
# Several tasks at once: each run gets a Metro port of its own, the first free one counting up from mobile.metroPort (8081, 8082,
# ...; DF_METRO_PORT pins one), and a device of its own: a simulator or emulator no other live run holds, else a new simulator of
# the same kind ("<name> df<n>", kept for later runs) or a second, read-only instance of the AVD. Both are claimed in the machine
# folder (metro-ports/<port>, devices/<udid or serial>); a claim is live while its worktree's Metro runs, and for 20 minutes after
# it was made, so a run still setting up keeps it. On a direct stack each port in mobile.androidReversePorts gets a host port of
# its own, a proxy to that port of the task's container (scripts/port-proxy.mjs), and the emulator is reversed to it: the app keeps
# calling localhost:<port> and reaches its own task.
#
# Expo Go and other prebuilt clients: mobile.deviceSetup (iOS) and mobile.androidDeviceSetup run when the app (mobile.appId,
# mobile.androidAppId) is not on the device, or every time when no app id is set; mobile.open and mobile.androidOpen run on every
# start, after the native build or its skip, to open the app on this run's Metro.
#
#   mobile-env.sh up [--worktree DIR]      prepare and record the device and Metro port in .dev-factory/env.json
#   mobile-env.sh down [--worktree DIR]    stop this worktree's Metro (the device is left booted; cleanup.mjs shuts down what this run booted)
#   mobile-env.sh pick                     print the udid (iOS) or serial (Android) that would be used (read-only)
#
# On a direct stack (e2e-env.sh up --ports direct --device) the stack has no host port, so the app reaches its API at the stack's own
# address, and that differs by platform: the name for iOS (this Mac and the simulator resolve it), the container's IP for Android
# (the emulator's DNS cannot see the name). {apiBaseUrl} in a mobile command is that address, and device.apiBaseUrl records it;
# on a canonical stack it is empty, since the app has the ports baked in and Android reaches them through adb reverse.
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
# devices and host ports belong to the machine: a repository's own state folder keeps their claims in the machine folder above it
MACHINE_DIR="$STATE_DIR"; [ "$(dirname "$STATE_DIR")" = "$HOME/.dev-factory" ] && MACHINE_DIR="$HOME/.dev-factory"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
cfg() { node "$SELF_DIR/config.mjs" get "mobile.$1" 2>/dev/null || true; }
PINNED_PORT="${DF_METRO_PORT:-}"
BASE_PORT="$(cfg metroPort)"; BASE_PORT="${BASE_PORT:-8081}"; METRO_PORT="${PINNED_PORT:-$BASE_PORT}"
WORKTREE="$(pwd)"; cmd="${1:-}"; [ -n "$cmd" ] && shift
while [ $# -gt 0 ]; do case "$1" in --worktree) WORKTREE="$(cd "$2" && pwd)"; shift 2 ;; *) echo "unknown argument $1" >&2; exit 3 ;; esac; done
RUN_DIR="$WORKTREE/.dev-factory"; ENV_JSON="$RUN_DIR/env.json"; APP="$WORKTREE/$(cfg appDir)"
log() { echo "mobile-env: $*" >&2; }
die() { log "$*"; exit 1; }

# ---- claims on machine resources (Metro ports, devices) ----
# A claim is a folder holding the worktree that made it. It is live while that worktree's Metro runs, or for 20 minutes after it
# was made (a run still booting its device or installing has no Metro yet); anything else is left over and may be taken.
claim_live() {
  local d="$1" wt pid
  [ -d "$d" ] || return 1
  [ $(( $(date +%s) - $(stat -f %m "$d" 2>/dev/null || stat -c %Y "$d" 2>/dev/null || echo 0) )) -lt "${DF_CLAIM_GRACE_SECONDS:-1200}" ] && return 0
  wt="$(cat "$d/worktree" 2>/dev/null)"; [ -n "$wt" ] || return 1
  pid="$(cat "$wt/.dev-factory/metro.pid" 2>/dev/null)"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null
}
claim_mine() { [ "$(cat "$1/worktree" 2>/dev/null)" = "$WORKTREE" ]; }
# 0 when this worktree holds the claim (now or already); 1 when another live run does
claim() {
  local d="$1"; mkdir -p "$(dirname "$d")"
  claim_mine "$d" && return 0
  if mkdir "$d" 2>/dev/null; then printf '%s' "$WORKTREE" > "$d/worktree"; return 0; fi
  claim_live "$d" && return 1
  # left over: replace it (remove, then mkdir, so of two runs reclaiming it only one gets it)
  rm -rf "$d"; mkdir "$d" 2>/dev/null || return 1
  printf '%s' "$WORKTREE" > "$d/worktree"; return 0
}
release_claims() {
  local d
  for d in "$MACHINE_DIR"/metro-ports/* "$MACHINE_DIR"/devices/*; do
    [ -d "$d" ] && claim_mine "$d" && rm -rf "$d"
  done
  return 0
}
device_claim() { printf '%s/devices/%s' "$MACHINE_DIR" "$1"; }
port_listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }

# This run's Metro port: DF_METRO_PORT when set (exit 75 later if something else holds it), else the port this worktree already
# claimed, else the first port from mobile.metroPort up that nothing listens on and no other live run claimed.
pick_metro_port() {
  [ -n "$PINNED_PORT" ] && return 0
  local p d
  for d in "$MACHINE_DIR"/metro-ports/*; do
    [ -d "$d" ] && claim_mine "$d" && { METRO_PORT="${d##*/}"; return 0; }
  done
  p="$BASE_PORT"
  while [ "$p" -lt $((BASE_PORT + ${DF_METRO_PORT_RANGE:-50})) ]; do
    if [ -z "$(port_listening "$p")" ] && claim "$MACHINE_DIR/metro-ports/$p"; then
      # claimed between the check and the claim by a Metro that is not ours: give it back and look further
      if [ -z "$(port_listening "$p")" ]; then METRO_PORT="$p"; return 0; fi
      rm -rf "$MACHINE_DIR/metro-ports/$p"
    fi
    p=$((p + 1))
  done
  die "no free Metro port from $BASE_PORT to $((p - 1)): every one is in use or claimed by a live run"
}

case "${DF_MOBILE_PLATFORM:-}" in ''|ios|android) ;; *) die "DF_MOBILE_PLATFORM must be ios or android (got '${DF_MOBILE_PLATFORM}')" ;; esac
PLATFORM="$(node "$SELF_DIR/mobile-platform.mjs" resolve --worktree "$WORKTREE" 2>/dev/null)"; PLATFORM="${PLATFORM:-ios}"
case "$PLATFORM" in ios|android) ;; *) die "platform must be ios or android (got '$PLATFORM')" ;; esac

# ---- iOS ----
device_name() { sed -n '/^mobile:/,/^[a-z]/p' "$DIR/qa/profiles.yaml" | sed -n 's/^ *deviceProfile: *//p' | head -1; }

# The simulators this run may use, best first: those with the profile's name and the copies the factory made of it ("<name> df<n>"),
# booted ones first; with none of that name, any iPhone. One line each, tab-separated: udid, state, name, device type, runtime.
candidate_devices() {
  local name; name="${DF_DEVICE_NAME:-$(device_name)}"
  xcrun simctl list devices available -j | node -e '
    const name=process.argv[1];let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{
      const all=Object.entries(JSON.parse(t).devices).filter(([r])=>/iOS/.test(r)).flatMap(([r,d])=>d.map(x=>({...x,runtime:r})));
      const copy=(n)=>n.startsWith(name+" df")&&/^[0-9]+$/.test(n.slice(name.length+3));
      let pool=all.filter(d=>d.name===name||copy(d.name));
      if(!pool.length){
        pool=all.filter(d=>/^iPhone/.test(d.name));
        if(!pool.length){console.error("no available iPhone simulator");process.exit(1)}
        console.error("mobile-env: no simulator named "+name+", using "+pool[0].name)}
      const rank=d=>(d.state==="Booted"?0:2)+(d.name===name?0:1);
      pool.sort((a,b)=>rank(a)-rank(b));
      for(const d of pool)console.log([d.udid,d.state,d.name,d.deviceTypeIdentifier||"",d.runtime].join("\t"))})' "$name"
}
# read-only: the simulator a run would start from, "udid state"
pick_device() { candidate_devices | head -1 | cut -f1,2 | tr '\t' ' '; }

# Claims a simulator for this run: the first candidate no other live run holds, else a new one of the first one's kind, named
# "<name> df<n>" and kept, so later runs reuse it. Prints "udid state".
claim_ios_device() {
  local lines udid state name type runtime first="" n=2
  lines="$(candidate_devices)" || return 1
  while IFS="$(printf '\t')" read -r udid state name type runtime; do
    [ -n "$udid" ] || continue
    [ -n "$first" ] || first="$name	$type	$runtime"
    if claim "$(device_claim "$udid")"; then printf '%s %s\n' "$udid" "$state"; return 0; fi
  done <<LIST
$lines
LIST
  IFS="$(printf '\t')" read -r name type runtime <<LIST
$first
LIST
  case "$name" in *" df"[0-9]*) name="${name% df*}" ;; esac
  [ -n "$type" ] && [ -n "$runtime" ] || { log "every simulator is held by another run, and simctl does not say how to make another"; return 1; }
  while printf '%s\n' "$lines" | cut -f3 | grep -qx "$name df$n"; do n=$((n + 1)); done
  log "every $name is held by another run: creating $name df$n"
  udid="$(xcrun simctl create "$name df$n" "$type" "$runtime" 2>/dev/null)" || { log "simctl create failed"; return 1; }
  claim "$(device_claim "$udid")" || return 1
  printf '%s Shutdown\n' "$udid"
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

# Reuses a running emulator of the AVD that no other live run holds, else boots one headless; a further instance of an AVD that is
# already running is read-only, since the emulator allows one writable instance per AVD. Prints "serial booted" (booted: true when
# this call started it). The serial is claimed for this run.
android_device() {
  local avd serial before pid end s extra=""
  avd="$(avd_name)"; [ -n "$avd" ] || die "no Android virtual device: set mobile.androidAvd (or DF_DEVICE_NAME); 'emulator -list-avds' lists them"
  for s in $(emulator_serials); do
    [ "$(serial_avd "$s")" = "$avd" ] || continue
    extra="-read-only"
    if claim "$(device_claim "$s")"; then printf '%s false' "$s"; return 0; fi
  done
  [ -x "$(emulator_bin)" ] || die "emulator not found: set ANDROID_SDK_ROOT (looked in $(emulator_bin))"
  before=" $(emulator_serials | tr '\n' ' ') "
  log "booting emulator $avd (headless${extra:+, a further read-only instance})"
  nohup "$(emulator_bin)" -avd "$avd" -no-window -no-audio -no-boot-anim -no-snapshot-save $extra > "$RUN_DIR/emulator.log" 2>&1 &
  pid=$!; echo "$pid" > "$RUN_DIR/emulator.pid"
  end=$((SECONDS + ${DF_EMULATOR_BOOT_TIMEOUT:-300}))
  serial=""
  while [ -z "$serial" ]; do
    for s in $(emulator_serials); do
      case "$before" in *" $s "*) ;; *) [ "$(serial_avd "$s")" = "$avd" ] && claim "$(device_claim "$s")" && { serial="$s"; break; } ;; esac
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
# a configured command with {port}, {udid}, {serial} and {apiBaseUrl} filled in; empty when not configured
API_BASE=""
mobile_cmd() { local c; c="$(cfg "$1")"; c="${c//\{port\}/$METRO_PORT}"; c="${c//\{udid\}/${udid:-}}"; c="${c//\{apiBaseUrl\}/$API_BASE}"; echo "${c//\{serial\}/${serial:-}}"; }

# The address the app's API is reached at on a direct stack, read from env.json, which the run can write: it goes into shell commands,
# so only a plain http(s) address (letters, digits, dots, hyphens, a port and a simple path) is accepted.
resolve_api_base() {
  local ports key=webBaseUrl; ports="$(node -p "String(require('$ENV_JSON').ports??'')")"
  [ "$ports" = direct ] || return 0
  [ "$PLATFORM" = android ] && key=directIpUrl
  API_BASE="$(node -p "String(require('$ENV_JSON')['$key']??'')")"
  if [ -z "$API_BASE" ]; then
    [ "$PLATFORM" = android ] && die "no container address in env.json: an Android emulator cannot resolve the stack's name; start the stack with e2e-env.sh up --ports direct --device"
    die "no web address in env.json: start the stack with e2e-env.sh up --ports direct --device"
  fi
  printf '%s' "$API_BASE" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' || die "the address env.json gives for the app ($(printf '%s' "$API_BASE" | tr -cd '[:print:]' | cut -c1-60)) is not a plain http(s) address"
}

# the simulator's own name, for the evidence (the profile names the kind asked for, not always the one used)
sim_name() { xcrun simctl list devices -j 2>/dev/null | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{try{for(const l of Object.values(JSON.parse(t).devices))for(const d of l)if(d.udid===process.argv[1]){console.log(d.name);return}}catch{}})' "$1" | tr -d '"\\'; }

has_app_id() { [ -n "$(cfg appId)" ] || { [ "$PLATFORM" = android ] && [ -n "$(cfg androidAppId)" ]; }; }
# Whether the app (mobile.appId on iOS, mobile.androidAppId else mobile.appId on Android) is on this run's device. With no app id
# there is nothing to look for, so the answer is no and the setup command runs.
app_installed() {
  local id
  if [ "$PLATFORM" = android ]; then
    id="$(cfg androidAppId)"; [ -n "$id" ] || id="$(cfg appId)"; [ -n "$id" ] || return 1
    adb_ -s "$serial" shell pm path "$id" 2>/dev/null | grep -q '^package:'
  else
    id="$(cfg appId)"; [ -n "$id" ] || return 1
    xcrun simctl get_app_container "$udid" "$id" >/dev/null 2>&1
  fi
}

# A host port of this run's own for port P of the task's container: a proxy (scripts/port-proxy.mjs) on 127.0.0.1 to the container's
# IP, which env.json records for a direct stack. Prints the host port. One proxy per port, reused while it runs.
start_proxy() {
  local p="$1" ip pidf portf end
  pidf="$RUN_DIR/proxy-$p.pid"; portf="$RUN_DIR/proxy-$p.port"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null && [ -s "$portf" ]; then cat "$portf"; return 0; fi
  ip="$(node -p "String(require('$ENV_JSON').directIp??'')")"
  printf '%s' "$ip" | grep -Eq '^[0-9]+(\.[0-9]+){3}$' || { log "no container IP in env.json for the proxy to port $p"; return 1; }
  case "$p" in ''|*[!0-9]*) log "mobile.androidReversePorts holds a port that is not a number: $p"; return 1 ;; esac
  rm -f "$portf"
  # DF_PORT_PROXY replaces the proxy program (the tests use a stub, as their sandbox has no network)
  nohup ${DF_PORT_PROXY:-node "$SELF_DIR/port-proxy.mjs"} --to "$ip:$p" --port-file "$portf" > "$RUN_DIR/proxy-$p.log" 2>&1 &
  echo $! > "$pidf"
  end=$((SECONDS + 10))
  until [ -s "$portf" ]; do [ "$SECONDS" -ge "$end" ] && { log "the proxy to $ip:$p did not start (see $RUN_DIR/proxy-$p.log)"; return 1; }; sleep 0.2; done
  cat "$portf"
}

json_merge() { node -e "const f='$ENV_JSON';const j=JSON.parse(require('fs').readFileSync(f,'utf8'));Object.assign(j,JSON.parse(process.argv[1]));require('fs').writeFileSync(f,JSON.stringify(j,null,2))" "$1"; }

do_up() {
  [ -f "$ENV_JSON" ] || die "no environment recorded; start the backend with e2e-env.sh up --device first"
  local mode dev
  mode="$(node -p "require('$ENV_JSON').mode")"; dev="$(node -p "String(require('$ENV_JSON').device===true)")"
  if [ "$mode" != device ] && { [ "$mode" != remote ] || [ "$dev" != true ]; }; then die "backend environment is not in device mode"; fi
  [ -n "$(cfg appDir)" ] || die "mobile.appDir is not configured, the device lane is disabled"
  [ -d "$APP" ] || die "missing $APP"
  resolve_api_base

  # a start that fails gives its claims back, so the next run does not wait out the grace period for nothing
  trap 'stop_proxies; release_claims' EXIT
  pick_metro_port
  local line udid="" serial="" state booted=false
  if [ "$PLATFORM" = android ]; then
    line="$(android_device)" || exit 1; serial="${line% *}"; [ "${line#* }" = true ] && booted=true
    log "Android device $serial"
  else
    line="$(claim_ios_device)" || die "no simulator for this run"; udid="${line% *}"; state="${line#* }"
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
    # Metro: the run's own port, and the default port too when they differ, since a dev build looks for Metro on mobile.metroPort
    adb_ -s "$serial" reverse "tcp:$METRO_PORT" "tcp:$METRO_PORT" >&2 || die "adb reverse tcp:$METRO_PORT failed"
    if [ "$BASE_PORT" != "$METRO_PORT" ]; then adb_ -s "$serial" reverse "tcp:$BASE_PORT" "tcp:$METRO_PORT" >&2 || die "adb reverse tcp:$BASE_PORT failed"; fi
    # the backend ports the app calls on localhost: on a direct stack each goes to a host port of this run's own, a proxy to its container
    for p in $(node -e 'for (const p of JSON.parse(process.argv[1]||"[]")) console.log(p)' "$(cfg androidReversePorts)"); do
      local host_port="$p"
      if [ "$(node -p "String(require('$ENV_JSON').ports??'')")" = direct ]; then host_port="$(start_proxy "$p")" || die "could not start a proxy for port $p"; fi
      adb_ -s "$serial" reverse "tcp:$p" "tcp:$host_port" >&2 || die "adb reverse tcp:$p failed"
      REVERSE_JSON="${REVERSE_JSON:+$REVERSE_JSON,}\"$p\":$host_port"
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

  # a prebuilt client (Expo Go) the device lacks: installed by the setup command, which also runs when no app id says what to look for
  local setup_key="deviceSetup"; [ "$PLATFORM" = android ] && setup_key="androidDeviceSetup"
  step="$(mobile_cmd $setup_key)"
  if [ -n "$step" ] && ! app_installed; then log "setting the device up: $step"; bash -c "$step" >&2 || die "device setup failed: $step"; fi

  # Native build and install only when native inputs changed since the last build on this device, or the app is not on it.
  local device_id="${udid:-$serial}"
  local stamp="$MACHINE_DIR/native-$PLATFORM-$device_id-$(native_hash).stamp" build_key="build"
  [ "$PLATFORM" = android ] && build_key="androidBuild"
  step="$(mobile_cmd $build_key)"
  if [ -z "$step" ]; then :
  elif [ ! -f "$stamp" ] || [ "${DF_FORCE_NATIVE_BUILD:-0}" = 1 ] || { has_app_id && ! app_installed; }; then
    log "native inputs changed (or first run on this device): building and installing the app"
    bash -c "$step" >&2 || die "native build failed"
    mkdir -p "$MACHINE_DIR"; touch "$stamp"
  else log "native build skipped (inputs unchanged)"; fi

  # pod install and the native build rewrite tracked project files: seal them so QA does not read them as the ticket's edits
  node "$SELF_DIR/env-build-files.mjs" seal --worktree "$WORKTREE" >&2 || true

  log "warming the JS bundle"
  curl -sf -m 900 -o /dev/null "http://localhost:$METRO_PORT/index.bundle?platform=$PLATFORM&dev=true&minify=false" || die "bundle did not build"
  # open the app on this run's Metro, every start: a prebuilt client has nothing to build, and the native build is often skipped
  local open_key="open"; [ "$PLATFORM" = android ] && open_key="androidOpen"
  step="$(mobile_cmd $open_key)"
  if [ -n "$step" ]; then log "opening the app: $step"; bash -c "$step" >&2 || die "opening the app failed: $step"; fi
  local api_json; api_json="$(API_BASE="$API_BASE" node -p 'JSON.stringify(process.env.API_BASE||null)')"
  if [ "$PLATFORM" = android ]; then
    json_merge "{\"device\":{\"platform\":\"android\",\"serial\":\"$serial\",\"avd\":\"$(avd_name)\",\"name\":\"$(avd_name)\",\"bootedByFactory\":$booted,\"metroPort\":$METRO_PORT,\"reversePorts\":{${REVERSE_JSON:-}},\"apiBaseUrl\":$api_json,\"readyAt\":\"$(date -u +%FT%TZ)\"}}"
    log "ready: Android $serial, Metro $METRO_PORT"
  else
    json_merge "{\"device\":{\"platform\":\"ios\",\"udid\":\"$udid\",\"profile\":\"$(device_name)\",\"name\":\"$(sim_name "$udid")\",\"bootedByFactory\":$booted,\"metroPort\":$METRO_PORT,\"apiBaseUrl\":$api_json,\"readyAt\":\"$(date -u +%FT%TZ)\"}}"
    log "ready: device $udid, Metro $METRO_PORT"
  fi
  trap - EXIT
}

stop_proxies() {
  local f
  for f in "$RUN_DIR"/proxy-*.pid; do
    [ -f "$f" ] || continue
    kill "$(cat "$f")" 2>/dev/null; rm -f "$f" "${f%.pid}.port"; log "stopped the proxy ${f##*/}"
  done
  return 0
}

do_down() {
  stop_proxies
  release_claims
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
