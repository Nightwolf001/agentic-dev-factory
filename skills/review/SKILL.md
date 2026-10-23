---
name: review
description: The two-step review protocol for a ticket's commit, spec first then standards, with the finding format and severity scale. Used by factory-reviewer, and by the builder when fixing findings.
---

# Review

Two steps, two fresh reviewers, in this order. Step 2 cannot be recorded until step 1 is clean at the same commit; `qa.mjs` refuses it.

| Step | Axis        | Question                                                             | Blocks on                 |
| ---- | ----------- | -------------------------------------------------------------------- | ------------------------- |
| 1    | `spec`      | Does the commit do what the ticket asks, and nothing it did not ask? | Critical or High findings |
| 2    | `standards` | Is it built the way this repository requires, and safe to run?       | Critical or High findings |

Specialist steps run after step 2 only when the diff touches matching paths (`review.specialistAxes` in `config.json`; `qa.mjs review status` lists the triggered ones in `triggered`). They use the same finding format and block on Critical or High, and `verify --require-review` needs every triggered step clean:

| Axis       | Triggered by                                                   | Checklist                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`     | Prisma schema, migrations                                      | A NOT NULL column added without a default is breaking; a foreign key without an index; N+1 queries and the eager-load fix; raw SQL built by interpolation is Critical; safe to run forward and to roll back, stated for every migration |
| `infra`    | Workflows, Terraform, compose, devcontainers, process managers | Secrets never in the file or logs; pinned versions; health checks and restart behaviour; a change to a production pipeline is flagged for a person, not approved                                                                        |
| `security` | Auth, secret and token code                                    | Authn and authz on every new path; token and secret handling and logging; input validation at the edge; no sensitive value in a test fixture                                                                                            |

Any new commit (a fix, a QA case change) invalidates both records: review starts again from step 1 at the new head. After the configured number of fix rounds (`caps.maxFixRounds`) a ticket that is still not clean is blocked for a person.

## Finding format

`{"severity": "...", "file": "path/from/repo/root", "line": 42, "note": "what is wrong and what would fix it"}`. File and line are mandatory, so every finding can be checked. The counts are computed from the findings by `qa.mjs`; they cannot be reported separately.

## Severity

-   Critical: data loss, security hole, broken build or migration.
-   High: an acceptance criterion not met, a defect users will hit, a mandatory repository rule violated, a test that does not test what it claims.
-   Medium: maintainability, naming, missing edge-case test that is not an acceptance criterion.
-   Low: style and nits the formatter does not catch.

Medium and Low findings do not block; they are listed in the PR body for the human reviewer.

## Learnings (standards step)

Learnings are written at ship, so the reviewer does not run the check; `qa.mjs learnings check` runs there. The standards reviewer flags as a High finding any learnings file committed into the repository (`docs/plans/*/learnings.md` or similar): learnings live in the PR body, short and scoped. It also checks the diff and tests for real identifiers: fixtures use invented emails, phone numbers, tokens and device serials.

## For the builder fixing findings

Fix every Critical and High finding, commit, then run QA again from `start` (a new commit invalidates the old run). Do not argue a finding away in a comment: if one is wrong, say so in the commit message with the evidence and let the next round decide. Never edit anything under `.dev-factory/review/`.

## What this review is and is not

The reviewers are separate sessions with their own context and a read-only shell, run by the scheduler, but they are the same model family as the builder. It catches what the builder's own context hid; it does not replace the human review of the PR.
