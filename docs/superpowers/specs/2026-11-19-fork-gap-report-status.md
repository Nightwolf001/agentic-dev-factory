# Status of the 47 items in the fork gap report

As of 2026-11-19. The report (18 Nov 2026) compared a downstream fork with this factory at v0.19.0 and assessed 47 items, named E1 to E12, Q1 to Q7, C1 to C4, M1 to M6, S1 to S3, T1, G1 to G4, F1, F2, F4, F5, F6, F8, F9, F10, D1 and D2. This table is the only per-item record: before it, the items beyond the first slice existed only as a paragraph in `2026-11-19-slice-0-safety-fixes-design.md`, and nothing was filed in any tracker. Statuses: **built** (a pull request is open), **designed** (an approved design says what is built, in which order, and nothing is built yet), **named** (listed in the design as later work, with no design or plan), **declined** (decided not to port), **no action**, **not planned** (not in any design yet).

## Built: 7 items, in three draft pull requests

| Item | What | Pull request |
| --- | --- | --- |
| E9 | Tests never reach the machine's docker; owner labels and an owner-aware sweep | #32 |
| S1 | A settings file that is not a JSON object is refused | #33 |
| G3 (part) | `gh api -XPOST` and `-iXPOST` are writes; engine-control commands refused (added for OrbStack) | #33 |
| F4 | The stop gate releases an agent whose role is no longer the run's | #33 |
| F1 | `improve --dry-run` is a dry run; unknown pass arguments are refused | #34 |
| F2 | `learnings-scan` buffer and watermark | #34 |
| C2 | `compose --format html` for MCP servers that take HTML (unverified against the connector) | #34 |

## Designed, not built: 15 items

In the mobile track of the slice 0 design (mobile M1 to M4, for an Expo React Native app on iOS and Android against a local compose stack) and the concurrent-environments design.

| Item | What | Where |
| --- | --- | --- |
| E5 | Sign a local mobile run in as `mobile.account` | mobile M1 |
| E6 | Sign in through the Maestro MCP, not the CLI | mobile M1 |
| E7 | Boot the Android emulator on the host GPU | mobile M1 |
| E1 | `up` waits for the process check and the health checks | mobile M2 |
| E2 | Exit 100 means stop waiting | mobile M2 |
| E3 | Say why an environment step failed | mobile M2 |
| E8 | `{environment}` and `{apiBaseUrl}` placeholders; exit 78 for a failed native build | mobile M2 |
| E12 (part) | A time limit on the ping | mobile M2 |
| Q1 | QA accounts and devices per environment | local account in mobile M1; the rest in mobile M3, waiting for a project with a deployed backend |
| E4 | A QA device's own start command | mobile M3 (same wait) |
| Q2 | QA retries counted per pass | mobile M4 |
| Q6 (part) | Evidence names that include the run and case | mobile M4 |
| Q7 (part) | Per-capture assertion, `probe --expect-contains`, the account password in the scrub | mobile M4 |
| Q3 | Remote-QA unit tests in the project's container | mobile M4, waiting for a deployed backend |
| F10 | Resolve the active run per worktree (needs a person: `run-context.mjs` is an enforcement file) | prerequisite of concurrent environments; being investigated |

## Named as later work, no design: 18 items

Listed in the slice 0 design by theme, in the report's order: `qa.mjs bench` (Q4); the QA summary comment and report with a pluggable destination (Q5); typed and threaded comments, links and renderers, decision propagation (C1, C3, C4); MCP sync fidelity (M1 to M6 of the report's MCP section: record the config each add wrote, reconcile ownership, Jira in every pass with a token, `mcp migrate` literal values and warnings, smaller items); frontier, stacked-PR and guard hardening (G1, G2, G4, and the rest of G3: the strict GraphQL exception, the `stack.mjs` refusal, `GH_HOST`/`GH_TOKEN`); run plumbing (F5, F6, F9); the docs split (D1).

## Declined, no action, not planned: 8 items (E12 is split: its ping limit is designed above, the rest is here)

| Item | Status | Why |
| --- | --- | --- |
| T1 | Declined | Every role reading Sentry and Axiom widens tool scopes the factory keeps narrow; `telemetry.allowedRoles` already lets a person opt in per role |
| E10 | No action | The report found it already present |
| E11 | Not planned | Example repository profiles |
| E12 (rest) | Not planned | `environment.hosts`, and the doctor showing the first line of `gh auth`'s error |
| S2, S3 | Not planned | An end-to-end test of guided setup, and `import-env` tests |
| F8 | Not planned | Config tests reading the shipped defaults |
| D2 | Not planned | The report's list of test invariants (some are pinned incidentally by the new tests) |

## Not from the report, but open

-   The scheduler's strict GraphQL exception in the guard (described in #33): security-relevant, next guard pull request.
-   Items 4 to 8 of the research brief (verified test runs, a test-weakening scan, a criteria ledger, a wall-clock cap, recording the human outcome); items 1 to 3 shipped in #31.
-   Follow-ups listed in the bodies of #32, #33 and #34.
