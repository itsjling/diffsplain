import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertReasoningSupported,
  codingAgents,
  enabledCodingAgents,
} from './coding-agents.mjs';

function defineCliOptions(records) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(records).map(([name, record]) => [
        name,
        Object.freeze(record),
      ]),
    ),
  );
}

export const cliOptions = defineCliOptions({
  '--repo': { kind: 'value' },
  '--branch': { kind: 'value' },
  '--pr': { kind: 'value' },
  '--base': { kind: 'value' },
  '--head': { kind: 'value' },
  '--remote': { kind: 'value' },
  '--summaries': { kind: 'value', path: true },
  '--output': { kind: 'value', path: true },
  '--cache-dir': { kind: 'value', path: true },
  '--codex-bin': { kind: 'value', path: true },
  '--support-record-file': { kind: 'value', path: true },
  '--exclude': { kind: 'repeatable-value' },
  '--model': { kind: 'value' },
  '--reasoning': { kind: 'value' },
  '--batch-size': { kind: 'value', default: 12, min: 1, max: 50 },
  '--jobs': { kind: 'value', default: 3, min: 1, max: 8 },
  '--port': { kind: 'value', default: 2299, min: 0, max: 65_535 },
  '--host': { kind: 'value', default: 'localhost' },
  '--help': { kind: 'flag' },
  '--version': { kind: 'flag' },
  '--agent': { kind: 'agent' },
  '--no-agent': { kind: 'no-agent' },
  '--no-checkout-access': { kind: 'flag' },
  '--force': { kind: 'flag' },
  '--fast': { kind: 'flag' },
  '--worktree': { kind: 'flag' },
  '--no-browser': { kind: 'flag' },
  '--support-record': { kind: 'flag' },
});

const valueOptions = new Set(
  Object.entries(cliOptions)
    .filter(([, record]) => record.kind === 'value')
    .map(([name]) => name),
);
const flagOptions = new Set(
  Object.entries(cliOptions)
    .filter(([, record]) => record.kind === 'flag')
    .map(([name]) => name),
);
const repeatableValueOptions = new Set(
  Object.entries(cliOptions)
    .filter(([, record]) => record.kind === 'repeatable-value')
    .map(([name]) => name),
);
const pathOptions = new Set(
  Object.entries(cliOptions)
    .filter(([, record]) => record.path)
    .map(([name]) => name),
);

const batchSizeOption = cliOptions['--batch-size'];
const jobsOption = cliOptions['--jobs'];
const portOption = cliOptions['--port'];
const hostOption = cliOptions['--host'];

export const helpText = `Usage: diffsplain [REPO] [options]

Show worktree changes against HEAD (default):
  diffsplain

Commands:
  doctor [--json] [--deep]
                      Check review, agent, and pull request capabilities
  cache               Show or prune saved agent notes
  config agent [NAME|--unset]
                      Show, set, or unset the default coding agent

Targets:
  --branch NAME       Show a remote branch against its default branch
  --pr NUMBER|URL     Show a GitHub pull request
  --worktree          Show only worktree changes against HEAD
  --base REF [--head REF]
                      Compare a base with the working tree, or show an exact range

Options:
  --repo PATH|URL|OWNER/NAME
                      Repo to review (default: current repo)
  --agent NAME        Use codex, claude, copilot, cursor, or opencode
  --no-agent          Do not write agent notes
  --no-checkout-access
                      Limit agent notes to the supplied snapshot
  --exclude PATTERN   Omit matching files from automatic agent context
  --model NAME        Model for agent notes
  --reasoning LEVEL   Agent reasoning effort when supported
  --fast              Enable provider Fast mode for agent notes and chat
  --batch-size COUNT  Maximum files per agent pass (default: ${batchSizeOption.default})
  --jobs COUNT        Agent passes to run at once (default: ${jobsOption.default})
  --force             Regenerate all agent notes
  --support-record    Print a safe record if agent notes fail
  --support-record-file FILE
                      Write a safe record if agent notes fail
  --remote NAME|URL   Git remote (default: origin)
  --port NUMBER       Local page port (default: ${portOption.default})
  --host ADDRESS      Page bind address (default: ${hostOption.default})
  --no-browser        Do not open the page in a browser
  --summaries FILE    Saved agent-note file
  --output FILE       Live snapshot file
  --cache-dir PATH    Bare Git cache folder
  --codex-bin PATH    Codex executable
  -h, --help          Show this help
  -v, --version       Show the installed version

Agent choice:
  Choice order is --no-agent, --agent, then the configured default.
  Without any choice, an interactive terminal lists usable agents.

Cursor:
  Requires Cursor Agent 2026.08.11 or newer. Uses the signed-in CLI in the
  user's home. Cursor still contacts its service.

Examples:
  diffsplain
  diffsplain doctor
  diffsplain doctor --json
  diffsplain cache status
  diffsplain --repo owner/project --pr 42
  diffsplain owner/project --branch feature/search
  diffsplain --agent claude`;

