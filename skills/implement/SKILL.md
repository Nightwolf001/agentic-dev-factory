---
name: implement
description: Build one ticket test-first inside the devcontainer with a bounded fix budget. Use after the environment is verified and before QA.
---

# Implement

1. Read the ticket, its acceptance criteria, and, when present, `docs/plans/<KEY>/research.md` and the debugger's records in `.dev-factory/debug/*.json` (root cause, evidence, fix plan and validation plan of a bug ticket; start from them). Also read `CLAUDE.md`, every `.cursor/rules/*.mdc` whose paths match the files you expect to touch, and the `AGENTS.md` files from each touched directory up to the root (their `## Learned rules` sections are standing rules). The prompt may list a few recent learnings that match this ticket's paths; treat them as hints, not requirements.
2. Find the seam: the smallest place where each acceptance criterion can be observed. Write the failing test first, run it inside the container and confirm it fails for the expected reason.
3. Make the smallest change that turns it green. Do not refactor beside it and do not add behaviour the ticket did not ask for.
4. Run the affected suites inside the container (`docker compose -f <composeFile> -p <project> exec -T -u node devcontainer ...`, values from `.dev-factory/env.json`), never on the macOS host.
5. Fix budget: three attempts per failing test. A fourth is not allowed. After the third failed attempt write `.dev-factory/blocked.json` with `{"reason": "<test, attempts, last error>", "decision": "what a person must decide"}`. For a bug ticket, write `.dev-factory/needs_debug.json` with `{"test": "...", "attempts": 3, "lastError": "..."}` instead and stop: the scheduler hands the stuck state to a fresh debugger and calls you again with its new hypothesis.
6. Commit after each green step with a message ending in the ticket key in square brackets. No agent attribution trailer.
7. Never edit anything under `dev-factory/` (except your own `qa/cases/<KEY>/`), `.claude/`, `.github/`, or another ticket's cases. A hook refuses it.
8. Method skills: follow `superpowers:test-driven-development` for step 2, `superpowers:systematic-debugging` for the fix loop and `superpowers:verification-before-completion` before you claim anything is done. Look up library and framework behaviour with the `context7` tools before coding against it, and record the source in the PR body.
9. UI work (a new or reshaped screen or component): search the `21st` MCP for a matching component first, then adapt it to the repository's own design system and brand rules (`.cursor/rules/olarm-brand-ux.mdc`, `.cursor/rules/vue-web-standards.mdc`, `.cursor/rules/cc-up-programming-parity.mdc` for the web portals). Never paste an unadapted result. If `frontend-design` is enabled, use it for layout and typography choices. For a hard design or architecture decision, use `sequential-thinking` and write the decision and reason in the PR body.
