#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isBaseWorktreeTarget,
  resolveBaseWorktreeCommit,
} from './local-target.mjs';
import { createAgentExclusionMatcher } from './agent-exclusions.mjs';
import {
  agentReviewContext,
  agentReviewFile,
  createAgentReviewFingerprint,
} from './agent-review.mjs';
import { summaryPath } from './summary-path.mjs';

const args = process.argv.slice(2);
const fail = (message) => {
  console.error(message);
  process.exit(2);
};
const option = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} needs a value`);
  return value;
};
const options = (name) =>
  args.flatMap((argument, index) =>
    argument === name && args[index + 1] ? [args[index + 1]] : [],
  );
const has = (name) => args.includes(name);

if (has('--help')) {
  console.log(`Usage: node scripts/build-diff-data.mjs [target] [options]

Targets:
  --pr NUMBER|URL     Fetch and show a GitHub pull request
  --branch NAME       Fetch and show a remote branch
  --checkout          Show the current checkout against its default branch
  --base REF [--head REF]
                      Compare a base with the working tree, or show an exact range
  (no target)         Show worktree changes against HEAD

Options:
  --repo PATH         Local Git workspace (default: current directory)
  --remote NAME|URL   Remote for --pr or --branch (default: origin)
  --base REF          Remote base branch with --branch
  --summaries FILE    Agent note file
  --output FILE       JSON output
  --cache-dir PATH    Bare cache for fetched Git objects
  --watch             Keep the data current`);
  process.exit(0);
}

const repo = resolve(option('--repo') || process.cwd());
const output = resolve(option('--output') || '.cache/diff-data.json');
const excludedOutputs = options('--exclude-output');
const agentExcludeRules = options('--exclude');
const baseOption = option('--base');
const headOption = option('--head');
const prOption = option('--pr');
const branchOption = option('--branch');
const checkoutOption = has('--checkout');
const worktreeOption = has('--worktree');
const remoteOption = option('--remote') || 'origin';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const summariesPath = summaryPath({
  projectRoot,
  callerDirectory: process.cwd(),
  repo,
  explicit: option('--summaries'),
  pr: prOption,
  branch: branchOption,
  checkout: checkoutOption,
  base: baseOption,
  head: headOption,
  remote: remoteOption,
});
const cacheOption = option('--cache-dir');
const cacheRoot = cacheOption
  ? resolve(cacheOption)
  : resolve(projectRoot, '.cache/git');
const remoteMode = Boolean(prOption || branchOption);
const baseWorktreeOption = isBaseWorktreeTarget({
  base: baseOption,
  branch: branchOption,
  checkout: checkoutOption,
  head: headOption,
  pullRequest: prOption,
  worktree: worktreeOption,
});
const watching = has('--watch');
const watchContent = has('--watch-content');
const ignoreSummaryWatch = has('--ignore-summary-watch');
const noSummaries = has('--no-summaries');
const interval = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const watchInterval = interval('DIFFSPLAIN_WATCH_INTERVAL_MS', 2_000);
const remoteRefreshInterval = interval(
  'DIFFSPLAIN_REMOTE_REFRESH_INTERVAL_MS',
  30_000,
);

if (prOption && branchOption) fail('--pr and --branch cannot be used together');
if (prOption && (baseOption || headOption)) fail('--pr cannot be used with --base or --head');
if (branchOption && headOption) fail('--branch cannot be used with --head');
if (
  checkoutOption &&
  (prOption || branchOption || headOption || worktreeOption)
) {
  fail('--checkout cannot be combined with another target');
}
if (
  worktreeOption &&
  (prOption || branchOption || baseOption || headOption)
) {
  fail('--worktree cannot be combined with another target');
}
if (!prOption && !branchOption && !checkoutOption && headOption && !baseOption) {
  fail('--head must be used with --base');
}

const repoPath = (file) => {
  const path = relative(repo, file).replaceAll('\\', '/');
  return path && path !== '..' && !path.startsWith('../') ? path : undefined;
};
const summariesRepoPath = repoPath(summariesPath);
const excludedPaths = new Set(
  [
    summariesRepoPath,
    summariesRepoPath ? `${summariesRepoPath}.lock` : undefined,
    repoPath(output),
    ...excludedOutputs.map((path) => repoPath(resolve(path))),
  ].filter(Boolean),
);

function command(commandName, commandArgs, options = {}) {
  return execFileSync(commandName, commandArgs, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function githubHttpsRemote(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'github.com' || parsed.hostname === 'www.github.com')
    );
  } catch {
    return false;
  }
}

function runGit(gitArgs, { gitDir, remoteUrl } = {}) {
  const githubHttps = githubHttpsRemote(remoteUrl);
  return command(
    'git',
    [
      ...(gitDir ? ['--git-dir', gitDir] : ['-C', repo]),
      ...(githubHttps
        ? ['-c', 'credential.helper=!gh auth git-credential']
        : []),
      ...gitArgs,
    ],
    githubHttps
      ? { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
      : {},
  );
}

const runRepo = (gitArgs) => command('git', ['-C', repo, ...gitArgs]);
const tryRepo = (gitArgs) => {
  try {
    return runRepo(gitArgs).trim();
  } catch {
    return '';
  }
};
const runRepoWithDiffExit = (gitArgs) => {
  const result = spawnSync('git', ['-C', repo, ...gitArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr.trim() || `git ${gitArgs[0]} failed`);
  }
  return result.stdout;
};
const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const cleanText = (value, fallback) =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;
const cleanList = (value) =>
  Array.isArray(value)
    ? value
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim())
    : [];
const completeList = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const completeText = (value) =>
  typeof value === 'string' && Boolean(value.trim());
const completeFileSummary = (value) =>
  value &&
  completeText(value.title) &&
  completeText(value.what) &&
  completeText(value.why) &&
  completeList(value.details) &&
  completeList(value.risks);
const completeChangeSummary = (value) =>
  value &&
  completeText(value.title) &&
  completeText(value.summary) &&
  completeText(value.why) &&
  completeList(value.highlights) &&
  completeList(value.risks);
const failedFileRecords = (value) =>
  Array.isArray(value)
    ? value
        .filter(
          (item) =>
            item &&
            typeof item.path === 'string' &&
            item.path.trim() &&
            typeof item.reason === 'string' &&
            item.reason.trim(),
        )
        .map((item) => ({
          path: item.path.trim(),
          reason: item.reason.trim(),
        }))
    : [];

function fileSummary(path, value) {
  return {
    title: cleanText(value?.title, path),
    what: cleanText(value?.what, 'Shows the current Git patch.'),
    why: cleanText(
      value?.why,
      'Start Diffsplain with --agent to generate this note.',
    ),
    details: cleanList(value?.details),
    risks: cleanList(value?.risks),
  };
}

function changeSummary(value, defaults = {}) {
  const number = Number.isInteger(value?.number)
    ? value.number
    : defaults.number;
  const url =
    typeof value?.url === 'string' && value.url ? value.url : defaults.url;
  return {
    title: cleanText(value?.title, defaults.title || 'Local changes'),
    ...(Number.isInteger(number) ? { number } : {}),
    ...(url ? { url } : {}),
    summary: cleanText(
      value?.summary,
      defaults.summary || 'Changes in the selected Git range.',
    ),
    why: cleanText(value?.why, defaults.why || 'Shows the current review set.'),
    highlights: cleanList(value?.highlights || defaults.highlights),
    risks: cleanList(value?.risks || defaults.risks),
  };
}

function parseNameStatus(raw) {
  const fields = raw.split('\0').filter(Boolean);
  const files = [];
  for (let index = 0; index < fields.length; ) {
    const code = fields[index++];
    const kind = code[0];
    if (kind === 'R' || kind === 'C') {
      const oldPath = fields[index++];
      files.push({ path: fields[index++], oldPath, status: 'renamed' });
    } else {
      files.push({
        path: fields[index++],
        status:
          kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified',
      });
    }
  }
  return files;
}

function parseNumstat(raw) {
  const out = new Map();
  const fields = raw.split('\0').filter(Boolean);
  for (let index = 0; index < fields.length; ) {
    const row = fields[index++];
    const [add, del, inlinePath] = row.split('\t');
    let oldPath;
    let path = inlinePath;
    if (!path) {
      oldPath = fields[index++];
      path = fields[index++];
    }
    out.set(path, {
      additions: add === '-' ? 0 : Number(add),
      deletions: del === '-' ? 0 : Number(del),
      isBinary: add === '-' || del === '-',
      oldPath,
    });
  }
  return out;
}

function compactSnippet(patch, limit = 180) {
  const lines = patch.split('\n');
  if (lines.length <= limit) return patch;
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  if (firstHunk < 0) return patch;

  const output = lines.slice(0, firstHunk);
  let cursor = firstHunk;
  while (cursor < lines.length && output.length < limit) {
    const nextHunk = lines.findIndex(
      (line, index) => index > cursor && line.startsWith('@@'),
    );
    const end = nextHunk < 0 ? lines.length : nextHunk;
    const hunk = lines.slice(cursor, end);
    const remaining = limit - output.length;

    if (hunk.length <= remaining) {
      output.push(...hunk);
    } else {
      const match = hunk[0].match(
        /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/,
      );
      if (!match || remaining < 2) break;

      const body = hunk.slice(1, remaining);
      let oldCount = 0;
      let newCount = 0;
      for (const line of body) {
        if (line === '\\ No newline at end of file') continue;
        if (!line.startsWith('+')) oldCount += 1;
        if (!line.startsWith('-')) newCount += 1;
      }
      output.push(
        `@@ -${match[1]},${oldCount} +${match[2]},${newCount} @@${match[3]}`,
        ...body,
      );
    }

    if (nextHunk < 0 || output.length >= limit) break;
    cursor = nextHunk;
  }
  return output.join('\n');
}

function normalizeBranch(value, remoteName) {
  let branch = value;
  if (branch.startsWith('refs/heads/')) branch = branch.slice(11);
  if (branch.startsWith(`${remoteName}/`)) {
    branch = branch.slice(remoteName.length + 1);
  }
  const result = spawnSync('git', ['check-ref-format', `refs/heads/${branch}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`Invalid remote branch: ${value}`);
  return branch;
}

