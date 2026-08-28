import { spawnSync } from 'node:child_process';

export function isBaseWorktreeTarget({
  base,
  branch,
  checkout,
  head,
  pullRequest,
  worktree,
}) {
  return Boolean(base) && [branch, checkout, head, pullRequest, worktree]
    .every((value) => !value);
}

export function resolveBaseWorktreeCommit(repo, base) {
  const result = spawnSync(
    'git',
    ['-C', repo, 'rev-parse', '--verify', `${base}^{commit}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const oid = result.status === 0 ? result.stdout.trim() : '';
  if (!oid) {
    throw new Error(`Could not resolve base ref "${base}" to a commit.`);
  }
  return oid;
}
