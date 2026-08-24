# Diffsplain

Review a Git diff one file at a time, with a short coding agent note beside each
patch.

## Use

Run from a Git checkout:

```sh
npx diffsplain
```

The command opens a local page and compares the checkout with its default
branch. It starts at port `2299` and uses the next free port when needed. You
need Node.js 22.13 or newer and a signed-in Codex, Claude, Copilot, Cursor, or
OpenCode CLI. Diffsplain tries them in that order. Cursor Agent must be version
2026.08.11 or newer. It uses the signed-in Cursor CLI in the user's home and
still contacts the Cursor service. Pull requests also need a signed-in GitHub
CLI. Once Diffsplain chooses an agent, a failed check or run ends the command;
it does not switch agents.

Common targets:

```sh
npx diffsplain --pr 198
npx diffsplain owner/repo --branch feature/my-change
npx diffsplain --worktree
npx diffsplain --base BASE_REF --head HEAD_REF
```

Check Git, the GitHub CLI, and each supported coding agent:

```sh
npx diffsplain doctor
```

Arguments:

| Argument | Use |
| --- | --- |
| `doctor` | Show dependency paths, versions, and readiness. |
| `REPO`, `--repo PATH\|URL\|OWNER/REPO` | Select a local or remote repo. |
| `--pr NUMBER\|URL` | Review a GitHub pull request. |
| `--branch NAME` | Compare a remote branch with its default branch. |
| `--worktree` | Review tracked and untracked changes against `HEAD`. |
| `--base REF --head REF` | Review an exact local range. |
| `--agent NAME`, `--no-agent` | Choose a coding agent, or show a plain diff. |
| `--model NAME` | Choose the model used for notes. |
| `--reasoning LEVEL` | Set `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `--batch-size COUNT` | Set the most files per agent pass. The default is `12`; large patches use smaller batches. |
| `--jobs COUNT` | Set agent passes to run at once. The default is `3`. |
| `--force` | Regenerate all agent notes instead of using cached notes. |
| `--support-record` | Print a safe JSON record if the review fails. |
| `--support-record-file FILE` | Write one safe JSON record if the review fails. |
| `--remote NAME\|URL` | Choose the Git remote. The default is `origin`. |
| `--port NUMBER` | Choose an exact local port. The default starts at `2299`. |
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
