import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  classifyReleaseState,
  compareExactVersions,
  requireMatchingIntegrity,
  runReleaseWorkflow,
  sha512Integrity,
  validateExactVersion,
  validateOidcContext,
} from '../scripts/release-workflow.mjs';

const projectRoot = new URL('..', import.meta.url);
const oidc = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'itsjling/diffsplain',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF:
    'itsjling/diffsplain/.github/workflows/release.yml@refs/heads/main',
  GITHUB_SHA: 'base',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test/oidc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
};
const createObservation = {
  version: '1.3.0',
  packageVersion: '1.2.3',
  tag: 'v1.3.0',
  headCommit: 'base',
  baseCommit: 'base',
  remoteMainCommit: 'base',
  localTagCommit: null,
  remoteTagCommit: null,
  registryIntegrity: null,
  packageName: 'diffsplain',
};
const resumeObservation = {
  ...createObservation,
  packageVersion: '1.3.0',
  headCommit: 'release',
  baseCommit: 'base',
  remoteMainCommit: 'release',
  localTagCommit: 'release',
  remoteTagCommit: 'release',
};

test('accepts only exact canonical stable and prerelease SemVer', () => {
  for (const version of ['0.0.0', '1.2.3', '1.2.3-beta.1', '2.0.0-rc.0-x']) {
    assert.equal(validateExactVersion(version), version);
  }
  for (const version of [
    '',
    ' 1.2.3',
    '1.2.3 ',
    '--help',
    'v1.2.3',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3+build.1',
    '^1.2.3',
    'minor',
    '1.2.3; echo unsafe',
    '$(echo 1.2.3)',
  ]) {
    assert.throws(() => validateExactVersion(version), /exact canonical SemVer/);
  }
});

test('requires the exact GitHub trusted-publisher context and no token auth', () => {
  assert.deepEqual(validateOidcContext(oidc), {
    account: 'GitHub Actions OIDC',
    dispatchCommit: 'base',
  });
  for (const name of [
    'GITHUB_ACTIONS',
    'GITHUB_REPOSITORY',
    'GITHUB_REF',
    'GITHUB_WORKFLOW_REF',
    'GITHUB_SHA',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  ]) {
    assert.throws(
      () => validateOidcContext({ ...oidc, [name]: '' }),
      new RegExp(name),
    );
  }
  for (const name of ['NODE_AUTH_TOKEN', 'NPM_TOKEN']) {
    for (const value of ['', 'secret']) {
      assert.throws(
        () => validateOidcContext({ ...oidc, [name]: value }),
        new RegExp(name),
      );
    }
  }
});

test('orders exact stable and prerelease versions', () => {
  assert.equal(compareExactVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareExactVersions('1.2.4', '1.2.3'), 1);
  assert.equal(compareExactVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareExactVersions('1.2.3', '1.2.3-rc.1'), 1);
  assert.equal(compareExactVersions('1.2.3-rc.2', '1.2.3-rc.10'), -1);
  assert.equal(compareExactVersions('1.2.3-beta', '1.2.3-1'), 1);
  assert.equal(compareExactVersions('1.2.3-rc-x', '1.2.3-rc-w'), 1);
  assert.equal(
    compareExactVersions('9007199254740993.0.0', '9007199254740992.0.0'),
    1,
  );
});

test('classifies create, resume, and complete states with one stable shape', () => {
  assert.deepEqual(classifyReleaseState(createObservation), {
    mode: 'create',
    version: '1.3.0',
    tag: 'v1.3.0',
    headCommit: 'base',
    baseCommit: 'base',
    remoteMainCommit: 'base',
    registryIntegrity: null,
  });
  assert.equal(classifyReleaseState(resumeObservation).mode, 'resume');
  assert.deepEqual(
    classifyReleaseState({
      ...resumeObservation,
      registryIntegrity: 'sha512-published',
    }),
    {
      mode: 'complete',
      version: '1.3.0',
      tag: 'v1.3.0',
      headCommit: 'release',
      baseCommit: 'base',
      remoteMainCommit: 'release',
      registryIntegrity: 'sha512-published',
    },
  );
});

test('rejects moved main, conflicting tags, and other mixed states', () => {
  for (const changed of [
    { remoteMainCommit: 'moved' },
    { localTagCommit: 'other' },
    { remoteTagCommit: 'other' },
    { registryIntegrity: 'sha512-unexpected' },
  ]) {
    assert.throws(
      () => classifyReleaseState({ ...createObservation, ...changed }),
      /mixed state/,
    );
  }
  assert.throws(
    () => classifyReleaseState({ ...resumeObservation, remoteMainCommit: 'moved' }),
    /mixed state/,
  );
  assert.throws(
    () => classifyReleaseState({ ...resumeObservation, remoteTagCommit: 'other' }),
    /mixed state/,
  );
  assert.throws(
    () =>
      classifyReleaseState({
        ...createObservation,
        version: '1.2.2',
        tag: 'v1.2.2',
      }),
    /mixed state/,
  );
});