function fail(message) {
  throw new Error(message);
}

function splitOption(argument) {
  if (argument === '-h') return { name: '--help', value: undefined };
  if (argument === '-v') return { name: '--version', value: undefined };
  if (!argument.startsWith('--')) return undefined;
  const separator = argument.indexOf('=');
  if (separator === -1) return { name: argument, value: undefined };
  return {
    name: argument.slice(0, separator),
    value: argument.slice(separator + 1),
  };
}

function githubRepoFromPullRequest(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/\d+(?:\/|$)/);
    if (!match) return undefined;
    return `${url.origin}/${match[1]}/${match[2].replace(/\.git$/, '')}.git`;
  } catch {
    return undefined;
  }
}

function validPullRequest(value) {
  if (/^[1-9]\d*$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      /^\/[^/]+\/[^/]+\/pull\/[1-9]\d*(?:\/|$)/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function remoteRepo(value, callerDirectory, pathExists) {
  if (pathExists(resolve(callerDirectory, value))) return undefined;
  if (
    /^(?:https?|ssh|git|file):\/\//i.test(value) ||
    /^(?:[^@/\s]+@)?[^:/\s]+:.+/.test(value)
  ) {
    return value;
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)) {
    return `https://github.com/${value.replace(/\.git$/, '')}.git`;
  }
  return undefined;
}

export function parseCliArgs(
  rawArgs,
  {
    callerDirectory = process.cwd(),
    pathExists = existsSync,
  } = {},
) {
  if (rawArgs[0] === 'config') {
    if (rawArgs[1] !== 'agent') {
      fail('Use: diffsplain config agent [NAME|--unset]');
    }
    if (rawArgs.length === 2) {
      return { config: { kind: 'show' } };
    }
    if (rawArgs.length !== 3) {
      fail('Use: diffsplain config agent [NAME|--unset]');
    }
    const value = rawArgs[2];
    if (value === '--unset') {
      return { config: { kind: 'unset' } };
    }
    if (value.startsWith('--')) {
      fail('Use: diffsplain config agent [NAME|--unset]');
    }
    if (!codingAgents.includes(value)) {
      fail(
        `Unsupported agent "${value}". Choose ${enabledCodingAgents.join(', ')}.`,
      );
    }
    return { config: { kind: 'set', agent: value } };
  }

  if (rawArgs[0] === 'doctor') {
    const options = new Set(rawArgs.slice(1));
    for (const option of options) {
      if (!['--json', '--deep'].includes(option)) {
        fail('doctor only accepts --json and --deep');
      }
    }
    if (options.size !== rawArgs.length - 1) {
      fail('doctor options can only be passed once');
    }
    return { doctor: { json: options.has('--json'), deep: options.has('--deep') } };
  }

  const options = new Map();
  const positionals = [];
  const excludePatterns = [];
  let agent;
  let agentSet = false;
  let noAgent = false;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index];
    const parsed = splitOption(argument);
    if (!parsed) {
      if (argument.startsWith('-')) fail(`Unknown option: ${argument}`);
      if (!argument) fail('Repo cannot be empty');
      positionals.push(argument);
      continue;
    }

    if (parsed.name === '--agent') {
      if (agentSet) fail('--agent was passed more than once');
      agentSet = true;
      if (parsed.value !== undefined) {
        if (!parsed.value) fail('--agent needs a value');
        agent = parsed.value;
      } else {
        const next = rawArgs[index + 1];
        if (!next || splitOption(next)) fail('--agent needs a value');
        agent = next;
        index += 1;
      }
      continue;
    }

    if (parsed.name === '--no-agent') {
      if (noAgent) fail('--no-agent was passed more than once');
      if (parsed.value !== undefined) fail('--no-agent does not take a value');
      noAgent = true;
      continue;
    }

    if (flagOptions.has(parsed.name)) {
      if (options.has(parsed.name)) {
        fail(`${parsed.name} was passed more than once`);
      }
      if (parsed.value !== undefined) {
        fail(`${parsed.name} does not take a value`);
      }
      options.set(parsed.name, true);
      continue;
    }

    const repeatable = repeatableValueOptions.has(parsed.name);
    if (!repeatable && !valueOptions.has(parsed.name)) {
      fail(`Unknown option: ${parsed.name}`);
    }
    if (!repeatable && options.has(parsed.name)) {
      fail(`${parsed.name} was passed more than once`);
    }

    let value = parsed.value;
    if (value === undefined) {
      value = rawArgs[index + 1];
      if (!value || splitOption(value)) fail(`${parsed.name} needs a value`);
      index += 1;
    }
    if (!value) fail(`${parsed.name} needs a value`);
    if (repeatable) excludePatterns.push(value);
    else options.set(parsed.name, value);
  }

  if (options.has('--help')) return { help: true };
  if (options.has('--version')) return { version: true };
  if (positionals.length > 1) fail('Pass at most one repo');
  if (positionals.length && options.has('--repo')) {
    fail('Pass the repo once, either as REPO or with --repo');
  }
  if (noAgent && agentSet) fail('--agent and --no-agent cannot be used together');
  if (noAgent && options.has('--fast')) {
    fail('--fast and --no-agent cannot be used together');
  }
  if (noAgent && options.has('--summaries')) {
    fail('--no-agent cannot be used with --summaries');
  }
  if (
    noAgent &&
    (options.has('--support-record') ||
      options.has('--support-record-file'))
  ) {
    fail('--no-agent cannot be used with a support record');
  }
  if (
    options.has('--support-record') &&
    options.has('--support-record-file')
  ) {
    fail('Pass either --support-record or --support-record-file, not both');
  }
  if (!noAgent && agent && !codingAgents.includes(agent)) {
    fail(
      `Unsupported agent "${agent}". Choose ${enabledCodingAgents.join(', ')}.`,
    );
  }

  const branch = options.get('--branch');
  const pullRequest = options.get('--pr');
  const base = options.get('--base');
  const head = options.get('--head');
  const worktree = options.has('--worktree');
  if (branch && pullRequest) fail('--branch and --pr cannot be used together');
  if (pullRequest && (base || head)) {
    fail('--pr cannot be used with --base or --head');
  }
  if (branch && head) fail('--branch cannot be used with --head');
  if (worktree && (branch || pullRequest || base || head)) {
    fail('--worktree cannot be combined with another target');
  }
  if (!branch && !pullRequest && !worktree && head && !base) {
    fail('--head must be used with --base');
  }
  if (pullRequest && !validPullRequest(pullRequest)) {
    fail('--pr must be a positive number or a pull request URL');
  }

  const repoArgument = positionals[0] || options.get('--repo');
  let remote = options.get('--remote');
  let repo = callerDirectory;
  if (repoArgument) {
    const selectedRemote = remoteRepo(
      repoArgument,
      callerDirectory,
      pathExists,
    );
    if (selectedRemote) {
      if (remote) fail('--repo URL and --remote cannot be used together');
      remote = selectedRemote;
    } else {
      repo = resolve(callerDirectory, repoArgument);
    }
  }

  const pullRequestRemote = pullRequest
    ? githubRepoFromPullRequest(pullRequest)
    : undefined;
  if (pullRequestRemote && !repoArgument && !remote) remote = pullRequestRemote;
  if (repoArgument && remoteRepo(repoArgument, callerDirectory, pathExists)) {
    if (!branch && !pullRequest) {
      fail('A remote repo needs --branch or --pr');
    }
  }

  const commonArgs = ['--repo', repo];
  if (pullRequest) commonArgs.push('--pr', pullRequest);
  if (branch) commonArgs.push('--branch', branch);
  if (worktree) commonArgs.push('--worktree');
  if (!pullRequest && !branch && !worktree && !base && !head) {
    commonArgs.push('--worktree');
  }
  if (base) commonArgs.push('--base', base);
  if (head) commonArgs.push('--head', head);
  if (remote) commonArgs.push('--remote', remote);

  for (const name of ['--summaries', '--output', '--cache-dir']) {
    const value = options.get(name);
    if (value) {
      commonArgs.push(
        name,
        pathOptions.has(name) ? resolve(callerDirectory, value) : value,
      );
    }
  }

  const feedArgs = [...commonArgs];
  for (const pattern of excludePatterns) {
    feedArgs.push(`--exclude=${pattern}`);
  }
  const supportRecordFile = options.get('--support-record-file');
  if (supportRecordFile) {
    feedArgs.push(
      '--exclude-output',
      resolve(callerDirectory, supportRecordFile),
    );
  }
  const agentArgs = [...commonArgs];
  for (const pattern of excludePatterns) {
    agentArgs.push(`--exclude=${pattern}`);
  }
  if (options.has('--force')) agentArgs.push('--force');
  if (options.has('--fast')) agentArgs.push('--fast');
  for (const name of [
    '--codex-bin',
    '--model',
    '--reasoning',
  ]) {
    const value = options.get(name);
    if (value) {
      agentArgs.push(
        name,
        pathOptions.has(name) ? resolve(callerDirectory, value) : value,
      );
    }
  }
  if (!noAgent) {
    if (options.has('--no-checkout-access')) {
      agentArgs.push('--no-checkout-access');
    }
    for (const name of ['--batch-size', '--jobs']) {
      agentArgs.push(
        name,
        options.get(name) || String(cliOptions[name].default),
      );
    }
  }
  if (supportRecordFile) {
    agentArgs.push(
      '--support-record-file',
      resolve(callerDirectory, supportRecordFile),
    );
  }
  if (options.has('--support-record')) {
    agentArgs.push('--support-record');
  }

  const reasoning = options.get('--reasoning');
  if (
    reasoning &&
    !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(
      reasoning,
    )
  ) {
    fail(
      '--reasoning must be minimal, low, medium, high, or xhigh',
    );
  }
  if (reasoning && agent) assertReasoningSupported(agent, reasoning);
  const batchSize = options.get('--batch-size');
  if (
    batchSize &&
    (
      !/^[1-9]\d*$/.test(batchSize) ||
      Number(batchSize) < batchSizeOption.min ||
      Number(batchSize) > batchSizeOption.max
    )
  ) {
    fail(
      `--batch-size must be a number from ${batchSizeOption.min} to ${batchSizeOption.max}`,
    );
  }
  const jobs = options.get('--jobs');
  if (
    jobs &&
    (
      !/^[1-9]\d*$/.test(jobs) ||
      Number(jobs) < jobsOption.min ||
      Number(jobs) > jobsOption.max
    )
  ) {
    fail(
      `--jobs must be a number from ${jobsOption.min} to ${jobsOption.max}`,
    );
  }

  const portValue = options.get('--port') || String(portOption.default);
  if (
    !/^\d+$/.test(portValue) ||
    Number(portValue) < portOption.min ||
    Number(portValue) > portOption.max
  ) {
    fail(
      `--port must be a number from ${portOption.min} to ${portOption.max}`,
    );
  }
  const host = (options.get('--host') || hostOption.default).replace(
    /^\[|\]$/g,
    '',
  );

  return {
    help: false,
    version: false,
    agentEnabled: !noAgent,
    agent,
    noCheckoutAccess: options.has('--no-checkout-access'),
    excludePatterns,
    model: options.get('--model'),
    reasoning,
    codexBin: options.get('--codex-bin'),
    feedArgs,
    agentArgs,
    supportRecord: options.has('--support-record'),
    supportRecordFile: supportRecordFile
      ? resolve(callerDirectory, supportRecordFile)
      : undefined,
    port: Number(portValue),
    portWasPassed: options.has('--port'),
    host,
    browserEnabled: !options.has('--no-browser'),
    forceSummaryRegeneration: options.has('--force'),
    fast: options.has('--fast'),
  };
}
