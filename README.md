# dev-factory

A Claude Code plugin that plans, builds, verifies and ships work: it takes a task, builds it in an isolated git worktree, records QA evidence, has it reviewed in two steps by fresh-context agents, and opens a **draft pull request** for a person to review. Then it takes the next one.

The loop is the same whatever the size of the work, and whatever you track it in:

**plan → implement → evidence → review → ship → repeat**

It is kept in your repository. There is no database and no service: the task source holds task state, GitHub holds pull requests, git holds the code, and `.dev-factory/` inside each worktree holds run state. A person approves and merges every PR; the factory never does.

## Quick start (no account needed)

```text
claude --plugin-dir ./dev-factory        # from the repository root
/dev-factory:setup                       # picks a task source and optional MCP servers, writes dev-factory.config.json
/dev-factory:plan "add CSV export to the reports page"
/dev-factory:build TASK-1                # watch it build one task in your session
```

Or skip the tracker entirely for a small change:

```text
/dev-factory:quick "make the arm banner text match the design"
```

`/dev-factory:status` shows the queue, what is in flight, open factory PRs and environments, and is a safe first command.

## Where do tasks live?

`tasks.source` in the config chooses one. Every one maps onto the same five states (`ready`, `inProgress`, `inReview`, `reviewed`, `done`), so commands, agents and the scheduler behave the same.

| Source   | You need                                       | MCP server  | Good for                                                              |
| -------- | ---------------------------------------------- | ----------- | --------------------------------------------------------------------- |
| `local`  | nothing                                        | none        | Solo work, trying the factory, a plan that lives in the repository    |
| `github` | `gh auth login`                                | none        | Teams on GitHub: issues, labels, PRs in one place (recommended there) |
| `notion` | a Notion integration token for unattended runs | `notion`    | Teams that plan in Notion                                             |
| `jira`   | a Jira API token for unattended runs           | `atlassian` | Teams on Jira workflows                                               |

Details, status mappings and the exact operations are in [`skills/task-source/`](skills/task-source/SKILL.md). No tracker at all? `/dev-factory:quick` needs none.

-   **local**: markdown files under `.factory/tasks/` (`sources.local.dir`), one per task, with a small frontmatter block. Commit them to share a plan.
-   **github**: an issue with the `dev-factory` label is a task. State is a label (`df:in-progress`, `df:in-review`, `df:reviewed`), closed means done. Keys are `GH-<number>`. `node dev-factory/scripts/tasks.mjs init` creates the labels.
-   **notion**: a database with Name, Status, Tags, Type and a unique-ID property. The Status values and property names are configurable.
-   **jira**: your workflow's status names go in `sources.jira.states`; transitions are chosen by target status, never by name.

Dependencies are a `Blocked by: KEY, KEY` line in the description in every source (Jira and Notion also read native links), so a plan keeps its order everywhere.

### Plans of any size

`/dev-factory:plan` sizes the work first and tells you which it chose:

| Size         | Shape                                    | Output                                      |
| ------------ | ---------------------------------------- | ------------------------------------------- |
| Quick change | one small edit                           | no task: use `/dev-factory:quick`           |
| Single task  | one demoable slice                       | one task                                    |
| Feature      | several slices that depend on each other | a tracking task plus ordered slices         |
| Initiative   | several features or phases               | phase tasks; only the first phase is sliced |

Each task carries Summary, Acceptance criteria, Out of scope, Testing decisions and `Blocked by:`, checked by `qa.mjs ticket lint` before anything is created. The tracking task for a feature never gets the factory label, so the factory builds the slices, not the whole.

## Everything is optional

The plugin registers **no MCP server**. `mcp/catalog.json` lists each one with what it is for and what you lose without it; a repository turns on the ones it wants.

```bash
node dev-factory/scripts/mcp.mjs list            # what exists, what is on
node dev-factory/scripts/mcp.mjs recommend       # suggestions for your task source
node dev-factory/scripts/mcp.mjs enable playwright context7
node dev-factory/scripts/mcp.mjs connect         # enable the recommended set, then show what still needs a login
node dev-factory/scripts/mcp.mjs connect --all   # every server in the catalog
```

Servers are written to the repository's own `.mcp.json` (merged, never overwriting yours). The scheduled pass builds its sandbox and permission settings from what is enabled, so a server that is off opens no network access.

