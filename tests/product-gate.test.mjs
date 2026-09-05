import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const check = new URL('../scripts/check.mjs', import.meta.url).pathname;

test('runs the product gate once from the lockfile on the latest Node LTS', async () => {
  const [workflow, fallow] = await Promise.all([
    readFile(new URL('../.github/workflows/product-gate.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/fallow.yml', import.meta.url), 'utf8'),
  ]);

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /node-version: 'lts\/\*'/);
  assert.match(workflow, /check-latest: true/);
  assert.doesNotMatch(workflow, /matrix:/);
  assert.match(workflow, /uses: pnpm\/action-setup@v4/);
  assert.match(workflow, /run: pnpm install --frozen-lockfile/);
  assert.match(workflow, /run: pnpm run check/);
  assert.match(fallow, /not full project health/);
});

for (const stage of ['test', 'lint', 'docs', 'build', 'package']) {
  test(`fails the product gate when ${stage} fails`, () => {
    const result = spawnSync(process.execPath, [check], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        DIFFSPLAIN_CHECK_PROOF_MODE: '1',
        DIFFSPLAIN_CHECK_PROOF_FAIL_STAGE: stage,
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Check stopped: .* failed: proof failure/);
  });
}

test('release checks skip docs and still run each package check once', () => {
  const result = spawnSync(process.execPath, [check, '--skip-docs'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DIFFSPLAIN_CHECK_PROOF_MODE: '1',
      DIFFSPLAIN_CHECK_PROOF_FAIL_STAGE: 'docs',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout.split('\n').filter((line) => line.startsWith('✓ ')),
    [
      '✓ React and TypeScript lint',
      '✓ Production app build',
      '✓ Unit and integration tests',
      '✓ Packed-package smoke test',
    ],
  );
});

test('builds fresh assets before standalone package verification', () => {
  const result = spawnSync(process.execPath, [check, '--package-only'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DIFFSPLAIN_CHECK_PROOF_MODE: '1',
      DIFFSPLAIN_CHECK_PROOF_FAIL_STAGE: 'build',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Production app build failed: proof failure/);
});
