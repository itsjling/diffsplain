import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePackageManifest } from '../scripts/check.mjs';

const requiredFiles = [
  'README.md',
  'package.json',
  'dist/index.html',
  'scripts/access-token.mjs',
  'scripts/agent-exclusions.mjs',
  'scripts/agent-review.mjs',
  'scripts/build-diff-data.mjs',
  'scripts/cache.mjs',
  'scripts/cli-args.mjs',
  'scripts/coding-agents.mjs',
  'scripts/dev.mjs',
  'scripts/doctor.mjs',
  'scripts/generate-summaries.mjs',
  'scripts/local-target.mjs',
  'scripts/mock-agent.mjs',
  'scripts/present.mjs',
  'scripts/presenter-runtime.mjs',
  'scripts/serve-built.mjs',
  'scripts/summary-path.mjs',
  'scripts/support-record.mjs',
];

function manifest(files = requiredFiles.map((path) => ({ path, size: 1 }))) {
  return { files, unpackedSize: 1 };
}

test('accepts the required package manifest', () => {
  assert.doesNotThrow(() => validatePackageManifest(manifest()));
});

test('rejects missing, private, unexpected, and oversized package files', () => {
  assert.throws(
    () => validatePackageManifest(manifest(requiredFiles.slice(1).map((path) => ({ path, size: 1 })))),
    /missing README\.md/,
  );
  assert.throws(
    () => validatePackageManifest(manifest([...requiredFiles.map((path) => ({ path, size: 1 })), { path: '.env', size: 1 }])),
    /private .env/,
  );
  assert.throws(
    () => validatePackageManifest(manifest([...requiredFiles.map((path) => ({ path, size: 1 })), { path: 'notes.txt', size: 1 }])),
    /unexpected notes\.txt/,
  );
  assert.throws(
    () => validatePackageManifest(manifest([...requiredFiles.map((path) => ({ path, size: 1 })), { path: 'dist/large.js', size: 1_000_001 }])),
    /file exceeds 1 MB/,
  );
  assert.throws(
    () => validatePackageManifest({ ...manifest(), unpackedSize: 12_000_001 }),
    /package exceeds 12 MB/,
  );
});