| Server                | What it adds                                  | Without it                                                           |
| --------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| `playwright`          | browser walks and screenshots for web QA      | a change that touches web UI is blocked for a person to check        |
| `maestro`             | mobile flows on a simulator                   | a change that touches the mobile app is blocked for a person         |
| `context7`            | current library docs                          | agents use the repository docs and `WebFetch`                        |
| `21st`                | UI component inspiration                      | UI work follows the repository's own components                      |
| `sequential-thinking` | structured reasoning                          | agents reason in their own context                                   |
| `notion`, `atlassian` | read and write Notion or Jira tasks           | choose another `tasks.source`                                        |
| `sentry`, `axiom`     | read-only telemetry for bug triage/validation | triage works from the task and a reproduction; validation is skipped |

OAuth servers need one login that no script can do for you: start `claude` and run `/mcp`. `connect` tells you which servers are waiting for it. `doctor.sh` reports which enabled servers are connected.

## How a task flows

1. A task is `ready`: labelled for the factory (`tasks.label`, default `dev-factory`), not parked with `factory-blocked`, and with every blocker `done`.
2. `/dev-factory:tick` checks the caps, then claims one by setting it `inProgress`. A source that refuses a stale change means two passes cannot claim the same task.
3. A worktree and branch (`<type>/<KEY>-<slug>`) are created, and `scripts/e2e-env.sh up` starts the environment, if the repository has one.
4. The `factory-builder` agent works test-first, then QA walks each case and records it with `bin/qa.mjs`.
5. Two fresh-context reviewers run in order: **spec** (does it do what the task asks, nothing more) and **standards** (does it follow the repository's rules and is it safe). Critical or High findings send the builder back; QA runs again and review restarts, at most `caps.maxFixRounds` times. Triggered `data`, `infra` and `security` steps follow.
6. The builder ships: pushes the branch, opens the draft PR with the evidence attached. The pass re-verifies the QA manifest and both review records against the PR head, comments on the task, sets it `inReview`, and tears the environment down.
7. You review the PR. A change request (not a plain comment) from someone other than the PR author sends the task back for a fix pass; an approval or merge sets it `reviewed`. After that, QA, release and anything else belong to people.

When the factory cannot continue it labels the task `factory-blocked`, comments the reason and the decision it needs, and returns it to `ready` (the label keeps it out of the queue). Answer in a comment and remove the label. If `caps.breakerThreshold` tasks were blocked within `caps.breakerWindowHours` the pass stops claiming until you look.

![The dev-factory flow: from task to merged PR, what the factory does and where people decide](docs/dev-factory-flow.svg)

## Configuration

Defaults ship in `config.json` and name no organisation, site or project. A repository overrides only what differs in a **`dev-factory.config.json`** at its root (merged key by key; arrays replace). `DF_CONFIG` names a different file, and any `DF_*` variable overrides a scalar on one machine.

```json
{
	"tasks": { "source": "github" },
	"git": { "baseBranch": "main" },
	"pr": { "areaLabels": [{ "path": "services/api", "label": "api" }] },
	"environment": {
		"type": "compose",
		"composeFile": ".devcontainer/docker-compose.yml",
		"service": "app",
		"setup": ["npm ci"],
		"pingUrl": "http://localhost:3000/health"
	}
}
```

`/dev-factory:setup` writes this for you. `node dev-factory/scripts/config.mjs validate` checks it; `get source.states.inProgress` reads from the active source.

| Key                                                         | Meaning                                                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `tasks.source`, `tasks.label`, `tasks.blockedLabel`         | The tracker, the label that marks a task as the factory's, the label that parks one                                         |
| `tasks.bugTypes`, `tasks.placeholderKey`                    | Task types that count as bugs; the key used for `/dev-factory:quick` branches and PR titles (set it to one your CI accepts) |
| `sources.<name>.*`                                          | Per-tracker settings and the mapping from `ready`, `inProgress`, `inReview`, `reviewed`, `done` to its own status names     |
| `git.baseBranch`, `git.branchTypes`                         | Branch to build on (`null` = the repository's default branch); task type to branch prefix, matched case-insensitively       |
| `pr.sizeLabels`, `pr.areaLabels`, `pr.categoryByBranchType` | PR labels. Area labels are path prefix to label, none by default                                                            |
| `environment.*`                                             | `type` `none` (tests run on the host, the default) or `compose`; see [Environments](#environments)                          |
| `mobile.*`                                                  | `appDir` enables the device lane; `install`, `pods`, `start`, `build`, `nativeInputs` are the commands it runs              |
| `caps.*`, `models.*`                                        | Concurrency, open PRs, budget, stall and resume limits; model and effort per role                                           |
| `environments.<name>`                                       | Optional: Sentry org/projects and Axiom datasets the debugger may read in that environment                                  |
| `telemetry.*`, `debug.*`, `validation.*`                    | Result caps and scrub patterns; debug budget; wait before post-merge validation                                             |
| `improvement.*`                                             | Label, optional project, and per-scan caps for the self-improvement scan                                                    |
| `review.specialistAxes`                                     | Globs that trigger the extra `data`, `infra` and `security` review steps                                                    |
| `sandbox.extraDomains`                                      | Extra hosts the scheduled pass may reach                                                                                    |

QA surface rules (which paths need a browser or device walk) are in `qa/profiles.yaml`; a repository replaces them with its own `dev-factory.qa.yaml` of the same shape.

## Starting a session

The `/dev-factory:...` commands exist only in a session that has the plugin loaded.

| Situation                                             | Do this                                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Plugin enabled on this machine (`install.sh --apply`) | Run `claude` from the repository root.                                                                         |
| One session only                                      | `claude --plugin-dir ./dev-factory`. The flag works only when Claude starts.                                   |
| Already inside a running session                      | `! bash dev-factory/scripts/install.sh --apply`, then `/reload-plugins` (or `/exit` and start `claude` again). |

`install.sh --apply` writes the plugin into `.claude/settings.local.json`, which is not committed: it applies to this machine only and records the absolute path of your checkout. Start `claude` from the repository root of the main checkout, not from a worktree.

## Set up for unattended passes

Only needed for the scheduler. Everything else uses your normal login.

1. `bash dev-factory/scripts/doctor.sh`: checks the machine and the config and says how to fix each failure. `doctor.sh --wizard` walks the manual steps.
2. `bash dev-factory/scripts/install.sh` shows what it would do; `--apply` creates `dev-factory/.env.local`, enables the plugin for this checkout and installs the plugins in `plugins.json`; `--load` also loads the launchd jobs (`tick` every 15 minutes, `improve` weekly).
3. **Unattended login**: in a normal terminal tab run `claude setup-token` and put the value in `dev-factory/.env.local` as `CLAUDE_CODE_OAUTH_TOKEN` (the file is gitignored, mode 600, read by `tick.sh` at run time, and the shell guard stops agents reading env files). Never paste the token into a chat or a task.
4. **Task source tokens**, only for `jira` (`JIRA_EMAIL`, `JIRA_API_TOKEN`) and `notion` (`NOTION_TOKEN`). They let the scheduler's preflight check for work without starting a paid session. `local` and `github` need none.

```bash
bash dev-factory/scripts/tick.sh                                # one unattended pass by hand
launchctl bootout gui/$(id -u)/com.dev-factory.tick             # stop the scheduler
```

A pass builds one task at a time by default, keeps at most `caps.maxOpenPrs` factory PRs open, and stops a session at `caps.maxBudgetUsd`.

## Using the factory

| You want to                       | Do                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Set it up                         | `/dev-factory:setup`                                                                                      |
| Plan work of any size             | `/dev-factory:plan "<idea>"`                                                                              |
| Build one task, watching          | `/dev-factory:build TASK-12 [--base <branch>]`                                                            |
| Make a small change, no task      | `/dev-factory:quick "<change>"`                                                                           |
| Fix review feedback on an open PR | `/dev-factory:quick --pr 1234 ["<extra instruction>"]`                                                    |
| See what is going on              | `/dev-factory:status`                                                                                     |
| Check the machine and config      | `/dev-factory:doctor`                                                                                     |
| Check a fix after the merge       | `/dev-factory:validate TASK-12` (needs a telemetry MCP server)                                            |
| Run one scheduled pass            | `bash dev-factory/scripts/tick.sh` or `/dev-factory:tick`                                                 |
| Ask for changes                   | Submit a **Request changes** review on the PR, or comment `/dev-factory fix <what to change>` on the task |
| Unblock                           | Answer the factory's comment, then remove the `factory-blocked` label                                     |
| Keep a task out of the queue      | Remove `tasks.label` or add `factory-blocked`                                                             |

### Choosing the base branch

Every run builds on a branch and opens its PR into it. The base is the first of: `--base <branch>`, a `Base branch: <branch>` line in the task, `git.baseBranch`, the repository's default branch. The worktree is cut from `origin/<base>`. A base must be on `origin` and your local copy must not be ahead of it, because the factory never pushes a base branch. When a base cannot be used it says why and stops (a scheduled pass blocks the task).

### `/dev-factory:quick`

Runs the whole flow (worktree, environment, test-first build, QA walk, two reviews) for work with no task. A description starts a new change on `<type>/<tasks.placeholderKey>-<slug>`; `--pr <number>` fixes the open review threads and change requests of an existing PR and pushes to its branch (it asks first when the PR is someone else's). It never posts, resolves threads, marks ready or merges; at the end it offers one summary comment, scrubbed first. A change too big for one slice is sent to `/dev-factory:plan`.

## Preparation, debugging and the preflight

-   At claim the pass runs `qa.mjs ticket lint` on the description. A task with no acceptance criteria is blocked with `needs acceptance criteria` instead of being built on guesses.
-   A task labelled `needs-research`, or with a `Research:` block, first goes to `factory-researcher` (read-only, at most 3 hops), which writes `docs/plans/<KEY>/research.md`.
-   A bug, or a task linking a Sentry issue or a log query, first goes to `factory-debugger` (triage): it reproduces, finds the root cause and records it with `qa.mjs debug`. The builder starts from that record, and the stop gate refuses `build.done` on a bug without one. When the builder exhausts its fix budget the debugger runs again (unstick) with fresh context; a repeated fingerprint or a spent budget blocks the task. Telemetry is used when its MCP server is enabled and is read-only (see [Telemetry](#telemetry-read-only)).
-   A session killed mid-build leaves a task `inProgress`. The pass resumes any labelled task quiet for `caps.stallMinutes`, at most `caps.maxResumes` times, then blocks it.
-   `tick.sh` first runs `scripts/frontier.mjs check`, which asks the task source from a script whether a paid session has anything to do: a claimable task, an orphaned one, or an `inReview` PR that is approved, merged or has a fresh change request. Exit 20 logs "nothing to do". A missing token or a tracker or `gh` failure logs why and starts nothing. `DF_PREFLIGHT=off` skips the check. An unchanged frontier is not dispatched again for `caps.frontierRepeatHours`.

## Environments

`environment.type` decides what `scripts/e2e-env.sh` does:

-   **`none`** (default): there is no environment to start. Tests run on the host with the repository's own commands; `up` only records that.
-   **`compose`**: an isolated docker compose project named `df-<key>`. It builds and starts `environment.composeFile`, runs each `environment.setup` command inside `environment.service` (as `environment.user` if set), populates `environment.submodules` from your main checkout, and then `verify` checks that services are healthy, `environment.processCheck` exits 0 and `environment.pingUrl` answers from inside the service.

| Command                                                  | What it does                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `e2e-env.sh up --key KEY [--ports canonical] [--device]` | Start and verify. Exit 75 means a cap or the ports lock refused it; a later pass retries.                        |
| `e2e-env.sh verify`                                      | Re-check the contract.                                                                                           |
| `e2e-env.sh down`                                        | Remove the project and its volumes.                                                                              |
| `e2e-env.sh sweep`                                       | Remove `df-*` projects with no live owner, except one whose worktree changed in the last 3 hours. Safe any time. |

Isolated mode (`--ports none`) publishes no host ports so several worktrees can coexist, but a host browser cannot reach it; web QA needs `--ports canonical`, which the pass uses whenever `caps.maxConcurrent` is 1 and which takes a machine-wide lock (`environment.webBaseUrl` is recorded in `env.json`). `--device` implies canonical ports and, when `mobile.appDir` is set, boots a simulator and starts the app's dev server (`scripts/mobile-env.sh`). Run state lives in `.dev-factory/` inside each worktree (gitignored); machine state in `~/.dev-factory/`.

## QA evidence

`node dev-factory/bin/qa.mjs` is the only thing that can mark a case as passed.

| Command                                                                             | Purpose                                                    |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `start --key KEY --profile web\|mobile`                                             | Bind a run to the current commit; refuses a dirty tree     |
| `record --run N --case SLUG --status pass\|fail --assertion TEXT --screenshot FILE` | Record one walked case                                     |
| `done --run N`                                                                      | Close the run and compute the verdict                      |
| `mark-na --key KEY --profile P --reason TEXT`                                       | Declare no UI surface changed, verified against the diff   |
| `review record --axis spec\|standards --head SHA --summary TEXT --findings JSON`    | Record one review step; step 2 needs a clean step 1        |
| `review status [--head SHA]`                                                        | Show the steps and whether the commit is clean             |
| `verify --head SHA --run N [--require-review true]` (or `--key KEY`)                | Confirm a passing result for exactly this commit           |
| `ticket lint\|base\|blocked-by --file F`                                            | Check a task description, read its base branch or blockers |

Cases live under `qa/cases/<KEY>/` (`.spec.ts` for Playwright, `.yaml` for Maestro). Which paths count as UI is `uiGlobs` in the QA profiles; `nonUiGlobs` carves documentation and tests out, so a diff that only touches Markdown is "no UI surface" and `mark-na` accepts it, while a code file beside it needs a walk. A pass needs a fresh screenshot of this run at this commit with an assertion that describes this walk.

## Rules and their reasons

-   The debugger and researcher cannot edit code; the improver cannot edit what enforces the factory's own limits.
-   The builder has no task-tracker or GitHub write tools. The scheduled pass is the only holder of them, so a task cannot approve itself.
-   Only the task's own branch may be pushed, never forced. The shell guard reads git past global options, wrappers and `sh -c` or `$(...)` payloads, and treats `gh api` with a body field as a write.
-   When the environment is a container, dependencies are installed and tests run inside it, never on the host.
-   Inside a run, the factory's own files (`dev-factory/`, `.claude/`, `.github/`), run state, and QA and review records cannot be edited by a task, by tool or by shell. Review records can only be written by `qa.mjs review record`, which refuses anyone whose `run.json` role is not that axis's reviewer; debug rounds likewise need the debugger role.
-   Edits under `dev-factory/` are always checked against the vocabulary lint.
-   Nothing is retried on its own after a block. A person decides.

## Telemetry (read-only)

Sentry and Axiom are optional and reachable only by the debugger role. Rules are enforced by `scripts/mcp-guard.mjs` (PreToolUse), not by instruction: tools whose name is a write verb are denied, an Axiom query naming a dataset outside `environments.*.axiomDatasets` is denied, and `limit`, `take` and time windows above `telemetry.maxRows` and `telemetry.maxWindowDays` are denied. The guard matches the server whether the plugin or your `.mcp.json` started it. Nothing raw is written to files, PR bodies or task comments: `qa.mjs scrub --file F` fails on emails, phone numbers, JWTs, bearer tokens, long hex identifiers and `telemetry.scrubPatterns`.

## Self-improvement

-   Every pass appends a record to `~/.dev-factory/runs/runs.jsonl` and a counts-only comment on the task.
-   Learnings live in the PR body, never as repository files: at most 3 per task, each with a `scope:` path, mandatory after a debug round or a Critical or High finding (`qa.mjs learnings check`). Before a build the pass gives the builder up to five recent learnings that match the task's paths.
-   Promotion: a learning that recurred on two tasks, or that you confirm with `/dev-factory promote` on its PR, becomes one rule line in the `## Learned rules` section of the closest `AGENTS.md` through a draft PR. `CLAUDE.md` and editor rule files stay human-edited.
-   `/dev-factory:improve` (weekly through `improve.sh`, or by hand) clusters recurring causes, files at most `improvement.maxTicketsPerScan` improvement tasks, and opens at most `improvement.maxPrsPerScan` draft PRs for findings confined to `dev-factory/`. `IMPROVEMENT-PLAN.md` is the prioritised list. Nothing is merged without you.

## Layout

| Path                           | Purpose                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `commands/`                    | `setup`, `plan`, `build`, `quick`, `tick`, `status`, `validate`, `improve`, `doctor`                  |
| `agents/`                      | `factory-builder`, `-reviewer`, `-debugger`, `-researcher`, `-improver`, `-promoter`                  |
| `skills/`                      | `task-source`, `implement`, `qa`, `review`, `ship`, `environment`, `diagnose`, `telemetry`, `improve` |
| `scripts/sources/`             | One file per task source (`local`, `github`, `jira`, `notion`) and their shared model                 |
| `scripts/tasks.mjs`            | List, read, create and move tasks for the sources a script can drive                                  |
| `scripts/mcp.mjs`, `mcp/`      | The optional MCP catalog and the commands that enable it                                              |
| `scripts/factory-settings.mjs` | Builds the scheduled pass's sandbox and permissions from what is enabled                              |
| `hooks/hooks.json`             | Shell guard, edit guard, telemetry guard and stop gate; active only inside a factory run              |
| `plugins.json`                 | Plugins the factory relies on and the one it disables                                                 |
| `scripts/`                     | `e2e-env.sh`, `mobile-env.sh`, `tick.sh`, `install.sh`, `doctor.sh`, hook scripts                     |
| `bin/qa.mjs`                   | QA, review, debug, scrub, ticket and learnings CLI                                                    |
| `qa/profiles.yaml`             | Default web and mobile QA profiles                                                                    |
| `config.json`                  | Defaults; the repository's `dev-factory.config.json` merges over them                                 |
| `settings.factory.json`        | Base sandbox and permission settings for scheduled runs                                               |
| `launchd/`                     | Scheduler templates rendered by `install.sh`                                                          |
| `test/`                        | `node --test dev-factory/test/*.test.mjs`                                                             |

Adding a tracker: a new file under `scripts/sources/` that answers `list({ states, staleMinutes })` (and the write methods if scripts can drive it), a case in `scripts/sources/index.mjs`, a block under `sources` in `config.json` with its `states`, and `skills/task-source/<name>.md`. Adding an MCP server: an entry in `mcp/catalog.json`.

## Troubleshooting

| Symptom                                             | What to do                                                                                                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config: missing sources.jira.site`                 | `tasks.source` is `jira` but the Jira block is not filled in your `dev-factory.config.json`. Run `/dev-factory:setup`.                                                                                                       |
| Pass exits 75 immediately                           | Another pass holds `~/.dev-factory/tick.lock`. If none is running, delete the directory.                                                                                                                                     |
| `environment busy, retrying next pass`              | The device lock or the stack cap is held. `bash dev-factory/scripts/e2e-env.sh sweep` clears stale owners.                                                                                                                   |
| `verify FAILED`                                     | A service or check did not pass. Read the message, then `docker compose -p df-<key> logs`.                                                                                                                                   |
| Port held by another process                        | Something else is running the dev server. Stop it yourself; the factory never kills a process it did not start.                                                                                                              |
| Builder says a tool is not allowed                  | MCP tools are named `mcp__<server>__*` when your `.mcp.json` started them and `mcp__plugin_dev-factory_<server>__*` when the plugin did. Check the `system/init` event of `claude -p --output-format stream-json --verbose`. |
| Jira or Notion tools fail in unattended passes only | The OAuth login did not survive. Set the API token in `.env.local` and use an API-token MCP server in `.mcp.json`.                                                                                                           |
| A UI change is blocked for lack of a browser        | Enable the `playwright` server: `node dev-factory/scripts/mcp.mjs enable playwright`.                                                                                                                                        |
| Guard blocks a command                              | It is working as designed. Read its message; the allowed route is almost always a container exec or a PR comment.                                                                                                            |
| Login expired                                       | Run `claude setup-token` again and update `CLAUDE_CODE_OAUTH_TOKEN`.                                                                                                                                                         |
| `/dev-factory:...` commands are missing             | The session has no plugin loaded. See [Starting a session](#starting-a-session).                                                                                                                                             |
| An OAuth server shows "Needs authentication"        | Run `/mcp` and authenticate it. A connection of the same name in claude.ai does not count.                                                                                                                                   |

## Known limits

-   `qa.mjs` reads its default QA profiles from the plugin (or the repository's `dev-factory.qa.yaml`), so a worktree whose base has no `dev-factory/` folder still works. QA cases you author go under `dev-factory/qa/cases/<KEY>/` in the worktree and are committed with the change. The `.dev-factory/` run state is kept out of git by `worktree.mjs`.
-   The plugin is expected at `dev-factory/` in the repository (commands and hooks refer to it by that path).
-   Web QA needs canonical ports, so only one task builds with a browser walk at a time; concurrent builds have isolated stacks a host browser cannot reach. Dispatch into one worktree at a time.
-   Review is two steps by separate fresh-context sessions with a read-only shell, but the same model family as the builder: a second look, not an independent one.
-   The shell guard reads command strings. It stops mistakes and the ordinary ways round a rule, not an agent that writes and runs its own program. The separation that holds is that the builder has no tracker or GitHub tools, the scheduler holds the credentials, drafts are never merged by the factory, and a person reads the diff before merging.
-   GitHub dependencies are read from `Blocked by:` lines in the issue body, not from GitHub's native issue dependencies.
-   Notion and Jira writes go through their MCP servers, so an unattended pass for those sources needs that server logged in or an API-token alternative.
-   One build per pass by default. Increase `DF_MAX_CONCURRENT` only after checking your plan's usage limits. The Mac must be awake and online for scheduled passes.
-   The scheduler cannot enforce tracker workflow rules (for example a validator on Jira transitions).