function resolveRemote() {
  const configured = tryRepo([
    'config',
    '--get-all',
    `remote.${remoteOption}.url`,
  ])
    .split('\n')
    .find(Boolean);
  if (configured) {
    return {
      name: remoteOption,
      url: configured,
      fetchUrl: tryRepo(['remote', 'get-url', remoteOption]) || configured,
    };
  }
  if (remoteOption === 'origin') {
    throw new Error(`Git remote "origin" was not found in ${repo}`);
  }
  return { name: remoteOption, url: remoteOption, fetchUrl: remoteOption };
}

function bareCache(remoteUrl) {
  const key = createHash('sha256').update(remoteUrl).digest('hex').slice(0, 20);
  const path = resolve(cacheRoot, key);
  if (!existsSync(resolve(path, 'HEAD'))) {
    mkdirSync(cacheRoot, { recursive: true });
    command('git', ['init', '--bare', '--quiet', path]);
  }
  const run = (gitArgs) => command('git', ['--git-dir', path, ...gitArgs]);
  return { path, run };
}

function fetchInto(cache, remoteUrl, refspecs) {
  try {
    runGit(
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-auto-maintenance',
        '--force',
        remoteUrl,
        ...refspecs,
      ],
      { gitDir: cache.path, remoteUrl },
    );
  } catch (error) {
    const detail = error?.stderr?.toString().trim();
    throw new Error(
      `Could not fetch the remote target${detail ? `: ${detail}` : ''}`,
    );
  }
}

