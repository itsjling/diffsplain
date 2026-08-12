# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers reviewing pull requests. They need to understand each diff quickly without losing key facts, reasons, or risks.

## Product Purpose

Diffsplain is an open-source developer tool for pull request review. It makes PRs clear by showing one changed file at a time with concise, complete notes from a coding agent. It succeeds when a developer can understand a PR and review it with less effort.

## Positioning

Diffsplain runs on a PR and pairs each unified diff with agent-written context about what changed, why it changed, useful details, and risks. It keeps that context beside the code instead of making the developer piece it together from a separate chat or a raw patch.

## Operating Context

Developers run `npx diffsplain` in a Git checkout. With no arguments, it compares the checkout with its default branch. They can also pass a repo path, URL, or `owner/name`, then choose a branch or pull request. Developers move through changed files, search the file list, and expand long patches when needed. The page updates when the diff or agent notes change.

## Capabilities and Constraints

- Show GitHub pull requests without changing the local checkout.
- Compare the current checkout with its default branch when no target is passed.
- Accept local paths, Git URLs, and GitHub `owner/name` repo names.
- Report local dependency paths, versions, and readiness with `diffsplain doctor`.
- Try Codex, Claude, Copilot, Cursor, then OpenCode when no agent is chosen.
  Use Cursor only when version 2026.08.11 or newer passes the hostile boundary
  check. Cursor still contacts its service, but its review tools cannot read or
  change host files, run commands, use MCP, or reach hosts. Once Diffsplain
  chooses an agent, do not switch agents after a failed check or run.
- Show tracked and untracked worktree changes, exact local ranges, and remote branches as secondary targets.
- Present full or shortened unified diffs, including binary-file metadata.
- Pair the whole change and each file with agent-written summaries, reasons, details, and risks.
- Keep local review read-only: the app must not change the target repo.
- Keep notes concise without dropping facts needed for a sound review.
- Use the product name Diffsplain.

## Brand Commitments

Use the name “Diffsplain.” Describe it as an open-source developer tool built to run on pull requests. Keep it local and read-only.

## Evidence on Hand

- `README.md` documents command use and local development.
- `docs/content/` documents review targets, agent notes, and data flow.
- `app/page.tsx` contains the working review interface and its loading, empty, search, navigation, and long-diff states.
- `public/demo-diff-data.json` contains a ten-file todo-list demo with change and file notes.
- `data/todo-demo-summaries.json` contains the agent notes used by the demo.
- Tests cover rendering, remote targets, summary paths, agent notes, and snapshot generation.
- No confirmed testimonials, customer claims, pricing, or benchmark data exists in this repo; future work must not invent them.

## Product Principles

1. Make every diff easy to scan and understand.
2. Keep agent notes short, complete, and tied to the code in view.
3. Preserve the developer’s repo and review state.
4. Make the no-argument command useful without forcing branch changes.
5. State uncertainty and risk instead of hiding them.
