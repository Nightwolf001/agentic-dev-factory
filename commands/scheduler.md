---
description: Switch the scheduled passes on or off for this repository, or show their state (usage /dev-factory:scheduler on|off|status [tick|improve|all])
argument-hint: 'on|off|status [tick|improve|all]'
---

Switch the factory's scheduled passes for this repository, then say what changed.

1. Run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/scheduler.sh" $ARGUMENTS` (no argument means `status`). It works the same whatever runs the schedule: launchd on this Mac, a GitHub Actions workflow, or a Claude Code routine.
2. Report its output in two or three lines: which scheduler this is, whether `tick` and `improve` are now running or stopped, and whether the pause switch is set.
3. If it says a routine must be switched in Claude, do that for the person only when they ask: `/schedule` lists, pauses and resumes routines. Never start, stop or delete a scheduler other than the one this repository's `runtime.scheduler` names.
4. `off` is not destructive: it keeps the jobs and the configuration, and `on` restores them. A pass that is already running finishes; the next scheduled one does nothing.