function uniqueMergeBase(runGit, base, head) {
  let raw;
  try {
    raw = runGit(['merge-base', '--all', base, head]).trim();
  } catch {
    throw new Error('The target branch and base branch have no common commit');
  }
  const bases = raw.split('\n').filter(Boolean);
  if (bases.length !== 1) {
    throw new Error(
      bases.length
        ? 'The target has more than one merge base'
        : 'The target branch and base branch have no common commit',
    );
  }
  return bases[0];
}

function remoteDefaultBranchInfo(remoteUrl) {
  let raw;
  try {
    raw = runGit(['ls-remote', '--symref', remoteUrl, 'HEAD'], { remoteUrl });
  } catch {
    throw new Error('Could not read the remote default branch');
  }
  const match = raw.match(/^ref:\s+refs\/heads\/([^\t\n]+)\s+HEAD$/m);
  if (!match) {
    throw new Error('The remote has no default branch; pass --base NAME');
  }
  const oid = raw.match(new RegExp(`^([a-f0-9]+)\\s+HEAD$`, 'm'))?.[1];
  return { name: match[1], oid };
}

function remoteDefaultBranch(remoteUrl) {
  return remoteDefaultBranchInfo(remoteUrl).name;
}

function remoteContainsCommits(remoteUrl, commits) {
  let raw;
  try {
    raw = runGit(['ls-remote', remoteUrl], { remoteUrl });
  } catch {
    return false;
  }
  const tips = [
    ...new Set(
      raw
        .split('\n')
        .map((line) => line.trim().split(/\s+/, 1)[0])
        .filter(Boolean),
    ),
  ];
  return commits.every((commit) =>
    tips.some((tip) => {
      if (tip === commit) return true;
      const result = spawnSync(
        'git',
        ['-C', repo, 'merge-base', '--is-ancestor', commit, tip],
        { stdio: 'ignore' },
      );
      return result.status === 0;
    }),
  );
}

function localDefaultBranch(remote) {
  if (baseOption) return { name: baseOption };

  if (remote) {
    const symbolic = tryRepo([
      'symbolic-ref',
      '--quiet',
      `refs/remotes/${remote.name}/HEAD`,
    ]);
    const prefix = `refs/remotes/${remote.name}/`;
    if (symbolic.startsWith(prefix)) {
      return { name: symbolic.slice(prefix.length) };
    }
    try {
      return remoteDefaultBranchInfo(remote.url);
    } catch {}
  }

  const configured = tryRepo(['config', '--get', 'init.defaultBranch']);
  const candidates = [configured, 'main', 'master'].filter(Boolean);
  for (const name of candidates) {
    if (tryRepo(['rev-parse', '--verify', `refs/heads/${name}^{commit}`])) {
      return { name };
    }
  }
  throw new Error(
    'Could not find the default branch. Fetch it or pass --base NAME.',
  );
}

function localBaseCommit(base, remote) {
  const candidates = [
    remote ? `refs/remotes/${remote.name}/${base.name}` : undefined,
    `refs/heads/${base.name}`,
    base.name,
    base.oid,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const oid = tryRepo(['rev-parse', '--verify', `${candidate}^{commit}`]);
    if (oid) return oid;
  }
  throw new Error(
    `The default branch "${base.name}" is not in this checkout. Run git fetch or pass --base REF.`,
  );
}

function githubRepository(remoteUrl) {
  if (!remoteUrl) return undefined;
  let host;
  let path;
  const scp = remoteUrl.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
  if (scp && !remoteUrl.includes('://')) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const parsed = new URL(remoteUrl);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\/+/, '');
    } catch {
      return undefined;
    }
  }
  const parts = path.replace(/\.git$/, '').split('/').filter(Boolean);
  if (!host || parts.length < 2) return undefined;
  const ownerRepo = `${parts.at(-2)}/${parts.at(-1)}`;
  return {
    name: ownerRepo,
    selector: host === 'github.com' ? ownerRepo : `${host}/${ownerRepo}`,
    webUrl: `https://${host}/${ownerRepo}`,
  };
}

