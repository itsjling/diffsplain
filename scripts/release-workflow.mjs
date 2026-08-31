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

function commandOptions(capture, env) {
  return {
    cwd: root,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? 'pipe' : 'inherit',
    env: env ? { ...process.env, ...env } : process.env,
  };
}

function commandOutput(result, capture) {
  return {
    status: result.status ?? 1,
    stdout: capture ? result.stdout.trim() : '',
    stderr: capture ? result.stderr.trim() : '',
  };
}

function run(command, args, options = {}) {
  const { allowFailure = false, capture = false, env } = options;
  const result = spawnSync(command, args, commandOptions(capture, env));
  if (result.error) throw result.error;
  const output = commandOutput(result, capture);
  if (!allowFailure && output.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${output.status}.`,
    );
  }
  return output;
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

function assertCleanCheckout() {
  if (gitOutput(['status', '--porcelain'])) {
    throw new Error('The release workflow requires a clean working tree.');
  }
}

function assertCleanMain() {
  const branch = gitOutput(['branch', '--show-current']);
  if (branch !== 'main') {
    throw new Error(`The release workflow must run from main, not ${branch || 'a detached HEAD'}.`);
  }
  assertCleanCheckout();
}

export function requirePinnedCommit(headCommit, dispatchCommit) {
  if (headCommit !== dispatchCommit) {
    throw new Error('The privileged checkout does not match the workflow dispatch commit.');
  }
}

function assertPinnedCheckout(dispatchCommit) {
  requirePinnedCommit(gitOutput(['rev-parse', 'HEAD']), dispatchCommit);
  assertCleanCheckout();
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
  const pushedRelease = allEqual([
    [manifestVersion, version],
    [localTagCommit, headCommit],
    [publishedTagCommit, headCommit],
    [remoteMainCommit, headCommit],
  ]);
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

function allEqual(pairs) {
  return pairs.every(([actual, expected]) => actual === expected);
}

export function validateExactVersion(value) {
  if (typeof value !== 'string' || !exactVersionPattern.test(value)) {
    throw new Error(
      'Release version must be an exact canonical SemVer without build metadata.',
    );
  }
  return value;
}

function requireEnvironment(env, expected) {
  for (const [name, value] of Object.entries(expected)) {
    if (env[name] !== value) {
      throw new Error(`Refusing release workflow: ${name} is not ${value}.`);
    }
  }
}

function rejectEnvironment(env, names, reason) {
  for (const name of names) {
    if (env[name] !== undefined) {
      throw new Error(`${reason} while ${name} is set.`);
    }
  }
}

function validateWorkflowIdentity(env) {
  const expected = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: workflowRef,
  };
  requireEnvironment(env, expected);
  if (!env.GITHUB_SHA) {
    throw new Error('Refusing release workflow: GITHUB_SHA is missing.');
  }
  rejectEnvironment(
    env,
    ['NODE_AUTH_TOKEN', 'NPM_TOKEN'],
    'Refusing release workflow',
  );
  return { dispatchCommit: env.GITHUB_SHA };
}

export function validatePrepareContext(env) {
  const context = validateWorkflowIdentity(env);
  rejectEnvironment(
    env,
    ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'],
    'Refusing unprivileged preparation',
  );
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

function compareValues(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareIdentifiers(left, right) {
  const leftNumber = /^\d+$/.test(left);
  const rightNumber = /^\d+$/.test(right);
  if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
  if (leftNumber) return compareValues(BigInt(left), BigInt(right));
  return compareValues(left, right);
}

function compareLists(left, right, compare) {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = compare(left[index], right[index]);
    if (difference !== 0) return difference;
  }
  return Math.sign(left.length - right.length);
}

function comparePrereleases(left, right) {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return compareLists(left, right, compareIdentifiers);
}

export function compareExactVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  const coreDifference = compareLists(
    leftVersion.core,
    rightVersion.core,
    compareValues,
  );
  if (coreDifference !== 0) {
    return coreDifference;
  }
  return comparePrereleases(leftVersion.prerelease, rightVersion.prerelease);
}

function releaseStateShape(observed, mode) {
  return {
    mode,
    version: observed.version,
    tag: observed.tag,
    headCommit: observed.headCommit,
    baseCommit: observed.baseCommit,
    remoteMainCommit: observed.remoteMainCommit,
    registryIntegrity: observed.registryIntegrity ?? null,
  };
}

function isFreshRelease(observed) {
  return allEqual([
    [compareExactVersions(observed.version, observed.packageVersion) > 0, true],
    [observed.headCommit, observed.remoteMainCommit],
    [observed.localTagCommit, null],
    [observed.remoteTagCommit, null],
    [observed.registryIntegrity ?? null, null],
  ]);
}

function isPushedRelease(observed) {
  return allEqual([
    [observed.packageVersion, observed.version],
    [observed.localTagCommit, observed.headCommit],
    [observed.remoteTagCommit, observed.headCommit],
    [observed.remoteMainCommit, observed.headCommit],
  ]);
}

export function classifyReleaseState(observed) {
  if (isFreshRelease(observed)) return releaseStateShape(observed, 'create');
  if (isPushedRelease(observed)) {
    const mode = observed.registryIntegrity == null ? 'resume' : 'complete';
    return releaseStateShape(observed, mode);
  }

  throw new Error(
    `Release ${observed.version} is in a mixed state; main, package.json, ${observed.tag}, and npm must agree before continuing.`,
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

export function parseRegistryValue(output) {
  const value = JSON.parse(output);
  if (typeof value !== 'string') {
    throw new Error('npm registry returned an unexpected response.');
  }
  return value;
}

function registryResultValue(result) {
  if (result.status === 0) return parseRegistryValue(result.stdout);
  if (/E404|404 Not Found|No match found/.test(`${result.stdout}\n${result.stderr}`)) {
    return null;
  }
  throw new Error(result.stderr || 'Could not check the npm registry.');
}

function registryValue(specifier, field) {
  const result = npm(
    ['view', specifier, field, '--json', '--registry', registry],
    { allowFailure: true, capture: true },
  );
  return registryResultValue(result);
}

function registryIntegrity(name, version) {
  return registryValue(`${name}@${version}`, 'dist.integrity');
}

function registryVersion(name, version) {
  return registryValue(`${name}@${version}`, 'version');
}

const defaults = {
  assertCleanMain,
  assertPinnedCheckout,
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

function requireMatchingFields(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(`Release artifact is invalid: ${label}${key} does not match.`);
    }
  }
}

function requireCommit(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`Release artifact is invalid: ${label} is not a commit.`);
  }
}

function hasValidDispatchState(plan) {
  if (plan.mode === 'create') return plan.dispatchCommit === plan.baseCommit;
  return [plan.baseCommit, plan.releaseCommit].includes(plan.dispatchCommit);
}

function validateArtifactPlan(plan, receipt, version, dispatchCommit) {
  requireMatchingFields(plan, {
    schemaVersion: 1,
    package: packageName,
    version,
    tag: `v${version}`,
    dispatchCommit,
    tarball,
    bundle: bundleFile,
  }, '');
  requireMatchingFields(receipt, {
    package: plan.package,
    version: plan.version,
    tag: plan.tag,
    commit: plan.releaseCommit,
    tarball: plan.tarball,
    sha256: plan.sha256,
  }, 'receipt ');
  if (!['create', 'resume', 'complete'].includes(plan.mode)) {
    throw new Error('Release artifact is invalid: mode is not recognized.');
  }
  requireCommit(plan.baseCommit, 'baseCommit');
  requireCommit(plan.releaseCommit, 'releaseCommit');
  if (!hasValidDispatchState(plan)) {
    throw new Error('Release artifact is invalid: dispatch commit does not match its release state.');
  }
}

function requireArtifactValue(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Release artifact is invalid: ${label} does not match.`);
  }
}

