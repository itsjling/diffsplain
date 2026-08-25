import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  publishRelease,
  validateReceipt,
  validateReleaseState,
  verifyRelease,
} from '../scripts/release.mjs';

const releaseScript = new URL('../scripts/release.mjs', import.meta.url).pathname;
const cleanState = {
  branch: 'main',
  status: '',
  commit: 'abc123',
  tag: 'v1.2.3',
  tagCommit: 'abc123',
};
const receipt = {
  schemaVersion: 1,
  package: 'diffsplain',
  version: '1.2.3',
  tag: 'v1.2.3',
  commit: 'abc123',
  tarball: '.cache/diffsplain-release.tgz',
  sha256: 'verified-hash',
  verifiedAt: '2026-08-05T00:00:00.000Z',
};

test('verifies a tagged release and records the exact tarball', async () => {
  const calls = [];
  let writtenReceipt;
  const result = await verifyRelease({
    now: () => '2026-08-05T00:00:00.000Z',
    readPackage: async () => ({ name: 'diffsplain', version: '1.2.3' }),
    readState: () => cleanState,
    runPnpm: (args) => calls.push(args),
    sha256: async () => 'verified-hash',
    writeReceipt: async (value) => {
      writtenReceipt = value;
    },
  });

  assert.deepEqual(calls, [
    ['run', 'check'],
    [
      'run',
      'package:verify',
      '--',
      '--release-tarball',
      '.cache/diffsplain-release.tgz',
    ],
  ]);
  assert.deepEqual(result, receipt);
  assert.deepEqual(writtenReceipt, receipt);
});

test('rejects the wrong branch, a dirty tree, and a mismatched tag', () => {
  assert.throws(
    () => validateReleaseState({ ...cleanState, branch: 'release-test' }),
    /Releases must run from main/,
  );
  assert.throws(
    () => validateReleaseState({ ...cleanState, status: ' M package.json' }),
    /working tree must be clean/,
  );
  assert.throws(
    () => validateReleaseState({ ...cleanState, tagCommit: 'def456' }),
    /v1\.2\.3 must point to the checked-out commit/,
  );
});

test('rejects a stale verification receipt', () => {
  assert.throws(
    () => validateReceipt(receipt, { ...receipt, sha256: 'changed-hash' }),
    /sha256 does not match/,
  );
});

test('publishes a verified stable release under the default tag', async () => {
  const calls = [];
  const result = await publishRelease('1.2.3', {
    publish: (args) => calls.push(args),
    readPackage: async () => ({ name: 'diffsplain', version: '1.2.3' }),
    readReceipt: async () => receipt,
    readState: () => cleanState,
    registryVersionExists: () => false,
    requireNpmLogin: () => 'jling',
    sha256: async () => 'verified-hash',
    verifyPublished: () => '1.2.3',
  });

  assert.deepEqual(calls, [
    [
      'publish',
      '.cache/diffsplain-release.tgz',
      '--access',
      'public',
      '--registry',
      'https://registry.npmjs.org',
    ],
  ]);
  assert.deepEqual(result, {
    account: 'jling',
    package: 'diffsplain',
    version: '1.2.3',
  });
});

test('retries a transient post-publish lookup without publishing again', async () => {
  const calls = [];
  let verificationAttempt = 0;
  const result = await publishRelease('1.2.3', {
    publish: () => calls.push('publish'),
    readPackage: async () => ({ name: 'diffsplain', version: '1.2.3' }),
    readReceipt: async () => receipt,
    readState: () => cleanState,
    registryVersionExists: () => false,
    requireNpmLogin: () => 'jling',
    sha256: async () => 'verified-hash',
    verifyPublished: () => {
      calls.push('verify');
      verificationAttempt += 1;
      if (verificationAttempt === 1) {
        throw new Error('npm registry lookup failed');
      }
      return '1.2.3';
    },
    wait: async (milliseconds) => calls.push(['wait', milliseconds]),
  });

  assert.deepEqual(calls, [
    'publish',
    'verify',
    ['wait', 1_000],
    'verify',
  ]);
  assert.deepEqual(result, {
    account: 'jling',
    package: 'diffsplain',
    version: '1.2.3',
  });
});

test('stops after bounded post-publish verification attempts', async () => {
  const calls = [];
  await assert.rejects(
    publishRelease('1.2.3', {
      publish: () => calls.push('publish'),
      readPackage: async () => ({ name: 'diffsplain', version: '1.2.3' }),
      readReceipt: async () => receipt,
      readState: () => cleanState,
      registryVersionExists: () => false,
      requireNpmLogin: () => 'jling',
      sha256: async () => 'verified-hash',
      verifyPublished: () => {
        calls.push('verify');
        throw new Error('npm registry lookup failed');
      },
      wait: async (milliseconds) => calls.push(['wait', milliseconds]),
    }),
    /npm registry lookup failed/,
  );

  assert.deepEqual(calls, [
    'publish',
    'verify',
    ['wait', 1_000],
    'verify',
    ['wait', 2_000],
    'verify',
    ['wait', 4_000],
    'verify',
  ]);
});

test('publishes a verified prerelease under the next tag', async () => {
  const calls = [];
  const prerelease = {
    ...receipt,
    version: '1.2.3-beta.1',
    tag: 'v1.2.3-beta.1',
  };
  await publishRelease('1.2.3-beta.1', {
    publish: (args) => calls.push(args),
    readPackage: async () => ({
      name: 'diffsplain',
      version: '1.2.3-beta.1',
    }),
    readReceipt: async () => prerelease,
    readState: () => ({
      ...cleanState,
      tag: 'v1.2.3-beta.1',
    }),
    registryVersionExists: () => false,
    requireNpmLogin: () => 'jling',
    sha256: async () => 'verified-hash',
    verifyPublished: () => '1.2.3-beta.1',
  });

  assert.deepEqual(calls[0].slice(-2), ['--tag', 'next']);
});

test('stops when the requested or registry version is not publishable', async () => {
  const common = {
    publish: () => assert.fail('publish should not run'),
    readPackage: async () => ({ name: 'diffsplain', version: '1.2.3' }),
    readReceipt: async () => receipt,
    readState: () => cleanState,
    requireNpmLogin: () => 'jling',
    sha256: async () => 'verified-hash',
    verifyPublished: () => '1.2.3',
  };

  await assert.rejects(
    publishRelease('1.2.4', common),
    /package\.json contains 1\.2\.3/,
  );
  await assert.rejects(
    publishRelease('1.2.3', {
      ...common,
      registryVersionExists: () => true,
    }),
    /already exists on npm/,
  );
});

test('exposes only the two manual release commands', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(pkg.scripts.release, undefined);
  assert.equal(pkg.scripts['release:verify'], 'node scripts/release.mjs verify');
  assert.equal(pkg.scripts['release:publish'], 'node scripts/release.mjs publish');
  await assert.rejects(
    access(new URL('../.github/workflows/release.yml', import.meta.url)),
    { code: 'ENOENT' },
  );

  const result = spawnSync(process.execPath, [releaseScript], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /release:verify/);
  assert.match(result.stderr, /release:publish/);
});
