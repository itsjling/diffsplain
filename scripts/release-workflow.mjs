#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = 'https://registry.npmjs.org';
const packageName = 'diffsplain';
const tarball = '.cache/diffsplain-release.tgz';
const receiptFile = '.cache/diffsplain-release.json';
const planFile = '.cache/diffsplain-release-plan.json';
const bundleFile = '.cache/diffsplain-release.bundle';
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

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}

async function packageManifest() {
  return readJson('package.json');
}

async function fileDigest(path, algorithm, encoding) {
  const contents = await readFile(resolve(root, path));
  return createHash(algorithm).update(contents).digest(encoding);
}

async function localTarballIntegrity() {
  return `sha512-${await fileDigest(tarball, 'sha512', 'base64')}`;
}

async function localTarballSha256() {
  return fileDigest(tarball, 'sha256', 'hex');
}

function observedState(version, manifestVersion) {
  const tag = `v${version}`;
  const headCommit = gitOutput(['rev-parse', 'HEAD']);
  const remoteMainCommit = gitOutput(['rev-parse', 'refs/remotes/origin/main']);
  const localTagCommit = optionalGitCommit(`refs/tags/${tag}`);
  const publishedTagCommit = remoteTagCommit(tag);
  const pushedRelease =
    manifestVersion === version &&
    localTagCommit === headCommit &&
    publishedTagCommit === headCommit &&
    remoteMainCommit === headCommit;
  return {
    version,
    packageVersion: manifestVersion,
    tag,
    headCommit,
    baseCommit: pushedRelease ? gitOutput(['rev-parse', 'HEAD^']) : headCommit,
    remoteMainCommit,
    localTagCommit,
    remoteTagCommit: publishedTagCommit,
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

function validateWorkflowIdentity(env) {
  const expected = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: workflowRef,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (env[name] !== value) {
      throw new Error(`Refusing release workflow: ${name} is not ${value}.`);
    }
  }
  if (!env.GITHUB_SHA) {
    throw new Error('Refusing release workflow: GITHUB_SHA is missing.');
  }
  for (const name of ['NODE_AUTH_TOKEN', 'NPM_TOKEN']) {
    if (env[name] !== undefined) {
      throw new Error(`Refusing release workflow while ${name} is set.`);
    }
  }
  return { dispatchCommit: env.GITHUB_SHA };
}

export function validatePrepareContext(env) {
  const context = validateWorkflowIdentity(env);
  for (const name of [
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  ]) {
    if (env[name] !== undefined) {
      throw new Error(`Refusing unprivileged preparation while ${name} is set.`);
    }
  }
  return context;
}

export function validateOidcContext(env) {
  const context = validateWorkflowIdentity(env);
  for (const name of [
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  ]) {
    if (!env[name]) {
      throw new Error(`Refusing npm trusted publishing: ${name} is missing.`);
    }
  }
  return context;
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
    remoteTagCommit: publishedTagCommit,
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
    publishedTagCommit === null &&
    publishedIntegrity === null
  ) {
    return shape('create', null);
  }

  const pushedRelease =
    packageVersion === version &&
    localTagCommit === headCommit &&
    publishedTagCommit === headCommit &&
    remoteMainCommit === headCommit;
  if (pushedRelease) {
    return shape(publishedIntegrity === null ? 'resume' : 'complete', publishedIntegrity);
  }

  throw new Error(
    `Release ${version} is in a mixed state; main, package.json, ${tag}, and npm must agree before continuing.`,
  );
}

