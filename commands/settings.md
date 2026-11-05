---
description: Open the dev-factory settings - servers, plugins, secrets and every option, with each value and where it comes from
---

Where Claude Code loads the plugin's hooks module, this command opens the settings pane instead of running these steps (the same pane as `/dev-factory-settings`). Here it did not, so show the settings in the conversation and change them on request.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" list` and show its output as one compact table per group, keeping each row's value and source.
2. Tell the person they can change a setting by asking, and that `dev-factory settings` in a terminal opens the full keyboard page.
3. To change a setting, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" set <id> <value> [--user|--project]` (`--user` for all projects, `--project` for this one; servers and plugins take `on`, `off`, `user`, `project` or `default`). Show its output. A value already in effect exits 0 and changes nothing; a refused change exits 1 with the reason.
4. Never ask for a secret's value in the conversation: tell the person to run `! pbpaste | dev-factory settings set secret:<NAME>` themselves.
