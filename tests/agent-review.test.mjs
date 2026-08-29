import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentReviewContext,
  agentReviewFingerprintFromSnapshot,
} from '../scripts/agent-review.mjs';

test('keeps stable agent target context and drops resolved object ids', () => {
  const context = agentReviewContext({
    name: 'owner/repo',
    selector: 'github.example/owner/repo',
    branch: 'feature',
    baseBranch: 'main',
    target: {
      kind: 'pull-request',
      remote: 'origin',
      repository: 'github.example/owner/repo',
      pullRequest: { number: 42, updatedAt: 'now' },
      base: { ref: 'main', oid: 'a'.repeat(40) },
      head: {
        ref: 'feature',
        oid: 'b'.repeat(40),
        repository: 'fork/repo',
      },
      mergeBaseOid: 'c'.repeat(40),
    },
  });

  assert.deepEqual(context, {
    name: 'owner/repo',
    selector: 'github.example/owner/repo',
    target: {
      kind: 'pull-request',
      branch: 'feature',
      baseBranch: 'main',
      remote: 'origin',
      repository: 'github.example/owner/repo',
      pullRequest: 42,
      base: 'main',
      head: { ref: 'feature', repository: 'fork/repo' },
    },
  });
});

test('fingerprints only files available to the agent', () => {
  const snapshot = {
    repo: {
      name: 'owner/repo',
      target: {
        kind: 'range',
        base: { ref: 'main', oid: 'a'.repeat(40) },
        head: { ref: 'feature', oid: 'b'.repeat(40) },
      },
    },
    files: [
      { path: 'included.txt', status: 'modified', patch: 'included' },
      {
        path: 'secret.txt',
        status: 'modified',
        patch: 'first secret',
        agentExcluded: true,
      },
    ],
  };

  const initial = agentReviewFingerprintFromSnapshot(snapshot);
  snapshot.files[1].patch = 'changed secret';
  assert.equal(agentReviewFingerprintFromSnapshot(snapshot), initial);
  snapshot.files[0].patch = 'changed included';
  assert.notEqual(agentReviewFingerprintFromSnapshot(snapshot), initial);
});