async function verifyArtifact(deps, plan) {
  requireArtifactValue(
    await deps.localTarballSha256(),
    plan.sha256,
    'tarball SHA-256',
  );
  requireArtifactValue(
    await deps.localTarballIntegrity(),
    plan.sha512,
    'tarball SHA-512',
  );
  requireArtifactValue(
    deps.readArtifactCommit(),
    plan.releaseCommit,
    'bundle commit',
  );
  requireArtifactValue(
    deps.readLocalTag(plan.tag),
    plan.releaseCommit,
    'bundle tag',
  );
  const parents = deps.readCommitParents(plan.releaseCommit);
  requireArtifactValue(parents.length, 1, 'release parent count');
  requireArtifactValue(parents[0], plan.baseCommit, 'release parent');
  const manifest = deps.readCommitManifest(plan.releaseCommit);
  requireArtifactValue(manifest.name, packageName, 'package identity');
  requireArtifactValue(manifest.version, plan.version, 'package version');
}

function createReleaseVersion(deps, state, version) {
  deps.createVersion(version);
  const releaseCommit = deps.readHead();
  requireArtifactValue(deps.readLocalTag(state.tag), releaseCommit, state.tag);
  return { ...state, headCommit: releaseCommit };
}

function requireStablePreparation(deps, state) {
  const remoteMain = deps.readRemoteMain();
  const remoteTag = deps.readRemoteTag(state.tag);
  const expectedMain = state.mode === 'create' ? state.baseCommit : state.headCommit;
  const expectedTag = state.mode === 'create' ? null : state.headCommit;
  if (!allEqual([[remoteMain, expectedMain], [remoteTag, expectedTag]])) {
    throw new Error('origin/main or the release tag changed while the release was verified.');
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
    state = createReleaseVersion(deps, state, version);
  }

  const receipt = await deps.verifyRelease();
  deps.fetchMain();
  requireStablePreparation(deps, state);

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

async function verifyPublishedVersion(deps, version, attempt = 0) {
  const delays = [0, 1_000, 2_000, 4_000];
  if (attempt >= delays.length) {
    throw new Error(`npm did not return ${packageName}@${version} after publishing.`);
  }
  if (delays[attempt] > 0) await deps.wait(delays[attempt]);
  if (deps.registryVersion(packageName, version) === version) return;
  await verifyPublishedVersion(deps, version, attempt + 1);
}

function remoteReleaseMode(plan, remoteMain, remoteTag) {
  if (allEqual([[remoteMain, plan.baseCommit], [remoteTag, null]])) return 'create';
  if (allEqual([[remoteMain, plan.releaseCommit], [remoteTag, plan.releaseCommit]])) {
    return 'existing';
  }
  throw new Error(
    `Release ${plan.version} is in a mixed state; main and ${plan.tag} must agree before continuing.`,
  );
}

function preflightPublishedIntegrity(deps, plan) {
  const integrity = deps.registryIntegrity(packageName, plan.version);
  if (integrity !== null) requireMatchingIntegrity(plan.sha512, integrity);
  return integrity;
}

async function publishOrComplete(deps, plan, publishedIntegrity) {
  if (publishedIntegrity !== null) {
    return { ...plan, mode: 'complete', registryIntegrity: publishedIntegrity };
  }
  deps.publish(plan.version);
  await verifyPublishedVersion(deps, plan.version);
  return { ...plan, registryIntegrity: null };
}

export async function finalizeReleaseWorkflow(versionInput, overrides = {}) {
  const version = validateExactVersion(versionInput);
  const deps = dependencies(overrides);
  const context = overrides.context ?? validateOidcContext(process.env);

  deps.assertPinnedCheckout(context.dispatchCommit);
  deps.fetchMain();
  const plan = await deps.readPlan();
  const receipt = await deps.readReceipt();
  validateArtifactPlan(plan, receipt, version, context.dispatchCommit);
  deps.importBundle(plan.tag);
  await verifyArtifact(deps, plan);

  const remoteMain = deps.readRemoteMain();
  const remoteTag = deps.readRemoteTag(plan.tag);
  const releaseMode = remoteReleaseMode(plan, remoteMain, remoteTag);
  const publishedIntegrity = preflightPublishedIntegrity(deps, plan);
  if (releaseMode === 'create') {
    deps.pushRelease(plan.releaseCommit, plan.tag);
  }
  return publishOrComplete(deps, plan, publishedIntegrity);
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