function pullRequestInfo(pr, remote) {
  const repository = githubRepository(remote.url);
  const fields = [
    'number',
    'title',
    'url',
    'state',
    'updatedAt',
    'isCrossRepository',
    'baseRefName',
    'baseRefOid',
    'headRefName',
    'headRefOid',
    'headRepository',
    'headRepositoryOwner',
  ].join(',');
  const ghArgs = ['pr', 'view', pr, '--json', fields];
  if (repository?.selector) ghArgs.push('--repo', repository.selector);
  try {
    const value = JSON.parse(command('gh', ghArgs, { cwd: repo }));
    for (const key of [
      'number',
      'title',
      'url',
      'baseRefName',
      'baseRefOid',
      'headRefName',
      'headRefOid',
    ]) {
      if (value[key] === undefined || value[key] === '') {
        throw new Error(`gh returned no ${key}`);
      }
    }
    return { value, repository };
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message;
    if (
      repository &&
      /Could not resolve to a PullRequest with the number of/i.test(detail)
    ) {
      const prNumber = String(pr).replace(
        /^.*\/pull\/(\d+)(?:\/.*)?$/,
        "$1",
      );
      const repositoryShape = repository.selector.replace(
        repository.name,
        "owner/repo",
      );
      const pullRequestUrl = `${repository.webUrl.replace(repository.name, "owner/repo")}/pull/${prNumber}`;
      throw new Error(
        `Pull request ${prNumber} was not found in ${repository.selector}. Pass ${repositoryShape} before --pr ${prNumber}, or pass ${pullRequestUrl}.`,
      );
    }
    const authHint =
      /(?:HTTP 401|Bad credentials|authentication failed|not logged (?:in|into)|gh auth login)/i.test(
        detail,
      )
        ? ' Check gh auth status.'
        : '';
    throw new Error(
      `Could not read pull request ${pr} with gh${detail ? `: ${detail}` : ''}.${authHint}`,
    );
  }
}

function resolveBranchTarget() {
  const remote = resolveRemote();
  const branch = normalizeBranch(branchOption, remote.name);
  const baseBranch = normalizeBranch(
    baseOption || remoteDefaultBranch(remote.fetchUrl),
    remote.name,
  );
  const cache = bareCache(remote.url);
  const key = createHash('sha256')
    .update(`${baseBranch}\0${branch}`)
    .digest('hex')
    .slice(0, 16);
  const baseRef = `refs/diffsplain/branch/${key}/base`;
  const headRef = `refs/diffsplain/branch/${key}/head`;
  fetchInto(cache, remote.fetchUrl, [
    `+refs/heads/${baseBranch}:${baseRef}`,
    `+refs/heads/${branch}:${headRef}`,
  ]);
  const baseOid = cache.run(['rev-parse', `${baseRef}^{commit}`]).trim();
  const headOid = cache.run(['rev-parse', `${headRef}^{commit}`]).trim();
  const mergeBaseOid = uniqueMergeBase(cache.run, baseOid, headOid);
  const repository = githubRepository(remote.url);
  return {
    kind: 'branch',
    runGit: cache.run,
    range: [mergeBaseOid, headOid],
    base: mergeBaseOid,
    head: headOid,
    branch,
    baseBranch,
    remote,
    sourceRepositoryUrl: repository?.webUrl,
    baseRepositoryUrl: repository?.webUrl,
    comparisonCommitsOnRemote: true,
    target: {
      kind: 'branch',
      remote: remote.name,
      base: { ref: baseBranch, oid: baseOid },
      head: { ref: branch, oid: headOid },
      mergeBaseOid,
    },
    changeDefaults: {
      title: `Compare ${branch} to ${baseBranch}`,
      summary: `Shows changes on ${branch} since it split from ${baseBranch}.`,
      why: 'Reviews the remote branch without changing the local checkout.',
      highlights: [],
      risks: [],
    },
  };
}

function resolvePullRequestTarget() {
  const remote = resolveRemote();
  const { value: pr, repository } = pullRequestInfo(prOption, remote);
  const cache = bareCache(remote.url);
  const key = createHash('sha256')
    .update(String(pr.number))
    .digest('hex')
    .slice(0, 16);
  const baseRef = `refs/diffsplain/pr/${key}/base`;
  const headRef = `refs/diffsplain/pr/${key}/head`;
  fetchInto(cache, remote.fetchUrl, [
    `+refs/heads/${pr.baseRefName}:${baseRef}`,
    `+refs/pull/${pr.number}/head:${headRef}`,
  ]);
  try {
    cache.run(['cat-file', '-e', `${pr.baseRefOid}^{commit}`]);
    cache.run(['cat-file', '-e', `${pr.headRefOid}^{commit}`]);
  } catch {
    throw new Error('The pull request changed while it was being read; run again');
  }
  const mergeBaseOid = uniqueMergeBase(
    cache.run,
    pr.baseRefOid,
    pr.headRefOid,
  );
  const headRepository =
    pr.headRepository?.nameWithOwner ||
    (pr.headRepositoryOwner?.login && pr.headRepository?.name
      ? `${pr.headRepositoryOwner.login}/${pr.headRepository.name}`
      : undefined);
  const repositoryOrigin = repository?.webUrl
    ? new URL(repository.webUrl).origin
    : 'https://github.com';
  return {
    kind: 'pull-request',
    runGit: cache.run,
    range: [mergeBaseOid, pr.headRefOid],
    base: mergeBaseOid,
    head: pr.headRefOid,
    branch: pr.headRefName,
    baseBranch: pr.baseRefName,
    remote,
    sourceRepositoryUrl: headRepository
      ? `${repositoryOrigin}/${headRepository}`
      : repository?.webUrl ||
        pr.url.replace(/\/pull\/\d+(?:\/.*)?$/, ''),
    baseRepositoryUrl:
      repository?.webUrl || pr.url.replace(/\/pull\/\d+(?:\/.*)?$/, ''),
    comparisonCommitsOnRemote: true,
    target: {
      kind: 'pull-request',
      remote: remote.name,
      repository: repository?.selector,
      pullRequest: {
        number: pr.number,
        url: pr.url,
        state: pr.state,
        updatedAt: pr.updatedAt,
        isCrossRepository: pr.isCrossRepository,
      },
      base: { ref: pr.baseRefName, oid: pr.baseRefOid },
      head: {
        ref: pr.headRefName,
        oid: pr.headRefOid,
        ...(headRepository ? { repository: headRepository } : {}),
      },
      mergeBaseOid,
    },
    changeDefaults: {
      title: pr.title,
      number: pr.number,
      url: pr.url,
      summary: `Shows pull request #${pr.number} from ${pr.headRefName} into ${pr.baseRefName}.`,
      why: 'Reviews the remote pull request without changing the local checkout.',
      highlights: [],
      risks: [],
    },
  };
}

