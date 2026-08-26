#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = 'https://registry.npmjs.org';
const verifiedTarball = '.cache/diffsplain-release.tgz';
const verificationReceipt = '.cache/diffsplain-release.json';

function platformCommand(command, platform = process.platform) {
  return platform === 'win32' ? `${command}.cmd` : command;
}

export function corepackCommand(platform = process.platform) {
  return platformCommand('corepack', platform);
}

function run(command, args, { allowFailure = false, capture = false, env } = {}) {
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

function runGit(args) {
  return run('git', args, { capture: true }).stdout;
}

function runPnpm(args) {
  run(platformCommand('pnpm'), args);
}

function runNpm(args, options = {}) {
  return run(corepackCommand(), ['npm@11.5.1', ...args], {
    ...options,
    env: { COREPACK_ENABLE_PROJECT_SPEC: '0', ...options.env },
  });
}

async function readPackage() {
  return JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
}

async function sha256(path) {
  const contents = await readFile(resolve(root, path));
  return createHash('sha256').update(contents).digest('hex');
}

function releaseTag(version) {
  return `v${version}`;
}

function readReleaseState(version) {
  const tag = releaseTag(version);
  let tagCommit;
  try {
    tagCommit = runGit(['rev-parse', `refs/tags/${tag}^{}`]);
  } catch {
    throw new Error(`Missing release tag ${tag}. Create the version commit and tag first.`);
  }
  return {
    branch: runGit(['branch', '--show-current']),
    status: runGit(['status', '--porcelain']),
    commit: runGit(['rev-parse', 'HEAD']),
    tag,
    tagCommit,
  };
}

export function validateReleaseState({ branch, status, commit, tag, tagCommit }) {
  if (branch !== 'main') {
    throw new Error(`Releases must run from main, not ${branch || 'a detached HEAD'}.`);
  }
  if (status) {
    throw new Error('The working tree must be clean before a release.');
  }
  if (commit !== tagCommit) {
    throw new Error(`${tag} must point to the checked-out commit ${commit}.`);
  }
}

export function validateReceipt(receipt, expected) {
  for (const key of ['package', 'version', 'tag', 'commit', 'tarball', 'sha256']) {
    if (receipt[key] !== expected[key]) {
      throw new Error(`Release verification is stale: ${key} does not match.`);
    }
  }
}

function isPrerelease(version) {
  return /^\d+\.\d+\.\d+-/.test(version);
}

function publishArgs(version) {
  return [
    'publish',
    verifiedTarball,
    '--access',
    'public',
    '--registry',
    registry,
    ...(isPrerelease(version) ? ['--tag', 'next'] : []),
  ];
}

function requirePublishedVersion(deps, name, expectedVersion) {
  const publishedVersion = deps.verifyPublished(name, expectedVersion);
  if (publishedVersion !== expectedVersion) {
    throw new Error(
      `npm returned ${publishedVersion || 'no version'} after publishing ${expectedVersion}.`,
    );
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function verifyPublishedRelease(deps, name, version) {
  const verificationDelays = [0, 1_000, 2_000, 4_000];
  let lastError;
  for (const delay of verificationDelays) {
    if (delay > 0) await deps.wait(delay);
    try {
      requirePublishedVersion(deps, name, version);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `${name}@${version} was published, but post-publish verification failed: ${errorMessage(lastError)}`,
    { cause: lastError },
  );
}

function registryVersionExists(name, version) {
  const result = runNpm(
    ['view', `${name}@${version}`, 'version', '--json', '--registry', registry],
    { allowFailure: true, capture: true },
  );
  if (result.status === 0) return true;
  if (/E404|404 Not Found|No match found/.test(`${result.stdout}\n${result.stderr}`)) {
    return false;
  }
  throw new Error(result.stderr || 'Could not check the npm registry.');
}

function requireNpmLogin() {
  const result = runNpm(['whoami', '--registry', registry], {
    allowFailure: true,
    capture: true,
  });
  if (result.status !== 0) {
    throw new Error(
      'Not signed in to npm. Run: COREPACK_ENABLE_PROJECT_SPEC=0 corepack npm@11.5.1 login --auth-type=web',
    );
  }
  return result.stdout;
}

const defaults = {
  now: () => new Date().toISOString(),
  publish: (args) => runNpm(args),
  readPackage,
  readReceipt: async () => {
    try {
      return JSON.parse(
        await readFile(resolve(root, verificationReceipt), 'utf8'),
      );
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        throw new Error('No verified release found. Run pnpm run release:verify first.');
      }
      throw error;
    }
  },
  readState: readReleaseState,
  registryVersionExists,
  requireNpmLogin,
  runPnpm,
  sha256,
  verifyPublished: (name, version) => {
    const result = runNpm(
      ['view', `${name}@${version}`, 'version', '--json', '--registry', registry],
      { capture: true },
    );
    return result.stdout.replace(/^"|"$/g, '');
  },
  wait,
  writeReceipt: (receipt) =>
    writeFile(
      resolve(root, verificationReceipt),
      `${JSON.stringify(receipt, null, 2)}\n`,
      'utf8',
    ),
};

function dependencies(overrides) {
  return { ...defaults, ...overrides };
}

export async function verifyRelease(overrides = {}) {
  const deps = dependencies(overrides);
  const pkg = await deps.readPackage();
  const initialState = deps.readState(pkg.version);
  validateReleaseState(initialState);

  deps.runPnpm(['run', 'check']);
  deps.runPnpm([
    'run',
    'package:verify',
    '--',
    '--release-tarball',
    verifiedTarball,
  ]);

  const state = deps.readState(pkg.version);
  validateReleaseState(state);
  if (state.commit !== initialState.commit) {
    throw new Error('The checked-out commit changed while the release was verified.');
  }

  const receipt = {
    schemaVersion: 1,
    package: pkg.name,
    version: pkg.version,
    tag: state.tag,
    commit: state.commit,
    tarball: verifiedTarball,
    sha256: await deps.sha256(verifiedTarball),
    verifiedAt: deps.now(),
  };
  await deps.writeReceipt(receipt);
  return receipt;
}

export async function publishRelease(expectedVersion, overrides = {}) {
  if (!expectedVersion) {
    throw new Error('Usage: pnpm run release:publish -- <version>');
  }

  const deps = dependencies(overrides);
  const pkg = await deps.readPackage();
  if (expectedVersion !== pkg.version) {
    throw new Error(
      `Expected version ${expectedVersion}, but package.json contains ${pkg.version}.`,
    );
  }

  const state = deps.readState(pkg.version);
  validateReleaseState(state);
  const expected = {
    package: pkg.name,
    version: pkg.version,
    tag: state.tag,
    commit: state.commit,
    tarball: verifiedTarball,
    sha256: await deps.sha256(verifiedTarball),
  };
  const receipt = await deps.readReceipt();
  validateReceipt(receipt, expected);

  const account = deps.requireNpmLogin();
  if (deps.registryVersionExists(pkg.name, pkg.version)) {
    throw new Error(`${pkg.name}@${pkg.version} already exists on npm.`);
  }

  deps.publish(publishArgs(pkg.version));
  await verifyPublishedRelease(deps, pkg.name, pkg.version);
  return { account, package: pkg.name, version: pkg.version };
}

function commandArguments(argv) {
  return argv.filter((argument) => argument !== '--');
}

async function main(argv) {
  const [command, ...args] = commandArguments(argv);
  if (command === 'verify' && args.length === 0) {
    const receipt = await verifyRelease();
    console.log(
      `Verified ${receipt.package}@${receipt.version} from ${receipt.commit}.\nTarball: ${receipt.tarball}\nSHA-256: ${receipt.sha256}`,
    );
    return;
  }
  if (command === 'publish' && args.length === 1) {
    const result = await publishRelease(args[0]);
    console.log(
      `Published ${result.package}@${result.version} to npm as ${result.account}. Push the release commit and tag with: git push origin main --follow-tags`,
    );
    return;
  }
  throw new Error(
    'Usage: pnpm run release:verify\n   or: pnpm run release:publish -- <version>',
  );
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 2;
  }
}
