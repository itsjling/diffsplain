import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePackageManifest } from '../scripts/check.mjs';

const requiredFiles = [
  'README.md',
  'LICENSE',
  'package.json',
  'dist/index.html',
  'scripts/access-token.mjs',
  'scripts/agent-usage.mjs',
  'scripts/agent-config.mjs',
  'scripts/agent-exclusions.mjs',
  'scripts/agent-note-output.mjs',
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
  'scripts/review-chat.mjs',
  'scripts/review-chat-context.mjs',
  'scripts/review-chat-controller.mjs',
  'scripts/review-chat-provider.mjs',
  'scripts/serve-built.mjs',
  'scripts/summary-path.mjs',
  'scripts/support-record.mjs',
];

function manifest(files = requiredFiles.map((path) => ({ path, size: 1 }))) {
  return { files, unpackedSize: 1 };
}

test('accepts the required package manifest', () => {
  assert.doesNotThrow(() => validatePackageManifest(manifest(), { license: 'MIT' }));
});

test('rejects missing, private, unexpected, and oversized package files', () => {
  assert.throws(
    () => validatePackageManifest(manifest(requiredFiles.slice(1).map((path) => ({ path, size: 1 }))), { license: 'MIT' }),
    /missing README\.md/,
  );
  assert.throws(
    () => validatePackageManifest(manifest([...requiredFiles.map((path) => ({ path, size: 1 })), { path: '.env', size: 1 }]), { license: 'MIT' }),
    /private .env/,
  );
  assert.throws(
    () => validatePackageManifest(manifest([...requiredFiles.map((path) => ({ path, size: 1 })), { path: 'notes.txt', size: 1 }]), { license: 'MIT' }),
    /unexpected notes\.txt/,
  );
  assert.throws(
    () => validatePackageManifest(manifest([...requiredFiles.map((path) => ({ path, size: 1 })), { path: 'dist/large.js', size: 1_000_001 }]), { license: 'MIT' }),
    /file exceeds 1 MB/,
  );
  assert.throws(
    () => validatePackageManifest({ ...manifest(), unpackedSize: 12_000_001 }, { license: 'MIT' }),
    /package exceeds 12 MB/,
  );
});

test('rejects missing license text or metadata that is not MIT', () => {
  assert.throws(
    () => validatePackageManifest(
      manifest(requiredFiles.filter((path) => path !== 'LICENSE').map((path) => ({ path, size: 1 }))),
      { license: 'MIT' },
    ),
    /missing LICENSE/,
  );
  assert.throws(
    () => validatePackageManifest(manifest(), {}),
    /missing package license/,
  );
  assert.throws(
    () => validatePackageManifest(manifest(), { license: 'Apache-2.0' }),
    /license Apache-2\.0 does not match MIT/,
  );
});
