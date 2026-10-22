---
name: telemetry
description: How to research Sentry and Axiom per environment, what to query, and what never to copy out. Use before reading any telemetry.
---

# Telemetry

1. Pick the environment: the ticket's `env:<name>` label wins, else the Sentry issue's environment tag, else the first non-`dev` name in `environments`. Look up its Sentry org and projects and Axiom datasets under `environments` in the config. `dev` has no remote source: use the ticket stack's own logs (`docker compose ... logs --no-color --tail 200` or the process manager's non-streaming log command). Telemetry is optional: if neither Sentry nor Axiom is enabled, work from the task text, the logs of a reproduction, and say so in the record.
2. Research that environment first. A cross-environment comparison (prod against staging error rate, for example) is allowed, read-only, and recorded as evidence.
3. Query small: a time window of at most `telemetry.maxWindowDays`, at most `telemetry.maxRows` rows, only datasets in the allowlist. The `mcp-guard` hook refuses the rest.
4. Confirm the problem is real before any fix starts: Sentry issue id with first seen, last seen, event count and user count, or the Axiom query and its count.
5. Never write raw telemetry anywhere persistent: not a file, a PR body, a task comment or a learning. Keep ids, queries and aggregate counts. Run `node dev-factory/bin/qa.mjs scrub --file F` on any text that will leave the session; it must pass.
6. Tests and fixtures use invented identifiers, never a real email, phone number, token or device serial seen in production.
