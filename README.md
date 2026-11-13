# dev-factory

A Claude Code plugin that takes a task, builds it test-first in an isolated git worktree, records QA evidence, has it reviewed by fresh-context agents, and opens a **draft pull request**. Then it takes the next one. A person reviews and merges every PR unless you switch on auto-merge, which lets the scheduler merge the small or labelled ones (`scripts/automerge.mjs`, off by default); a builder never merges.

**plan → build → QA → review → draft PR → repeat**

Tasks can live in local markdown files, GitHub Issues, Notion or Jira. Every MCP server is optional.

## You need

-   [Claude Code](https://claude.com/claude-code)
-   `git` and a GitHub remote
-   GitHub CLI, signed in (`gh auth login`)
-   Node 20 or newer
-   Docker, only if your tests need a container

## Get running

Run these from the root of the repository you want the factory to work on.

**1. Install the plugin once per machine.**

```bash
claude plugin marketplace add Nightwolf001/agentic-dev-factory
claude plugin install dev-factory@dev-factory --scope user
```

Then start `claude` in your repository. If it was already running, type `/reload-plugins`.

**2. Set up the repository.** The guided setup asks where tasks live and which optional tools you want. Every question has an answer that needs no account.

```text
/dev-factory:setup
```

**3. Plan some work.** Claude asks questions, drafts tasks with acceptance criteria, and creates nothing until you approve.

```text
/dev-factory:plan "add CSV export to the reports page"
```

**4. Build one task and watch.** You get a branch, a test written first, a QA walk, two reviews and a draft PR.

```text
/dev-factory:build TASK-1
```

**5. Review the PR like any other.** Request changes and the next pass fixes them on the same branch. Merge when you are happy, or turn on auto-merge for the small ones ([Auto-merge](docs/reference.md#auto-merge)).

**6. Let it run on its own** once you trust it. On a Mac:

```bash
dev-factory install --apply --load
```

For GitHub Actions or a Claude routine, see [Unattended passes](docs/reference.md#set-up-for-unattended-passes).

Just a small change and no task? `/dev-factory:quick "make the banner text match the design"`.

## Everyday commands

| You want to                    | Do                                                          |
| ------------------------------ | ----------------------------------------------------------- |
| See what is going on           | `/dev-factory:status`                                       |
| Check the machine and settings | `/dev-factory:doctor`                                       |
| Make a small change, no task   | `/dev-factory:quick "<change>"`                             |
| Fix review feedback on a PR    | `/dev-factory:quick --pr 1234`                              |
| Change a setting               | `/dev-factory:settings`                                     |
| Pause or resume the schedule   | `dev-factory scheduler off` / `on`                          |
| Unblock a parked task          | Answer the factory's comment, then remove `factory-blocked` |

`dev-factory` is on the PATH inside Claude's shell. To use it from your own terminal, run `/dev-factory:setup` once and add `~/.dev-factory/bin` to your PATH.

## A good task

The description is the contract. `/dev-factory:plan` writes it for you; by hand it needs a **Summary** and checkable **Acceptance criteria**. Without criteria the factory parks the task rather than guess.

## Where things live

| Where            | What                                                       |
| ---------------- | ---------------------------------------------------------- |
| `.devfactory/`   | This project's settings. Git-ignored.                      |
| `.factory/`      | Local tasks, if you use the `local` source. Committed.     |
| `~/.dev-factory` | Your settings for all projects, and secrets. Never in git. |

## Something wrong?

Run `dev-factory doctor`: it checks everything and prints the fix for each failure.

## More

-   [Full reference](docs/reference.md): every setting, task sources, environments, QA, cloud and scheduling, troubleshooting.
-   [CONTRIBUTING.md](CONTRIBUTING.md): changing the factory itself.