function resolveCheckoutTarget() {
  const currentHead = tryRepo(['rev-parse', '--verify', 'HEAD']);
  if (!currentHead) return resolveLocalTarget();

  const branch = tryRepo(['branch', '--show-current']) || undefined;
  const remoteUrl = tryRepo(['remote', 'get-url', remoteOption]) || undefined;
  const remote = remoteUrl
    ? { name: remoteOption, url: remoteUrl }
    : undefined;
  const defaultBranch = localDefaultBranch(remote);
  const defaultHead = localBaseCommit(defaultBranch, remote);
  const mergeBaseOid = uniqueMergeBase(runRepo, defaultHead, currentHead);
  const repository = githubRepository(remoteUrl);
  const headLabel = branch || currentHead;
  const hasCommittedChanges = mergeBaseOid !== currentHead;
  const hasUncommittedChanges = Boolean(
    tryRepo(['status', '--porcelain=v1', '-z']),
  );
  const isDefaultBranchCheckout = branch === defaultBranch.name;

  return {
    kind: 'checkout',
    runGit: runRepo,
    range: [mergeBaseOid],
    base: mergeBaseOid,
    head: currentHead,
    branch,
    baseBranch: defaultBranch.name,
    remote,
    sourceRepositoryUrl: repository?.webUrl,
    baseRepositoryUrl: repository?.webUrl,
    comparisonCommitsOnRemote:
      !hasUncommittedChanges &&
      Boolean(
        remote?.url &&
          remoteContainsCommits(remote.url, [mergeBaseOid, currentHead]),
      ),
    target: {
      kind: 'checkout',
      ...(remote ? { remote: remote.name } : {}),
      base: { ref: defaultBranch.name, oid: defaultHead },
      head: { ref: headLabel, oid: currentHead },
      mergeBaseOid,
    },
    changeDefaults: {
      title: hasCommittedChanges
        ? isDefaultBranchCheckout
          ? `Local changes on ${headLabel}`
          : `Changes on ${headLabel} since ${defaultBranch.name}`
        : `Uncommitted changes on ${headLabel}`,
      summary: hasCommittedChanges
        ? `Shows changes in the current checkout since it split from ${defaultBranch.name}, including any uncommitted work.`
        : 'Shows staged, unstaged, and untracked changes in the current checkout.',
      why: 'Reviews the checked-out work without changing the repo.',
      highlights: [],
      risks: [],
    },
  };
}

function resolveBaseWorktreeTarget() {
  const currentHead = tryRepo(['rev-parse', '--verify', 'HEAD']);
  const resolvedBase = resolveBaseWorktreeCommit(repo, baseOption);
  const remoteUrl = tryRepo(['remote', 'get-url', 'origin']) || undefined;
  return {
    kind: 'base-worktree',
    runGit: runRepo,
    range: [resolvedBase],
    base: resolvedBase,
    head: currentHead || 'WORKTREE',
    branch: tryRepo(['branch', '--show-current']) || undefined,
    remote: remoteUrl ? { name: 'origin', url: remoteUrl } : undefined,
    sourceRepositoryUrl: undefined,
    baseRepositoryUrl: undefined,
    comparisonCommitsOnRemote: false,
    target: {
      kind: 'base-worktree',
      base: { ref: baseOption, oid: resolvedBase },
      head: { ref: 'WORKTREE', oid: currentHead || null },
    },
    changeDefaults: {
      title: `Changes since ${baseOption}`,
      summary: `Shows commits and working-tree changes since ${baseOption}.`,
      why: 'Reviews the working tree against the chosen base without changing the repo.',
      highlights: [],
      risks: [],
    },
  };
}

function resolveLocalTarget() {
  const currentHead = tryRepo(['rev-parse', '--verify', 'HEAD']);
  const worktree = !baseOption && !headOption;
  const branch = tryRepo(['branch', '--show-current']) || undefined;
  let range;
  if (worktree) {
    range = currentHead ? [currentHead] : [runRepo(['mktree']).trim()];
  } else {
    range = [
      runRepo(['rev-parse', `${baseOption}^{commit}`]).trim(),
      runRepo(['rev-parse', `${headOption}^{commit}`]).trim(),
    ];
  }
  const resolvedBase = range[0];
  const resolvedHead = worktree ? currentHead || 'WORKTREE' : range[1];
  const remoteUrl = tryRepo(['remote', 'get-url', 'origin']) || undefined;
  return {
    kind: worktree ? 'worktree' : 'range',
    runGit: runRepo,
    range,
    base: resolvedBase,
    head: resolvedHead,
    branch,
    remote: remoteUrl ? { name: 'origin', url: remoteUrl } : undefined,
    sourceRepositoryUrl: worktree
      ? undefined
      : githubRepository(remoteUrl)?.webUrl,
    baseRepositoryUrl: worktree
      ? undefined
      : githubRepository(remoteUrl)?.webUrl,
    comparisonCommitsOnRemote:
      !worktree &&
      Boolean(
        remoteUrl &&
          remoteContainsCommits(remoteUrl, [resolvedBase, resolvedHead]),
      ),
    target: worktree
      ? { kind: 'worktree', base: { ref: 'HEAD', oid: currentHead || null } }
      : {
          kind: 'range',
          base: { ref: baseOption, oid: resolvedBase },
          head: { ref: headOption, oid: resolvedHead },
        },
    changeDefaults: worktree
      ? {
          title: branch
            ? `Uncommitted changes on ${branch}`
            : 'Uncommitted changes',
          summary:
            'Shows staged, unstaged, and untracked changes in the working tree.',
          why: 'Reviews the working tree without changing the repo.',
          highlights: [],
          risks: [],
        }
      : {},
  };
}

