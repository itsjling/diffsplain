import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  classifyReleaseState,
  compareExactVersions,
  finalizeReleaseWorkflow,
  prepareReleaseWorkflow,
  requirePinnedCommit,
  requireMatchingIntegrity,
  sha512Integrity,
  validateDispatchCommit,
  validateExactVersion,
  validateOidcContext,
  validatePrepareContext,
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

test('requires release preparation to have no publish credential', () => {
  const prepare = { ...oidc };
  delete prepare.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete prepare.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  assert.deepEqual(validatePrepareContext(prepare), { dispatchCommit: 'base' });
  for (const name of [
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'NODE_AUTH_TOKEN',
    'NPM_TOKEN',
  ]) {
    assert.throws(
      () => validatePrepareContext({ ...prepare, [name]: 'credential' }),
      new RegExp(name),
    );
  }
});

test('requires the privileged checkout to match the dispatch commit', () => {
  assert.doesNotThrow(() => requirePinnedCommit('dispatch', 'dispatch'));
  assert.throws(
    () => requirePinnedCommit('moved-main', 'dispatch'),
    /privileged checkout.*dispatch commit/,
  );
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

test('accepts the release parent only for a pushed release rerun', () => {
  assert.doesNotThrow(() => validateDispatchCommit(resumeObservation, 'base'));
  assert.doesNotThrow(() => validateDispatchCommit(resumeObservation, 'release'));
  assert.throws(
    () => validateDispatchCommit(createObservation, 'different'),
    /dispatch commit/,
  );
});

function preparationDeps(observation, calls, overrides = {}) {
  return {
    assertCleanMain: () => calls.push('clean'),
    bundleRelease: (tag) => calls.push(['bundle', tag]),
    context: { dispatchCommit: observation.headCommit },
    createVersion: (version) => calls.push(['version', version]),
    fetchMain: () => calls.push('fetch'),
    localTarballIntegrity: async () => 'sha512-matching',
    observe: async () => observation,
    readHead: () => 'release',
    readLocalTag: () => 'release',
    readRemoteMain: () =>
      observation.packageVersion === observation.version ? 'release' : 'base',
    readRemoteTag: () =>
      observation.packageVersion === observation.version ? 'release' : null,
    verifyRelease: async () => {
      calls.push('verify');
      return {
        package: 'diffsplain',
        version: observation.version,
        tag: observation.tag,
        commit: 'release',
        tarball: '.cache/diffsplain-release.tgz',
        sha256: 'sha256-matching',
      };
    },
    writePlan: async () => calls.push('plan'),
    ...overrides,
  };
}

test('prepares and verifies a fresh release without pushing or publishing', async () => {
  const calls = [];
  const result = await prepareReleaseWorkflow(
    '1.3.0',
    preparationDeps(createObservation, calls),
  );

  assert.equal(result.mode, 'create');
  assert.equal(result.releaseCommit, 'release');
  assert.deepEqual(calls, [
    'clean',
    'fetch',
    ['version', '1.3.0'],
    'verify',
    'fetch',
    ['bundle', 'v1.3.0'],
    'plan',
  ]);
});

test('prepares an already-pushed release without recreating it', async () => {
  const calls = [];
  const result = await prepareReleaseWorkflow(
    '1.3.0',
    preparationDeps(resumeObservation, calls),
  );

  assert.equal(result.mode, 'resume');
  assert.deepEqual(calls, [
    'clean',
    'fetch',
    'verify',
    'fetch',
    ['bundle', 'v1.3.0'],
    'plan',
  ]);
});

test('accepts a native rerun dispatched from the release parent', async () => {
  const calls = [];
  const result = await prepareReleaseWorkflow(
    '1.3.0',
    preparationDeps(resumeObservation, calls, {
      context: { dispatchCommit: 'base' },
    }),
  );

  assert.equal(result.mode, 'resume');
  assert.deepEqual(calls, [
    'clean',
    'fetch',
    'verify',
    'fetch',
    ['bundle', 'v1.3.0'],
    'plan',
  ]);
});

const baseCommit = 'a'.repeat(40);
const releaseCommit = 'b'.repeat(40);
const plan = {
  schemaVersion: 1,
  package: 'diffsplain',
  version: '1.3.0',
  tag: 'v1.3.0',
  mode: 'create',
  dispatchCommit: baseCommit,
  baseCommit,
  releaseCommit,
  tarball: '.cache/diffsplain-release.tgz',
  bundle: '.cache/diffsplain-release.bundle',
  sha256: 'sha256-matching',
  sha512: 'sha512-matching',
};
const artifactReceipt = {
  package: plan.package,
  version: plan.version,
  tag: plan.tag,
  commit: plan.releaseCommit,
  tarball: plan.tarball,
  sha256: plan.sha256,
};

function finalizationDeps(calls, overrides = {}) {
  return {
    assertPinnedCheckout: (commit) => calls.push(['pinned', commit]),
    context: { dispatchCommit: baseCommit },
    fetchMain: () => calls.push('fetch'),
    importBundle: (tag) => calls.push(['import', tag]),
    localTarballIntegrity: async () => plan.sha512,
    localTarballSha256: async () => plan.sha256,
    publish: (version) => calls.push(['publish', version]),
    pushRelease: (commit, tag) => calls.push(['push', commit, tag]),
    readArtifactCommit: () => releaseCommit,
    readCommitManifest: () => ({ name: 'diffsplain', version: '1.3.0' }),
    readCommitParents: () => [baseCommit],
    readLocalTag: () => releaseCommit,
    readPlan: async () => plan,
    readReceipt: async () => artifactReceipt,
    readRemoteMain: () => baseCommit,
    readRemoteTag: () => null,
    registryIntegrity: () => null,
    registryVersion: () => '1.3.0',
    wait: async () => {},
    ...overrides,
  };
}

test('finalizes only the verified artifact with push and publish authority', async () => {
  const calls = [];
  const result = await finalizeReleaseWorkflow(
    '1.3.0',
    finalizationDeps(calls),
  );

  assert.equal(result.mode, 'create');
  assert.deepEqual(calls, [
    ['pinned', baseCommit],
    'fetch',
    ['import', 'v1.3.0'],
    ['push', releaseCommit, 'v1.3.0'],
    ['publish', '1.3.0'],
  ]);
});

test('accepts an already-published release only when tarball integrity matches', async () => {
  const result = await finalizeReleaseWorkflow(
    '1.3.0',
    finalizationDeps([], {
      readRemoteMain: () => releaseCommit,
      readRemoteTag: () => releaseCommit,
      registryIntegrity: () => 'sha512-matching',
    }),
  );

  assert.equal(result.mode, 'complete');

  await assert.rejects(
    finalizeReleaseWorkflow(
      '1.3.0',
      finalizationDeps([], {
        readRemoteMain: () => releaseCommit,
        readRemoteTag: () => releaseCommit,
        registryIntegrity: () => 'sha512-other',
      }),
    ),
    /integrity mismatch/,
  );
});

test('rejects a finalization artifact with altered contents or release history', async () => {
  await assert.rejects(
    finalizeReleaseWorkflow(
      '1.3.0',
      finalizationDeps([], { localTarballSha256: async () => 'changed' }),
    ),
    /SHA-256/,
  );
  await assert.rejects(
    finalizeReleaseWorkflow(
      '1.3.0',
      finalizationDeps([], { readCommitParents: () => ['different'] }),
    ),
    /release parent/,
  );
  await assert.rejects(
    finalizeReleaseWorkflow(
      '1.3.0',
      finalizationDeps([], {
        readCommitManifest: () => ({ name: 'other', version: '1.3.0' }),
      }),
    ),
    /package identity/,
  );
  await assert.rejects(
    finalizeReleaseWorkflow(
      '1.3.0',
      finalizationDeps([], {
        readPlan: async () => ({ ...plan, baseCommit: 'c'.repeat(40) }),
      }),
    ),
    /dispatch commit.*release state/,
  );
});

test('stops if main or the tag moves during verification', async () => {
  await assert.rejects(
    prepareReleaseWorkflow(
      '1.3.0',
      preparationDeps(createObservation, [], { readRemoteMain: () => 'moved' }),
    ),
    /changed while the release was verified/,
  );
  await assert.rejects(
    prepareReleaseWorkflow(
      '1.3.0',
      preparationDeps(resumeObservation, [], { readRemoteTag: () => 'moved' }),
    ),
    /changed while the release was verified/,
  );
});

test('stops when checkout does not match the dispatch commit', async () => {
  await assert.rejects(
    prepareReleaseWorkflow(
      '1.3.0',
      preparationDeps(createObservation, [], {
        context: { dispatchCommit: 'different' },
      }),
    ),
    /dispatch commit/,
  );
});

test('workflow pins the trusted, serialized, split-job release contract', async () => {
  const workflow = await readFile(
    new URL('.github/workflows/release.yml', projectRoot),
    'utf8',
  );
  const helper = await readFile(
    new URL('scripts/release-workflow.mjs', projectRoot),
    'utf8',
  );

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /group: npm-release/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /^  prepare:\n(?:.|\n)*?    permissions:\n      contents: read/m);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /include-hidden-files: true/);
  assert.match(workflow, /^  release:\n    needs: prepare/m);
  assert.match(
    workflow,
    /^  release:\n(?:.|\n)*?    permissions:\n      contents: write\n      id-token: write/m,
  );
  assert.match(workflow, /actions\/download-artifact@v5/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /environment: npm-publish/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /package-manager-cache: false/);
  assert.match(workflow, /pnpm\/action-setup@v4/);
  assert.match(workflow, /npm@11\.5\.1/);
  assert.doesNotMatch(workflow, /^\s+cache:/m);
  assert.match(workflow, /RELEASE_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(
    workflow,
    /node scripts\/release-workflow\.mjs prepare "\$RELEASE_VERSION"/,
  );
  assert.match(
    workflow,
    /node scripts\/release-workflow\.mjs finalize "\$RELEASE_VERSION"/,
  );
  const prepareJob = workflow.slice(
    workflow.indexOf('\n  prepare:'),
    workflow.indexOf('\n  release:'),
  );
  assert.match(prepareJob, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(prepareJob, /ref: main/);
  assert.match(prepareJob, /git checkout -B main "\$GITHUB_SHA"/);
  const releaseJob = workflow.slice(workflow.indexOf('\n  release:'));
  assert.match(releaseJob, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(releaseJob, /ref: main/);
  assert.doesNotMatch(releaseJob, /pnpm install|release:verify/);
  assert.doesNotMatch(helper, /^import .*release\.mjs/m);
  assert.match(helper, /'--ignore-scripts'/);
  assert.equal((workflow.match(/^  (?:prepare|release):$/gm) ?? []).length, 2);
});
