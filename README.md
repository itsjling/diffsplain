# Diffsplain

Review a Git diff one file at a time, with a short coding agent note beside each
patch.

## Prerequisites

- Node.js 22.13 or newer and Git.
- For agent notes: a signed-in Codex, Claude, Copilot, Cursor, or OpenCode CLI.
  Cursor Agent requires version 2026.08.11 or newer.
- For pull requests: a signed-in GitHub CLI (`gh auth login`).

Check your setup with `npx diffsplain doctor`. See [Agent notes](docs/content/agent-notes.mdx)
for provider access and login details.

## Quick start

Run from a Git checkout:

```sh
npx diffsplain
```

Choose an agent when prompted, or use `--no-agent` for a plain diff. The page
shows staged, unstaged, and untracked changes against `HEAD` and updates as
files change. It starts at port `2299`, using the next free port if needed.
Press Ctrl-C to stop.

Other targets:

```sh
npx diffsplain --pr 198
npx diffsplain owner/repo --branch feature/my-change
npx diffsplain --base BASE_REF
npx diffsplain --base BASE_REF --head HEAD_REF
```

## Full arguments

See the [CLI reference](docs/content/cli.mdx) for details.

| Argument | Use |
| --- | --- |
| `doctor [--json] [--deep]` | Check local review, agent note, and pull request capabilities. |
| `cache [status\|prune --age DAYS\|prune --size BYTES\|clear --yes]` | Inspect or remove inactive saved notes. |
| `config agent [NAME\|--unset]` | Show, set, or unset the default coding agent. |
| `REPO`, `--repo PATH\|URL\|OWNER/REPO` | Select a local or remote repo. |
| `--pr NUMBER\|URL` | Review a GitHub pull request. |
| `--branch NAME` | Compare a remote branch with its default branch. |
| `--worktree` | Review tracked and untracked changes against `HEAD`. |
| `--base REF` | Compare that exact commit with the live working tree. |
| `--base REF --head REF` | Review an exact local range. |
| `--agent NAME`, `--no-agent` | Choose a coding agent, or show a plain diff. |
| `--no-checkout-access` | Limit agent notes and Review chat to the supplied snapshot. |
| `--exclude PATTERN` | Keep matching files out of automatic agent input. Repeat rules in gitignore order; the diff still shows them. |
| `--model NAME` | Choose the model used for notes. |
| `--reasoning LEVEL` | Set `minimal`, `low`, `medium`, `high`, or `xhigh` for Codex or OpenCode. |
| `--fast` | Enable provider Fast mode for agent notes and Review chat. |
| `--batch-size COUNT` | Set the most files per agent pass. The default is `12`; large patches use smaller batches. |
| `--jobs COUNT` | Set agent passes to run at once. The default is `3`. |
| `--force` | Regenerate all agent notes instead of using cached notes. |
| `--support-record` | Print a safe JSON record if the review fails. |
| `--support-record-file FILE` | Write one safe JSON record if the review fails. |
| `--remote NAME\|URL` | Choose the Git remote. The default is `origin`. |
| `--summaries FILE` | Choose the saved agent-note file. |
| `--output FILE` | Choose a live snapshot file that remains after shutdown. |
| `--cache-dir PATH` | Choose the bare Git cache folder. |
| `--codex-bin PATH` | Choose the Codex executable. |
| `--port NUMBER` | Choose a port; `0` asks the OS for a free port. The default starts at `2299`. |
| `--host ADDRESS` | Choose the page bind address. The default is `localhost`. |
| `--no-browser` | Print the page URL without opening a browser. |
| `-h`, `--help` | Show command help. |
| `-v`, `--version` | Show the installed version. |

### Default agent

```sh
npx diffsplain config agent          # Show the default
npx diffsplain config agent claude   # Set it
npx diffsplain config agent --unset  # Remove it
```

Use `--agent NAME` to override the default or `--no-agent` for a plain diff;
the two flags cannot be combined. Without a choice, an interactive terminal
asks you to pick a usable agent. Scripts need a default or one of these flags.
A failed agent check or run stops the command; Diffsplain does not switch
agents.

### Saved notes

```sh
npx diffsplain cache status
npx diffsplain cache prune --age 30
npx diffsplain cache prune --size 104857600
npx diffsplain cache clear --yes
```

Cleanup keeps notes in active use. These commands manage the default note
cache, not the bare Git cache selected by `--cache-dir`.

## Local development

```sh
corepack enable
corepack pnpm run setup
corepack pnpm run dev
```

Run the public CLI from this checkout:

```sh
corepack pnpm run diffsplain -- --worktree
corepack pnpm run diffsplain -- doctor
corepack pnpm run doctor
```

Install Chromium once, then run the checks:

```sh
corepack pnpm run test:browser:install
corepack pnpm run check
corepack pnpm run test:browser
```

Run the Blume docs:

```sh
corepack pnpm run docs:dev
```

More guides are in [`docs/`](docs/).