test('computes npm SHA-512 SRI and rejects a different published tarball', () => {
  const integrity = sha512Integrity(Buffer.from('release tarball'));
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.doesNotThrow(() => requireMatchingIntegrity(integrity, integrity));
  assert.throws(
    () => requireMatchingIntegrity(integrity, 'sha512-different'),
    /integrity mismatch/,
  );
});

function workflowDeps(observation, calls, overrides = {}) {
  return {
    assertCleanMain: () => calls.push('clean'),
    classify: classifyReleaseState,
    createVersion: (version) => calls.push(['version', version]),
    fetchMain: () => calls.push('fetch'),
    localTarballIntegrity: async () => 'sha512-matching',
    observe: async () => observation,
    publishRelease: async (version, publishOverrides) => {
      calls.push(['publish', version]);
      assert.equal(publishOverrides.registryVersionExists(), false);
      assert.equal(publishOverrides.requireNpmLogin(), 'oidc-account');
    },
    pushRelease: (tag) => calls.push(['push', tag]),
    readHead: () => 'release',
    readLocalTag: () => 'release',
    readRemoteMain: () =>
      observation.packageVersion === observation.version ? 'release' : 'base',
    readRemoteTag: () =>
      observation.packageVersion === observation.version ? 'release' : null,
    registryIntegrity: () => null,
    validateContext: () => {
      calls.push('oidc');
      return {
        account: 'oidc-account',
        dispatchCommit: observation.headCommit,
      };
    },
    verifyRelease: async () => calls.push('verify'),
    ...overrides,
  };
}

test('creates, verifies, atomically pushes, then publishes a fresh release', async () => {
  const calls = [];
  const result = await runReleaseWorkflow(
    '1.3.0',
    workflowDeps(createObservation, calls),
  );

  assert.equal(result.mode, 'create');
  assert.equal(result.headCommit, 'release');
  assert.deepEqual(calls, [
    'oidc',
    'clean',
    'fetch',
    ['version', '1.3.0'],
    'verify',
    'fetch',
    ['push', 'v1.3.0'],
    ['publish', '1.3.0'],
  ]);
});

test('resumes only an already-pushed release and does not recreate or push it', async () => {
  const calls = [];
  const result = await runReleaseWorkflow(
    '1.3.0',
    workflowDeps(resumeObservation, calls),
  );

  assert.equal(result.mode, 'resume');
  assert.deepEqual(calls, [
    'oidc',
    'clean',
    'fetch',
    'verify',
    'fetch',
    ['publish', '1.3.0'],
  ]);
});

test('accepts an already-published release only when tarball integrity matches', async () => {
  const calls = [];
  const complete = {
    ...resumeObservation,
    registryIntegrity: 'sha512-matching',
  };
  const result = await runReleaseWorkflow(
    '1.3.0',
    workflowDeps(complete, calls, {
      registryIntegrity: () => 'sha512-matching',
    }),
  );

  assert.equal(result.mode, 'complete');
  assert.deepEqual(calls, ['oidc', 'clean', 'fetch', 'verify', 'fetch']);

  await assert.rejects(
    runReleaseWorkflow(
      '1.3.0',
      workflowDeps(complete, [], {
        registryIntegrity: () => 'sha512-other',
      }),
    ),
    /integrity mismatch/,
  );
});

test('stops if main or the tag moves during verification', async () => {
  await assert.rejects(
    runReleaseWorkflow(
      '1.3.0',
      workflowDeps(createObservation, [], { readRemoteMain: () => 'moved' }),
    ),
    /changed while the release was verified/,
  );
  await assert.rejects(
    runReleaseWorkflow(
      '1.3.0',
      workflowDeps(resumeObservation, [], { readRemoteTag: () => 'moved' }),
    ),
    /changed while the release was verified/,
  );
});

test('stops when checkout does not match the dispatch commit', async () => {
  await assert.rejects(
    runReleaseWorkflow(
      '1.3.0',
      workflowDeps(createObservation, [], {
        validateContext: () => ({
          account: 'oidc-account',
          dispatchCommit: 'different',
        }),
      }),
    ),
    /dispatch commit/,
  );
});

test('workflow pins the trusted, serialized, single-job release contract', async () => {
  const workflow = await readFile(
    new URL('.github/workflows/release.yml', projectRoot),
    'utf8',
  );

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /group: npm-release/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /environment: npm-publish/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /package-manager-cache: false/);
  assert.match(workflow, /pnpm\/action-setup@v4/);
  assert.match(workflow, /corepack@0\.34\.1/);
  assert.match(workflow, /npm@11\.5\.1/);
  assert.doesNotMatch(workflow, /^\s+cache:/m);
  assert.match(workflow, /RELEASE_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(
    workflow,
    /node scripts\/release-workflow\.mjs "\$RELEASE_VERSION"/,
  );
  assert.equal((workflow.match(/^  release:$/gm) ?? []).length, 1);
});
