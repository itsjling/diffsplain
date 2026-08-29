import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentExclusionMatcher } from '../scripts/agent-exclusions.mjs';

test('applies repeated gitignore rules in order, including negation', () => {
  const excludes = createAgentExclusionMatcher([
    'generated/**',
    '!generated/keep.txt',
    '*.log',
    '!keep.log',
  ]);

  assert.equal(excludes('generated/drop.txt'), true);
  assert.equal(excludes('generated/keep.txt'), false);
  assert.equal(excludes('trace.log'), true);
  assert.equal(excludes('keep.log'), false);
});

test('uses Git core.ignoreCase behavior when requested', () => {
  const excludes = createAgentExclusionMatcher(['PRIVATE/**'], {
    ignoreCase: true,
  });

  assert.equal(excludes('private/secret.txt'), true);
  assert.equal(excludes('Private/secret.txt'), true);
});

test('matches the caller supplied path without consulting a rename source path', () => {
  const excludes = createAgentExclusionMatcher(['old-secret.txt']);

  assert.equal(excludes('new-visible.txt'), false);
  assert.equal(excludes('old-secret.txt'), true);
});

test('keeps gitignore escape sequences in rules intact', () => {
  const excludes = createAgentExclusionMatcher(['literal\\*.txt']);

  assert.equal(excludes('literal*.txt'), true);
  assert.equal(excludes('literal-name.txt'), false);
});