function resolveTarget() {
  if (prOption) return resolvePullRequestTarget();
  if (branchOption) return resolveBranchTarget();
  if (checkoutOption) return resolveCheckoutTarget();
  if (baseWorktreeOption) return resolveBaseWorktreeTarget();
  return resolveLocalTarget();
}

function trackedPatches(files, target) {
  const raw = target.runGit([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    '--find-renames',
    ...target.range,
  ]);
  const patches = raw
    .split(/(?=^diff --git )/m)
    .filter((patch) => patch.startsWith('diff --git '));
  if (patches.length !== files.length) return undefined;
  return new Map(
    files.map((file, index) => [file.path, patches[index]]),
  );
}

function filePatch(file, target, patches) {
  if (file.untracked) {
    return runRepoWithDiffExit([
      'diff',
      '--no-index',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      '--',
      '/dev/null',
      file.path,
    ]);
  }
  const combined = patches?.get(file.path);
  if (combined !== undefined) return combined;
  const pathspec = file.oldPath ? [file.oldPath, file.path] : [file.path];
  return target.runGit([
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    '--find-renames',
    ...target.range,
    '--',
    ...pathspec,
  ]);
}

function untrackedStat(path) {
  const raw = runRepoWithDiffExit([
    'diff',
    '--no-index',
    '--no-ext-diff',
    '--no-textconv',
    '--numstat',
    '--',
    '/dev/null',
    path,
  ]).trim();
  const [add = '0', del = '0'] = raw.split('\t');
  return {
    additions: add === '-' ? 0 : Number(add),
    deletions: del === '-' ? 0 : Number(del),
    isBinary: add === '-' || del === '-',
  };
}

