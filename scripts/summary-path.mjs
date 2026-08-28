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
  const pullRequest =
    pr?.match(/\/pull\/(\d+)(?:\/|$)/)?.[1] || pr || undefined;
  const target = pr
    ? { kind: 'pr', pullRequest, remote }
    : branch
      ? { kind: 'branch', branch, base: base || 'default', remote }
      : checkout
        ? { kind: 'checkout', base: base || 'default', remote }
        : base && head
          ? { kind: 'range', base, head }
          : base
            ? { kind: 'base-worktree', base }
            : { kind: 'worktree' };
  const key = createHash('sha256')
    .update(JSON.stringify({ repo, target }))
    .digest('hex')
    .slice(0, 24);
  return resolve(cacheRoot, 'summaries', `${target.kind}-${key}.json`);
}