export function validateDispatchCommit(state, dispatchCommit) {
  const accepted =
    dispatchCommit === state.headCommit ||
    (state.mode !== 'create' && dispatchCommit === state.baseCommit);
  if (!accepted) {
    throw new Error(
      'The checked-out release state does not match the workflow dispatch commit.',
    );
  }
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

function registryValue(specifier, field) {
  const result = npm(
    ['view', specifier, field, '--json', '--registry', registry],
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

function registryIntegrity(name, version) {
  return registryValue(`${name}@${version}`, 'dist.integrity');
}

function registryVersion(name, version) {
  return registryValue(`${name}@${version}`, 'version');
}

const defaults = {
  assertCleanMain,
  bundleRelease: (tag) =>
    git(['bundle', 'create', bundleFile, 'refs/heads/main', `refs/tags/${tag}`]),
  createVersion: (version) => run('pnpm', ['version', version]),
  fetchMain,
  importBundle: (tag) => {
    git(['bundle', 'verify', bundleFile]);
    git([
      'fetch',
      '--no-tags',
      bundleFile,
      'refs/heads/main:refs/remotes/release-artifact/main',
    ]);
    git([
      'fetch',
      '--no-tags',
      bundleFile,
      `refs/tags/${tag}:refs/tags/${tag}`,
    ]);
  },
  localTarballIntegrity,
  localTarballSha256,
  observe: async (version) => {
    const manifest = await packageManifest();
    if (manifest.name !== packageName) {
      throw new Error(`Expected package ${packageName}, but found ${manifest.name}.`);
    }
    return {
      ...observedState(version, manifest.version),
      registryIntegrity: registryIntegrity(packageName, version),
    };
  },
  publish: (version) =>
    npm([
      'publish',
      tarball,
      '--ignore-scripts',
      '--access',
      'public',
      '--registry',
      registry,
      ...(version.includes('-') ? ['--tag', 'next'] : []),
    ]),
  pushRelease: (commit, tag) =>
    git([
      'push',
      '--atomic',
      'origin',
      `${commit}:refs/heads/main`,
      `refs/tags/${tag}:refs/tags/${tag}`,
    ]),
  readArtifactCommit: () =>
    gitOutput(['rev-parse', 'refs/remotes/release-artifact/main']),
  readCommitManifest: (commit) =>
    JSON.parse(gitOutput(['show', `${commit}:package.json`])),
  readCommitParents: (commit) =>
    gitOutput(['rev-list', '--parents', '-n', '1', commit]).split(/\s+/).slice(1),
  readHead: () => gitOutput(['rev-parse', 'HEAD']),
  readLocalTag: (tag) => optionalGitCommit(`refs/tags/${tag}`),
  readPlan: () => readJson(planFile),
  readReceipt: () => readJson(receiptFile),
  readRemoteMain: () => gitOutput(['rev-parse', 'refs/remotes/origin/main']),
  readRemoteTag: remoteTagCommit,
  registryIntegrity,
  registryVersion,
  verifyRelease: async () => {
    const { verifyRelease } = await import('./release.mjs');
    return verifyRelease();
  },
  wait,
  writePlan: (plan) =>
    writeFile(resolve(root, planFile), `${JSON.stringify(plan, null, 2)}\n`, 'utf8'),
};

function dependencies(overrides) {
  return { ...defaults, ...overrides };
}

function validateArtifactPlan(plan, receipt, version, dispatchCommit) {
  const expected = {
    schemaVersion: 1,
    package: packageName,
    version,
    tag: `v${version}`,
    dispatchCommit,
    tarball,
    bundle: bundleFile,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (plan[key] !== value) {
      throw new Error(`Release artifact is invalid: ${key} does not match.`);
    }
  }
  for (const key of ['package', 'version', 'tag', 'tarball', 'sha256']) {
    if (receipt[key] !== plan[key]) {
      throw new Error(`Release artifact is invalid: receipt ${key} does not match.`);
    }
  }
  if (receipt.commit !== plan.releaseCommit) {
    throw new Error('Release artifact is invalid: receipt commit does not match.');
  }
  if (!['create', 'resume', 'complete'].includes(plan.mode)) {
    throw new Error('Release artifact is invalid: mode is not recognized.');
  }
  for (const key of ['baseCommit', 'releaseCommit']) {
    if (typeof plan[key] !== 'string' || !/^[0-9a-f]{40}$/.test(plan[key])) {
      throw new Error(`Release artifact is invalid: ${key} is not a commit.`);
    }
  }
}

async function verifyArtifact(deps, plan) {
  if ((await deps.localTarballSha256()) !== plan.sha256) {
    throw new Error('Release artifact is invalid: tarball SHA-256 does not match.');
  }
  const integrity = await deps.localTarballIntegrity();
  if (integrity !== plan.sha512) {
    throw new Error('Release artifact is invalid: tarball SHA-512 does not match.');
  }
  if (deps.readArtifactCommit() !== plan.releaseCommit) {
    throw new Error('Release artifact is invalid: bundle commit does not match.');
  }
  if (deps.readLocalTag(plan.tag) !== plan.releaseCommit) {
    throw new Error('Release artifact is invalid: bundle tag does not match.');
  }
  const parents = deps.readCommitParents(plan.releaseCommit);
  if (parents.length !== 1 || parents[0] !== plan.baseCommit) {
    throw new Error('Release artifact is invalid: release parent does not match.');
  }
  const manifest = deps.readCommitManifest(plan.releaseCommit);
  if (manifest.name !== packageName || manifest.version !== plan.version) {
    throw new Error('Release artifact is invalid: package identity does not match.');
  }
}

export async function prepareReleaseWorkflow(versionInput, overrides = {}) {
  const version = validateExactVersion(versionInput);
  const deps = dependencies(overrides);
  const context = overrides.context ?? validatePrepareContext(process.env);

  deps.assertCleanMain();
  deps.fetchMain();
  const observed = await deps.observe(version);
  let state = classifyReleaseState(observed);
  validateDispatchCommit(state, context.dispatchCommit);

  if (state.mode === 'create') {
    deps.createVersion(version);
    const releaseCommit = deps.readHead();
    if (deps.readLocalTag(state.tag) !== releaseCommit) {
      throw new Error(`${state.tag} was not created on the version commit.`);
    }
    state = { ...state, headCommit: releaseCommit };
  }

  const receipt = await deps.verifyRelease();
  deps.fetchMain();
  const currentRemoteMain = deps.readRemoteMain();
  const currentRemoteTag = deps.readRemoteTag(state.tag);
  if (state.mode === 'create') {
    if (currentRemoteMain !== state.baseCommit || currentRemoteTag !== null) {
      throw new Error('origin/main or the release tag changed while the release was verified.');
    }
  } else if (
    currentRemoteMain !== state.headCommit ||
    currentRemoteTag !== state.headCommit
  ) {
    throw new Error('The pushed release commit or tag changed while the release was verified.');
  }

  deps.bundleRelease(state.tag);
  const plan = {
    schemaVersion: 1,
    package: packageName,
    version,
    tag: state.tag,
    mode: state.mode,
    dispatchCommit: context.dispatchCommit,
    baseCommit: state.baseCommit,
    releaseCommit: state.headCommit,
    tarball,
    bundle: bundleFile,
    sha256: receipt.sha256,
    sha512: await deps.localTarballIntegrity(),
  };
  await deps.writePlan(plan);
  return plan;
}

async function verifyPublishedVersion(deps, version) {
  const delays = [0, 1_000, 2_000, 4_000];
  let lastValue = null;
  for (const delay of delays) {
    if (delay > 0) await deps.wait(delay);
    lastValue = deps.registryVersion(packageName, version);
    if (lastValue === version) return;
  }
  throw new Error(
    `npm returned ${lastValue || 'no version'} after publishing ${packageName}@${version}.`,
  );
}

export async function finalizeReleaseWorkflow(versionInput, overrides = {}) {
  const version = validateExactVersion(versionInput);
  const deps = dependencies(overrides);
  const context = overrides.context ?? validateOidcContext(process.env);

  deps.assertCleanMain();
  deps.fetchMain();
  const plan = await deps.readPlan();
  const receipt = await deps.readReceipt();
  validateArtifactPlan(plan, receipt, version, context.dispatchCommit);
  deps.importBundle(plan.tag);
  await verifyArtifact(deps, plan);

  const remoteMain = deps.readRemoteMain();
  const remoteTag = deps.readRemoteTag(plan.tag);
  if (remoteMain === plan.baseCommit && remoteTag === null) {
    deps.pushRelease(plan.releaseCommit, plan.tag);
  } else if (
    remoteMain !== plan.releaseCommit ||
    remoteTag !== plan.releaseCommit
  ) {
    throw new Error(
      `Release ${version} is in a mixed state; main and ${plan.tag} must agree before continuing.`,
    );
  }

  const publishedIntegrity = deps.registryIntegrity(packageName, version);
  if (publishedIntegrity !== null) {
    requireMatchingIntegrity(plan.sha512, publishedIntegrity);
    return { ...plan, mode: 'complete', registryIntegrity: publishedIntegrity };
  }

  deps.publish(version);
  await verifyPublishedVersion(deps, version);
  return { ...plan, registryIntegrity: null };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, version, ...rest] = process.argv.slice(2);
    if (rest.length > 0 || !['prepare', 'finalize'].includes(command) || !version) {
      throw new Error(
        'Usage: node scripts/release-workflow.mjs <prepare|finalize> <exact-version>',
      );
    }
    const result =
      command === 'prepare'
        ? await prepareReleaseWorkflow(version)
        : await finalizeReleaseWorkflow(version);
    console.log(
      `${command === 'prepare' ? 'Prepared' : 'Published'} ${packageName}@${result.version} from ${result.releaseCommit}.`,
    );
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 2;
  }
}
