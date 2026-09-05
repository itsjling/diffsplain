# Diffsplain

Review a Git diff one file at a time, with a short coding agent note beside each
patch.

## Use

Run from a Git checkout:

```sh
npx diffsplain
```

The command opens a local page showing staged, unstaged, and untracked changes
against `HEAD`, the same as `--worktree`. It starts at port `2299` and uses the
next free port when needed. Keep the command running while you review; press
Ctrl-C to stop it.

You need Node.js 22.13 or newer and Git. Agent notes also need a signed-in
Codex, Claude, Copilot, Cursor, or OpenCode CLI. Set a default with
`diffsplain config agent NAME`, or choose one run with `--agent NAME`. If
neither is set, an interactive terminal lists usable agents in that order and
asks you to choose one. For a plain review without an agent, run
`npx diffsplain --no-agent`. In a non-interactive run, set a default or pass
`--agent NAME` or `--no-agent`.

Cursor Agent must be version 2026.08.11 or newer. It uses the signed-in Cursor
CLI in the user's home and still contacts the Cursor service.
Pull requests also need a signed-in GitHub CLI. Once Diffsplain chooses an
agent, a failed check or run ends the command; it does not switch agents.

Common targets:

```sh
npx diffsplain --pr 198
npx diffsplain owner/repo --branch feature/my-change
npx diffsplain --worktree
npx diffsplain --base BASE_REF
npx diffsplain --base BASE_REF --head HEAD_REF
```

Check Git, the GitHub CLI, and each supported coding agent:

```sh
npx diffsplain doctor
npx diffsplain doctor --json
```

Show, set, or unset the default coding agent:

```sh
npx diffsplain config agent
npx diffsplain config agent claude
npx diffsplain config agent --unset
```

An explicit `--agent` overrides the configured default, and `--no-agent`
overrides both. A damaged, unsupported, or unavailable configured agent stops
the command instead of switching providers; use either explicit option as a
recovery path. The two per-run options cannot be combined.

Inspect or clean up saved agent notes:

```sh
npx diffsplain cache status
npx diffsplain cache prune --age 30
npx diffsplain cache prune --size 104857600
npx diffsplain cache clear --yes
```

Cleanup keeps notes in active use. These commands manage the default note
cache, not the bare Git cache selected by `--cache-dir`.

Arguments (see the [full CLI reference](docs/content/cli.mdx) for details):

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
