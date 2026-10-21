#!/usr/bin/env bash
# Machine preflight. Usage: doctor.sh [--ci] [--wizard]
set -uo pipefail
CI=0; [ "${1:-}" = "--ci" ] && CI=1
DIR="$(cd "$(dirname "$0")/.." && pwd)"; REPO="$(cd "$DIR/.." && pwd)"
if [ "${1:-}" = "--wizard" ]; then exec bash "$DIR/scripts/wizard.sh"; fi
fail=0
ok()   { printf 'ok    %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }
warn() { printf 'warn  %s\n' "$1"; }

want="$(tr -d ' v\n' < "$REPO/.nvmrc")"; have="$(node -v 2>/dev/null | sed 's/^v//;s/\..*//')"
[ "$have" = "$want" ] && ok "node $have matches .nvmrc" || bad "node major '$have' != .nvmrc '$want'"
command -v claude >/dev/null && ok "claude $(claude --version 2>/dev/null | head -1)" || bad "claude not installed"
gh auth status >/dev/null 2>&1 && ok "gh authenticated" || bad "gh not authenticated"
docker info >/dev/null 2>&1 && ok "docker reachable" || bad "docker daemon unreachable"
docker compose version >/dev/null 2>&1 && ok "docker compose present" || bad "docker compose missing"
for h in api.olarm.local login.olarm.local; do
  grep -q "$h" /etc/hosts 2>/dev/null && ok "/etc/hosts has $h" || warn "/etc/hosts lacks $h (see MANUAL_SETUP.md)"
done
if [ "$CI" = 0 ]; then
  command -v xcrun >/dev/null && xcrun simctl list runtimes 2>/dev/null | grep -q iOS && ok "iOS simulator runtime" || warn "no iOS simulator runtime (mobile lane disabled)"
  command -v maestro >/dev/null && ok "maestro $(maestro --version 2>/dev/null | head -1)" || warn "maestro missing (mobile lane disabled)"
  [ -f "$DIR/.env.local" ] && ok ".env.local present" || warn ".env.local missing (copy .env.example)"
  git -C "$REPO" ls-files --error-unmatch "dev-factory/.env.local" >/dev/null 2>&1 && bad ".env.local is tracked by git"
else
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ] && ok "claude credential in env" || bad "no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY"
fi
for pl in $(node -e 'for(const x of require(process.argv[1]).plugins) if(x.required) console.log(x.id)' "$DIR/plugins.json"); do
  claude plugin list 2>/dev/null | grep -q "$pl" && ok "plugin $pl" || bad "plugin $pl not installed (bash dev-factory/scripts/install.sh --apply)"
done
mcp_list="$(claude mcp list 2>/dev/null)"
for srv in sentry axiom; do
  line="$(printf '%s\n' "$mcp_list" | grep "plugin:dev-factory:$srv")"
  if printf '%s' "$line" | grep -q 'Connected'; then ok "plugin MCP $srv connected"
  else warn "plugin MCP $srv not connected (debugger cannot read telemetry; in claude run /mcp and authenticate plugin:dev-factory:$srv)"; fi
done
node "$DIR/scripts/config.mjs" validate >/dev/null 2>&1 && ok "config.json valid" || bad "config.json invalid (node dev-factory/scripts/config.mjs validate)"
bash "$DIR/scripts/lint-vocabulary.sh" >/dev/null && ok "vocabulary lint" || bad "vocabulary lint"
exit $fail
