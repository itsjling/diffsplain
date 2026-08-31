#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishRelease, verifyRelease } from './release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = 'https://registry.npmjs.org';
const tarball = '.cache/diffsplain-release.tgz';
const repository = 'itsjling/diffsplain';
const workflowRef =
  'itsjling/diffsplain/.github/workflows/release.yml@refs/heads/main';
const semverIdentifier =
  '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const exactVersionPattern = new RegExp(
  `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${semverIdentifier}(?:\\.${semverIdentifier})*)?$`,
);

function run(
  command,
  args,
  { allowFailure = false, capture = false, env } = {},
) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? 'pipe' : 'inherit',
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (!allowFailure && status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${status}.`);
  }
  return {
    status,
    stdout: capture ? result.stdout.trim() : '',
    stderr: capture ? result.stderr.trim() : '',
  };
}

function git(args, options = {}) {
  return run('git', args, { capture: true, ...options });
}

function gitOutput(args) {
  return git(args).stdout;
}

function optionalGitCommit(ref) {
  const result = git(['rev-parse', '--verify', `${ref}^{commit}`], {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout : null;
}

function remoteTagCommit(tag) {
  const result = git([
    'ls-remote',
    '--tags',
    'origin',
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  const lines = result.stdout.split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  return (peeled ?? lines[0]).split(/\s+/)[0];
}

function npm(args, options = {}) {
  return run('corepack', ['npm@11.5.1', ...args], {
    ...options,
    env: { COREPACK_ENABLE_PROJECT_SPEC: '0', ...options.env },
  });
}

function registryIntegrity(name, version) {
  const result = npm(
    ['view', `${name}@${version}`, 'dist.integrity', '--json', '--registry', registry],
    { allowFailure: true, capture: true },
  );
  if (result.status === 0) {
    const value = JSON.parse(result.stdout);
    return typeof value === 'string' && value ? value : null;
  }
  if (/E404|404 Not Found|No match found/.test(`${result.stdout}\n${result.stderr}`)) {
    return null;
  }
  throw new Error(result.stderr || 'Could not check the npm registry.');
}

async function packageManifest() {
  return JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
}

async function localTarballIntegrity() {
  const contents = await readFile(resolve(root, tarball));
  return sha512Integrity(contents);
}

function fetchMain() {
  git([
    'fetch',
    '--no-tags',
    'origin',
    'refs/heads/main:refs/remotes/origin/main',
  ]);
}

function assertCleanMain() {
  const branch = gitOutput(['branch', '--show-current']);
  if (branch !== 'main') {
    throw new Error(`The release workflow must run from main, not ${branch || 'a detached HEAD'}.`);
  }
  if (gitOutput(['status', '--porcelain'])) {
    throw new Error('The release workflow requires a clean working tree.');
  }
}

function observedState(version, packageVersion) {
  const tag = `v${version}`;
  const headCommit = gitOutput(['rev-parse', 'HEAD']);
  return {
    version,
    packageVersion,
    tag,
    headCommit,
    baseCommit: headCommit,
    remoteMainCommit: gitOutput(['rev-parse', 'refs/remotes/origin/main']),
    localTagCommit: optionalGitCommit(`refs/tags/${tag}`),
    remoteTagCommit: remoteTagCommit(tag),
  };
}

export function validateExactVersion(value) {
  if (typeof value !== 'string' || !exactVersionPattern.test(value)) {
    throw new Error(
      'Release version must be an exact canonical SemVer without build metadata.',
    );
  }
  return value;
}

export function validateOidcContext(env) {
  const expected = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: workflowRef,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (env[name] !== value) {
      throw new Error(`Refusing npm trusted publishing: ${name} is not ${value}.`);
    }
  }
  for (const name of [
    'GITHUB_SHA',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  ]) {
    if (!env[name]) {
      throw new Error(`Refusing npm trusted publishing: ${name} is missing.`);
    }
  }
  for (const name of ['NODE_AUTH_TOKEN', 'NPM_TOKEN']) {
    if (env[name] !== undefined) {
      throw new Error(`Refusing npm trusted publishing while ${name} is set.`);
    }
  }
  return {
    account: 'GitHub Actions OIDC',
    dispatchCommit: env.GITHUB_SHA,
  };
}

function parseVersion(version) {
  validateExactVersion(version);
  const prereleaseIndex = version.indexOf('-');
  const core = prereleaseIndex === -1 ? version : version.slice(0, prereleaseIndex);
  const prerelease =
    prereleaseIndex === -1 ? null : version.slice(prereleaseIndex + 1);
  return {
    core: core.split('.').map(BigInt),
    prerelease: prerelease?.split('.') ?? null,
  };
}

function compareIdentifiers(left, right) {
  const leftNumber = /^\d+$/.test(left);
  const rightNumber = /^\d+$/.test(right);
  if (leftNumber && rightNumber) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
  }
  if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareExactVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] < rightVersion.core[index] ? -1 : 1;
    }
  }
  if (leftVersion.prerelease === null || rightVersion.prerelease === null) {
    if (leftVersion.prerelease === rightVersion.prerelease) return 0;
    return leftVersion.prerelease === null ? 1 : -1;
  }
  const length = Math.max(
    leftVersion.prerelease.length,
    rightVersion.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    const difference = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function classifyReleaseState(observed) {
  const {
    version,
    packageVersion,
    tag,
    headCommit,
    baseCommit,
    remoteMainCommit,
    localTagCommit,
    remoteTagCommit,
    registryIntegrity: publishedIntegrity = null,
  } = observed;
  const shape = (mode, integrity) => ({
    mode,
    version,
    tag,
    headCommit,
    baseCommit,
    remoteMainCommit,
    registryIntegrity: integrity,
  });

  if (
    packageVersion !== version &&
    compareExactVersions(version, packageVersion) > 0 &&
    headCommit === remoteMainCommit &&
    localTagCommit === null &&
    remoteTagCommit === null &&
    publishedIntegrity === null
  ) {
    return shape('create', null);
  }

  const pushedRelease =
    packageVersion === version &&
    localTagCommit === headCommit &&
    remoteTagCommit === headCommit &&
    remoteMainCommit === headCommit;
  if (pushedRelease) {
    return shape(publishedIntegrity === null ? 'resume' : 'complete', publishedIntegrity);
  }

  throw new Error(
    `Release ${version} is in a mixed state; main, package.json, ${tag}, and npm must agree before continuing.`,
  );
}

export function sha512Integrity(contents) {
  return `sha512-${createHash('sha512').update(contents).digest('base64')}`;
}

export function requireMatchingIntegrity(localIntegrity, publishedIntegrity) {
  if (localIntegrity !== publishedIntegrity) {
    throw new Error(
      `npm integrity mismatch: verified ${localIntegrity}, registry has ${publishedIntegrity}.`,
    );
  }
}

const defaults = {
  assertCleanMain,
  classify: classifyReleaseState,
  createVersion: (version) => run('pnpm', ['version', version]),
  fetchMain,
  localTarballIntegrity,
  observe: async (version) => {
    const pkg = await packageManifest();
    const gitState = observedState(version, pkg.version);
    return {
      ...gitState,
      registryIntegrity: registryIntegrity(pkg.name, version),
      packageName: pkg.name,
    };
  },
  publishRelease,
  pushRelease: (tag) =>
    git([
      'push',
      '--atomic',
      'origin',
      'HEAD:refs/heads/main',
      `refs/tags/${tag}:refs/tags/${tag}`,
    ]),
  readHead: () => gitOutput(['rev-parse', 'HEAD']),
  readLocalTag: (tag) => optionalGitCommit(`refs/tags/${tag}`),
  readRemoteMain: () => gitOutput(['rev-parse', 'refs/remotes/origin/main']),
  readRemoteTag: remoteTagCommit,
  registryIntegrity,
  validateContext: validateOidcContext,
  verifyRelease,
};

function dependencies(overrides) {
  return { ...defaults, ...overrides };
}

async function requirePublishedTarball(deps, expectedIntegrity) {
  const localIntegrity = await deps.localTarballIntegrity();
  requireMatchingIntegrity(localIntegrity, expectedIntegrity);
}

export async function runReleaseWorkflow(versionInput, overrides = {}) {
  const version = validateExactVersion(versionInput);
  const deps = dependencies(overrides);
  const oidc = deps.validateContext(process.env);

  deps.assertCleanMain();
  deps.fetchMain();
  const observed = await deps.observe(version);
  if (observed.headCommit !== oidc.dispatchCommit) {
    throw new Error(
      'The checked-out main commit does not match the workflow dispatch commit.',
    );
  }
  let state = deps.classify(observed);

  if (state.mode === 'create') {
    deps.createVersion(version);
    const headCommit = deps.readHead();
    if (deps.readLocalTag(state.tag) !== headCommit) {
      throw new Error(`${state.tag} was not created on the version commit.`);
    }
    state = { ...state, headCommit };
  }

  await deps.verifyRelease();
  deps.fetchMain();
  const currentRemoteMain = deps.readRemoteMain();
  const currentRemoteTag = deps.readRemoteTag(state.tag);

  if (state.mode === 'create') {
    if (currentRemoteMain !== state.baseCommit || currentRemoteTag !== null) {
      throw new Error('origin/main or the release tag changed while the release was verified.');
    }
    deps.pushRelease(state.tag);
  } else if (
    currentRemoteMain !== state.headCommit ||
    currentRemoteTag !== state.headCommit
  ) {
    throw new Error('The pushed release commit or tag changed while the release was verified.');
  }

  const publishedIntegrity = deps.registryIntegrity(observed.packageName, version);
  if (publishedIntegrity !== null) {
    await requirePublishedTarball(deps, publishedIntegrity);
    return {
      ...state,
      mode: 'complete',
      remoteMainCommit: currentRemoteMain,
      registryIntegrity: publishedIntegrity,
    };
  }

  await deps.publishRelease(version, {
    registryVersionExists: () => false,
    requireNpmLogin: () => oidc.account,
  });
  return {
    ...state,
    remoteMainCommit: state.mode === 'create' ? state.headCommit : currentRemoteMain,
    registryIntegrity: null,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) {
      throw new Error('Usage: node scripts/release-workflow.mjs <exact-version>');
    }
    const result = await runReleaseWorkflow(args[0]);
    console.log(
      `${result.mode === 'complete' ? 'Confirmed' : 'Published'} diffsplain@${result.version} from ${result.headCommit}.`,
    );
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 2;
  }
}
