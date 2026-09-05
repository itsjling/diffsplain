import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

async function json(path) {
  return JSON.parse(
    await readFile(new URL(`../${path}`, import.meta.url), 'utf8'),
  );
}

function listedTests(command) {
  return command.match(/tests\/[^ ]+\.test\.mjs/g) || [];
}

function workflowSteps(workflow) {
  return [...workflow.matchAll(
    /^(?<indent> *)- name: (?<name>.+)\n(?<body>(?:^\k<indent> {2}.+(?:\n|$))*)/gm,
  )].map(({ groups }) => groups);
}

function assertPnpmCacheSetup(workflow, expectedCount) {
  const steps = workflowSteps(workflow);
  const nodeSetups = steps
    .map((step, index) => ({ ...step, index }))
    .filter(({ body }) => body.includes('uses: actions/setup-node@v6'));

  assert.equal(nodeSetups.length, expectedCount);
  for (const { body, index } of nodeSetups) {
    assert.match(body, /^\s+cache: pnpm$/m);
    assert.match(body, /^\s+cache-dependency-path: pnpm-lock.yaml$/m);
    assert.ok(index > 0, 'Node setup must follow pnpm setup');
    assert.match(steps[index - 1].body, /^\s+uses: pnpm\/action-setup@v4$/m);
  }
  assert.doesNotMatch(workflow, /^\s+run: corepack(?: pnpm)?\b/m);
}

test('keeps the test lanes separate and composes the complete test gate', async () => {
  const packageJson = await json('package.json');
  const scripts = packageJson.scripts;

  for (const lane of [
    'test:unit',
    'test:integration',
    'test:coverage',
    'test:browser',
    'test:platform',
  ]) {
    assert.ok(scripts[lane], `${lane} must be a named command`);
  }
  assert.equal(
    scripts.test,
    'pnpm run test:coverage && pnpm run test:browser && pnpm run test:platform',
  );
  assert.doesNotMatch(scripts['test:unit'], /browser|pnpm run build/);
  assert.match(scripts['test:integration'], /pnpm run build/);
  assert.match(scripts['test:integration'], /--test-concurrency=1/);
  assert.equal(scripts['test:coverage'], 'c8 pnpm run test:core');
  assert.equal(scripts['test:core'], 'pnpm run test:unit && pnpm run test:integration');
  assert.doesNotMatch(scripts['test:integration'], /live-update-speed/);
  assert.equal(scripts['benchmark:live-update'], 'node benchmarks/live-update-speed.mjs');
  assert.equal(
    scripts['test:browser'],
    'pnpm run build && node --test tests/browser/*.test.mjs',
  );
  assert.match(scripts['test:browser'], /pnpm run build/);
  assert.doesNotMatch(scripts['test:browser'], /playwright install/);
  assert.match(scripts['test:browser:install'], /playwright install chromium/);

  const currentTests = (await readdir(new URL('../tests/', import.meta.url)))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `tests/${name}`)
    .sort();
  const assignedTests = [
    ...listedTests(scripts['test:unit']),
    ...listedTests(scripts['test:integration']),
    ...listedTests(scripts['test:platform']),
  ];
  assert.equal(
    new Set(assignedTests).size,
    assignedTests.length,
    'unit, integration, and platform lanes must not overlap',
  );
  assert.deepEqual(
    assignedTests.sort(),
    currentTests,
    'each top-level test file must belong to one complete-gate lane',
  );
});

test('holds each core path to the documented coverage floor', async () => {
  const config = await json('.c8rc.json');

  assert.equal(config['check-coverage'], true);
  assert.equal(config['per-file'], true);
  assert.deepEqual(config.include, [
    'scripts/cli-args.mjs',
    'scripts/build-diff-data.mjs',
    'scripts/agent-note-output.mjs',
    'scripts/generate-summaries.mjs',
    'scripts/present.mjs',
    'scripts/serve-built.mjs',
  ]);
  assert.deepEqual(
    {
      statements: config.statements,
      branches: config.branches,
      functions: config.functions,
      lines: config.lines,
    },
    { statements: 80, branches: 60, functions: 90, lines: 80 },
  );
  assert.ok(config.reporter.includes('json-summary'));
  assert.ok(config.reporter.includes('lcov'));
});

test('runs pull request lanes on Linux and scheduled shell checks elsewhere', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/test-lanes.yml', import.meta.url),
    'utf8',
  );

  for (const command of [
    'pnpm run test:unit',
    'pnpm run test:coverage',
    'pnpm run test:browser',
    'pnpm run test:platform',
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(':', '\\:')));
  }
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /macos-15/);
  assert.match(workflow, /windows-2025/);
  assert.equal(
    workflow.match(/run: pnpm install --frozen-lockfile/g)?.length,
    4,
  );
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /pull_request_target:|secrets\.|write-all/);
});

test('installs pnpm before each Node setup and caches dependencies', async () => {
  const productGate = await readFile(
    new URL('../.github/workflows/product-gate.yml', import.meta.url),
    'utf8',
  );
  const testLanes = await readFile(
    new URL('../.github/workflows/test-lanes.yml', import.meta.url),
    'utf8',
  );

  assertPnpmCacheSetup(productGate, 1);
  assertPnpmCacheSetup(testLanes, 4);
});
