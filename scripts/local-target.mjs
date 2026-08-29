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

const checkoutTargetKinds = new Set([
  'checkout',
  'worktree',
  'base-worktree',
]);

function localTargetKind({ checkout, worktree }) {
  if (checkout) return 'checkout';
  if (worktree) return 'worktree';
  return undefined;
}

function remoteTargetKind({ branch, pullRequest }) {
  if (pullRequest) return 'pr';
  if (branch) return 'branch';
  return undefined;
}

function hasRangeTarget({ base, head, range }) {
  return Boolean(range || base || head);
}

function gitTargetKind(options) {
  const { base, branch, checkout, head, pullRequest, worktree } = options;
  if (isBaseWorktreeTarget({
    base,
    branch,
    checkout,
    head,
    pullRequest,
    worktree,
  })) return 'base-worktree';
  if (hasRangeTarget(options)) return 'range';
  return undefined;
}

function explicitTargetKind(options) {
  return localTargetKind(options) ||
    remoteTargetKind(options) ||
    gitTargetKind(options);
}

function resolvedTargetKind(options) {
  const explicit = explicitTargetKind(options);
  if (explicit) return explicit;
  if (options.snapshotSupplied) return undefined;
  return 'worktree';
}

export function reviewAccessMode({
  repo,
  base,
  branch,
  checkout,
  head,
  noCheckoutAccess = false,
  pullRequest,
  range,
  snapshotSupplied = false,
  worktree,
}) {
  if (noCheckoutAccess) {
    return { mode: 'snapshot-only', reason: 'disabled' };
  }
  const targetKind = resolvedTargetKind({
    base,
    branch,
    checkout,
    head,
    pullRequest,
    range,
    snapshotSupplied,
    worktree,
  });
  if (checkoutTargetKinds.has(targetKind)) {
    return { mode: 'checkout-read-only', root: repo };
  }
  return { mode: 'snapshot-only', reason: 'target-mismatch' };
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
