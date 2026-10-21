#!/usr/bin/env bash
# MCP stdio server for Playwright, on the host. The server starts with the session, before any
# ticket environment exists, so it cannot attach to one. Web QA therefore needs the stack's
# canonical ports (e2e-env.sh up --ports canonical), which the host reaches as login.olarm.local;
# the environment records that address as webBaseUrl in .dev-factory/env.json.
# The devcontainer image has no browser, so there is no in-container mode.
set -euo pipefail
VERSION="${DF_PLAYWRIGHT_MCP_VERSION:-0.0.82}"
exec npx -y "@playwright/mcp@${VERSION}" --isolated --ignore-https-errors