function baseWorktreeReplacement(path, target) {
  const directory = mkdtempSync(join(tmpdir(), 'diffsplain-base-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(directory, 'index') };
  const diff = (args) => command('git', ['-C', repo, 'diff', ...args], { env });

  try {
    command('git', ['-C', repo, 'read-tree', target.base], { env });
    const patch = diff([
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      '--find-renames',
      target.base,
      '--',
      path,
    ]);
    const stat = parseNumstat(
      diff([
        '--no-ext-diff',
        '--no-textconv',
        '--numstat',
        '-z',
        '--find-renames',
        target.base,
        '--',
        path,
      ]),
    ).get(path) || {
      additions: 0,
      deletions: 0,
      isBinary: false,
    };
    return { patch, stat };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function reviewFileStat(file, numstat) {
  if (file.replacement) return file.replacement.stat;
  if (file.untracked) return untrackedStat(file.path);
  return (
    numstat.get(file.path) || {
      additions: 0,
      deletions: 0,
      isBinary: false,
    }
  );
}

function reviewFilePatch(file, target, patches) {
  return file.replacement?.patch ?? filePatch(file, target, patches);
}

function githubFileUrl(repositoryUrl, ref, path) {
  if (!repositoryUrl || !ref || ref === 'WORKTREE') return undefined;
  const filePath = path.split('/').map(encodeURIComponent).join('/');
  return `${repositoryUrl}/blob/${encodeURIComponent(ref)}/${filePath}`;
}

function githubComparisonUrl(repositoryUrl, base, head) {
  if (!repositoryUrl || !base || !head || head === 'WORKTREE') {
    return undefined;
  }
  return `${repositoryUrl}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
}

function fingerprintFile(file) {
  return agentReviewFile(file);
}

// fallow-ignore-next-line complexity -- Existing aggregation boundary; target handling stays in resolvers.
function build() {
  const localWorkspace =
    tryRepo(['rev-parse', '--is-inside-work-tree']) === 'true';
  if (!remoteMode && !localWorkspace) {
    throw new Error(`${repo} is not a Git checkout`);
  }
  const target = resolveTarget();
  const agentExcluded = createAgentExclusionMatcher(agentExcludeRules, {
    ignoreCase: tryRepo(['config', '--bool', 'core.ignoreCase']) === 'true',
  });
  const remoteRepository = githubRepository(target.remote?.url);
  const summaryDoc = noSummaries ? {} : readJson(summariesPath, {}) || {};
  const allTrackedFiles = parseNameStatus(
    target.runGit([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-status',
      '-z',
      '--find-renames',
      ...target.range,
    ]),
  );
  const nameStatus = allTrackedFiles.filter(
    (file) => !excludedPaths.has(file.path),
  );
  const numstat = parseNumstat(
    target.runGit([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--numstat',
      '-z',
      '--find-renames',
      ...target.range,
    ]),
  );
  const patches = trackedPatches(allTrackedFiles, target);

  if (
    target.kind === 'worktree' ||
    target.kind === 'base-worktree' ||
    target.kind === 'checkout'
  ) {
    const trackedByPath = new Map(nameStatus.map((file) => [file.path, file]));
    const untracked = tryRepo([
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ])
      .split('\0')
      .filter((path) => path && !excludedPaths.has(path));
    for (const path of untracked) {
      const tracked = trackedByPath.get(path);
      if (target.kind === 'base-worktree' && tracked?.status === 'deleted') {
        const replacement = baseWorktreeReplacement(path, target);
        if (replacement.patch) {
          tracked.status = 'modified';
          tracked.replacement = replacement;
        } else {
          tracked.omit = true;
        }
      } else if (!tracked) {
        nameStatus.push({ path, status: 'added', untracked: true });
      }
    }
    nameStatus.sort((left, right) => left.path.localeCompare(right.path));
  }

  const reviewFiles = nameStatus.filter((file) => !file.omit);
  const filesWithoutSummaries = reviewFiles.map((file) => {
    const stat = reviewFileStat(file, numstat);
    const patch = reviewFilePatch(file, target, patches);
    const binary =
      stat.isBinary ||
      patch.includes('Binary files ') ||
      patch.includes('GIT binary patch');
    const textPatch = binary ? '' : patch;
    const sourceUrl = githubFileUrl(
      file.status === 'deleted'
        ? target.baseRepositoryUrl
        : target.sourceRepositoryUrl,
      file.status === 'deleted' ? target.base : target.head,
      file.path,
    );
    const comparisonUrl = githubComparisonUrl(
      target.comparisonCommitsOnRemote
        ? target.sourceRepositoryUrl
        : undefined,
      target.base,
      target.head,
    );
    return {
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: binary ? 'binary' : file.status,
      additions: stat.additions,
      deletions: stat.deletions,
      isBinary: binary,
      isTruncated: !binary && textPatch.split('\n').length > 180,
      totalDiffLines: textPatch ? textPatch.split('\n').length - 1 : 0,
      patch: textPatch,
      snippet: binary ? '' : compactSnippet(textPatch),
      ...(agentExcluded(file.path) ? { agentExcluded: true } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(comparisonUrl ? { comparisonUrl } : {}),
    };
  });

  const agentFiles = filesWithoutSummaries.filter(
    (file) => !file.agentExcluded,
  );

  const reviewFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        repo: {
          base: target.base,
          head: target.head,
          branch: target.branch,
          baseBranch: target.baseBranch,
          remote: target.remote?.name,
          targetKind: target.kind,
        },
        files: filesWithoutSummaries.map(fingerprintFile),
      }),
    )
    .digest('hex');
  const agentReviewFingerprint = createAgentReviewFingerprint({
    context: agentReviewContext({
      name: remoteRepository?.name || basename(repo),
      selector: remoteRepository?.selector,
      target: target.target,
      branch: target.branch,
      baseBranch: target.baseBranch,
    }),
    files: agentFiles,
  });
  const hasAgentReviewFingerprint =
    typeof summaryDoc.meta?.agentReviewFingerprint === 'string';
  const hasLegacyReviewFingerprint =
    !hasAgentReviewFingerprint &&
    typeof summaryDoc.meta?.reviewFingerprint === 'string';
  const emptyAgentReviewFingerprint =
    typeof summaryDoc.meta?.emptyAgentReviewFingerprint === 'string'
      ? summaryDoc.meta.emptyAgentReviewFingerprint
      : undefined;
  const generatedFor = !noSummaries && hasAgentReviewFingerprint
    ? agentFiles.length === 0 && emptyAgentReviewFingerprint
      ? emptyAgentReviewFingerprint
      : summaryDoc.meta.agentReviewFingerprint
    : undefined;
  const summariesAreFresh =
    !noSummaries &&
    !hasLegacyReviewFingerprint &&
    (!generatedFor || generatedFor === agentReviewFingerprint);
  const sourceSummaries = summariesAreFresh ? summaryDoc : {};
  const agentPaths = new Set(agentFiles.map((file) => file.path));
  const reviewPaths = new Set(filesWithoutSummaries.map((file) => file.path));
  const failedFiles = summariesAreFresh
    ? failedFileRecords(summaryDoc.meta?.failedFiles).filter((failure) =>
        agentPaths.has(failure.path) || !reviewPaths.has(failure.path),
      )
    : [];
  const summaryErrors = summariesAreFresh && agentFiles.length
    ? cleanList(summaryDoc.meta?.errors)
    : [];
  const failureByPath = new Map(
    failedFiles.map((failure) => [failure.path, failure.reason]),
  );
  const emptyReviewComplete =
    agentFiles.length === 0 &&
    generatedFor === agentReviewFingerprint &&
    sourceSummaries.meta?.status === 'complete';
  const summariesAreComplete =
    summariesAreFresh &&
    failedFiles.length === 0 &&
    summaryErrors.length === 0 &&
    (emptyReviewComplete ||
      (completeChangeSummary(sourceSummaries.change) &&
        agentFiles.every((file) =>
          completeFileSummary(sourceSummaries.files?.[file.path]),
        )));
  const completedFiles = noSummaries
    ? 0
    : agentFiles.filter((file) =>
        completeFileSummary(sourceSummaries.files?.[file.path]),
      ).length;
  const storedStatus = summaryDoc.meta?.status;
  const noteStatus = noSummaries
    ? 'idle'
    : summariesAreComplete
      ? 'complete'
      : !summariesAreFresh
        ? 'stale'
        : ['generating', 'failed'].includes(storedStatus)
          ? storedStatus
          : 'idle';
  const files = filesWithoutSummaries.map((file) => ({
    ...file,
    summary: fileSummary(
      file.path,
      file.agentExcluded ? undefined : sourceSummaries.files?.[file.path],
    ),
    noteReady: Boolean(
      !file.agentExcluded &&
        completeFileSummary(sourceSummaries.files?.[file.path]),
    ),
    ...(!file.agentExcluded && failureByPath.has(file.path)
      ? { noteFailure: failureByPath.get(file.path) }
      : {}),
  }));
  const change = changeSummary(
    agentFiles.length ? sourceSummaries.change : undefined,
    target.changeDefaults,
  );
  const content = {
    repo: {
      name: remoteRepository?.name || basename(repo),
      ...(remoteRepository?.selector
        ? { repository: remoteRepository.selector }
        : {}),
      root: localWorkspace ? repo : target.remote?.url || repo,
      base: target.base,
      head: target.head,
      ...(target.branch ? { branch: target.branch } : {}),
      ...(target.baseBranch ? { baseBranch: target.baseBranch } : {}),
      ...(target.remote
        ? { remote: target.remote.name, remoteUrl: target.remote.url }
        : {}),
      target: target.target,
    },
    change,
    files,
    notes: {
      reviewFingerprint,
      agentReviewFingerprint,
      ...(generatedFor ? { generatedFor } : {}),
      fresh: summariesAreFresh,
      complete: summariesAreComplete,
      status: noteStatus,
      completedFiles,
      totalFiles: agentFiles.length,
      ...(failedFiles.length ? { failedFiles } : {}),
      ...(summaryErrors.length ? { errors: summaryErrors } : {}),
      ...(typeof summaryDoc.meta?.model === 'string'
        ? { model: summaryDoc.meta.model }
        : {}),
      ...(typeof summaryDoc.meta?.agent === 'string'
        ? { agent: summaryDoc.meta.agent }
        : {}),
      ...(typeof summaryDoc.meta?.reasoning === 'string'
        ? { reasoning: summaryDoc.meta.reasoning }
        : {}),
      ...(typeof summaryDoc.meta?.accessMode === 'string'
        ? { accessMode: summaryDoc.meta.accessMode }
        : {}),
    },
  };
  const version = createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex')
    .slice(0, 12);
  const payload = {
    version,
    generatedAt: new Date().toISOString(),
    ...content,
  };
  const old = readJson(output, null);
  if (old) {
    const prior = { ...old };
    const next = { ...payload };
    delete prior.generatedAt;
    delete next.generatedAt;
    if (JSON.stringify(prior) === JSON.stringify(next)) return false;
  }
  mkdirSync(dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(temp, output);
  return true;
}

function untrackedFileKind(stat) {
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

function fingerprintUntrackedPath(content, path) {
  const absolutePath = resolve(repo, path);
  const stat = lstatSync(absolutePath, { bigint: true });
  content.update(path);
  content.update('\0');
  content.update(untrackedFileKind(stat));
  content.update('\0');
  content.update(String(stat.size));
  content.update('\0');
  content.update(String(stat.mtimeNs));
  content.update('\0');
  if (stat.isFile()) {
    const descriptor = openSync(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (
        !opened.isFile()
        || opened.dev !== stat.dev
        || opened.ino !== stat.ino
      ) {
        throw new Error(`${path} changed while its fingerprint was read`);
      }
      content.update(readFileSync(descriptor));
    } finally {
      closeSync(descriptor);
    }
    content.update('\0');
  } else if (stat.isSymbolicLink()) {
    content.update(readlinkSync(absolutePath));
    content.update('\0');
  }
}

function fingerprint() {
  let summariesTime = '';
  if (!ignoreSummaryWatch && !noSummaries) {
    try {
      summariesTime = String(statSync(summariesPath).mtimeMs);
    } catch {}
  }
  if (remoteMode) return summariesTime;
  if (baseOption && headOption) {
    return [
      tryRepo(['rev-parse', baseOption]),
      tryRepo(['rev-parse', headOption]),
      summariesTime,
    ].join('|');
  }
  const content = createHash('sha256');
  const base = baseWorktreeOption
    ? resolveBaseWorktreeCommit(repo, baseOption)
    : 'HEAD';
  content.update(
    tryRepo(['diff', '--no-ext-diff', '--no-textconv', '--binary', base, '--']),
  );
  const untracked = tryRepo([
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ])
    .split('\0')
    .filter((path) => path && !excludedPaths.has(path))
    .sort();
  for (const path of untracked) {
    fingerprintUntrackedPath(content, path);
  }
  return [
    baseWorktreeOption ? base : undefined,
    tryRepo(['rev-parse', 'HEAD']),
    tryRepo(['status', '--porcelain=v1', '--untracked-files=all']),
    content.digest('hex'),
    summariesTime,
  ].join('|');
}

const refresh = () => {
  try {
    const wrote = build();
    console.log(wrote ? `Wrote ${output}` : 'No diff-data changes');
    return true;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return false;
  }
};

const started = refresh();
if (watching && started) {
  let last;
  let remoteWait = 0;
  let watcher;
  const stopWatching = (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    if (watcher) clearInterval(watcher);
  };
  const poll = () => {
    try {
      const next = fingerprint();
      if (last === undefined) {
        last = next;
        return true;
      }
      remoteWait += watchInterval;
      const remoteDue = remoteMode && remoteWait >= remoteRefreshInterval;
      if (next !== last || remoteDue || watchContent) {
        last = next;
        remoteWait = 0;
        if (!refresh()) {
          clearInterval(watcher);
          return false;
        }
      }
      return true;
    } catch (error) {
      stopWatching(error);
      return false;
    }
  };
  if (poll()) watcher = setInterval(poll, watchInterval);
} else if (watching) {
  process.exitCode = 1;
}
