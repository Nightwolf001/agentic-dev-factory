---
description: Check this machine and the dev-factory configuration, and explain every failure
---

Run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.sh"` and `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" validate`. Report each `FAIL` and `warn` line with the exact command that fixes it (the README Set up section has them): missing plugin, missing `.env.local`, stale login, Docker down, `/etc/hosts` entries, simulator runtime. Then check that `~/.dev-factory/.env.local` is not tracked by git and that `~/.dev-factory` has no stale `tick.lock` or `ports.lock` (a lock whose pid is not alive). Do not change anything; print a short checklist.
