import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function defaultCacheRoot({
  env = process.env,
  platform = process.platform,
  homeDirectory = homedir(),
} = {}) {
  if (env.XDG_CACHE_HOME) {
    return resolve(env.XDG_CACHE_HOME, 'diffsplain');
  }
  const platformRoot =
    {
      darwin: resolve(homeDirectory, 'Library/Caches'),
      win32: resolve(
        env.LOCALAPPDATA || resolve(homeDirectory, 'AppData/Local'),
      ),
    }[platform] || resolve(homeDirectory, '.cache');
  return resolve(platformRoot, 'diffsplain');
}

function pullRequestTarget(pr, remote) {
  const pullRequest =
    pr?.match(/\/pull\/(\d+)(?:\/|$)/)?.[1] || pr || undefined;
  return { kind: 'pr', pullRequest, remote };
}

function branchTarget(branch, base, remote) {
  return { kind: 'branch', branch, base: base || 'default', remote };
}

function checkoutTarget(base, remote) {
  return { kind: 'checkout', base: base || 'default', remote };
}

function localSummaryTarget(base, head) {
  if (!base) return { kind: 'worktree' };
  if (!head) return { kind: 'base-worktree', base };
  return { kind: 'range', base, head };
}

function summaryTarget({ pr, branch, checkout, base, head, remote }) {
  const candidates = [
    [Boolean(pr), pullRequestTarget(pr, remote)],
    [Boolean(branch), branchTarget(branch, base, remote)],
    [Boolean(checkout), checkoutTarget(base, remote)],
  ];
  const selected = candidates.find(([matches]) => matches);
  if (selected) return selected[1];
  return localSummaryTarget(base, head);
}

export function summaryPath({
  callerDirectory,
  repo,
  cacheRoot = defaultCacheRoot(),
  explicit,
  pr,
  branch,
  checkout = false,
  base,
  head,
  remote = 'origin',
}) {
  if (explicit) return resolve(callerDirectory, explicit);
  const target = summaryTarget({ pr, branch, checkout, base, head, remote });
  const key = createHash('sha256')
    .update(JSON.stringify({ repo, target }))
    .digest('hex')
    .slice(0, 24);
  return resolve(cacheRoot, 'summaries', `${target.kind}-${key}.json`);
}
