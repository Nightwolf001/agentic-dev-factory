#!/usr/bin/env bash
# Walks a person through the steps only they can do: telemetry login, Jira labels, unattended login.
# Usage: bash dev-factory/scripts/doctor.sh --wizard
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"; ENVF="$DIR/.env.local"
[ -f "$ENVF" ] || { cp "$DIR/.env.example" "$ENVF"; chmod 600 "$ENVF"; echo "created $ENVF"; }
echo "dev-factory setup wizard"
echo; echo "1. Sentry and Axiom: start 'claude', run /mcp and authenticate plugin:dev-factory:sentry and plugin:dev-factory:axiom (OAuth; they are separate from your claude.ai connections, and read access is enforced by mcp-guard)."
echo "2. Check both show as connected: claude mcp list | grep plugin:dev-factory"
echo; echo "3. Ask a Jira admin to allow the labels: factory-blocked, factory-validated, factory-regression, needs-research, dev-factory-improvement."
echo "4. Unattended login: run 'claude setup-token' and put the result in CLAUDE_CODE_OAUTH_TOKEN in $ENVF."
echo "5. Fill environments in dev-factory/config.json (Sentry org and projects, Axiom datasets per environment)."
echo; echo "Then run: bash dev-factory/scripts/doctor.sh"
