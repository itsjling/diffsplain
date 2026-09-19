import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  agentFallbackRecordNeeded,
  agentRunCompleted,
  agentRunFailed,
  agentRunNeeded,
  agentRunSuperseded,
  browserCommand,
  ensureBuiltAssets,
  failedAgentRunForFingerprint,
  nextAgentFingerprint,
  openBrowser,
  preserveAgentNotes,
} from '../scripts/presenter-runtime.mjs';

const url = 'http://localhost:2299';

test('does not schedule a completed agent fingerprint again', () => {
  assert.equal(agentRunNeeded('same', { completedFingerprint: 'same' }), false);
  assert.equal(agentRunNeeded('same', { activeFingerprint: 'same' }), false);
  assert.equal(agentRunNeeded('same', { failedFingerprint: 'same' }), false);
  assert.equal(
    agentRunNeeded('changed', { completedFingerprint: 'same' }),
    true,
  );
});

test('does not complete a superseded agent job that exits cleanly', () => {
  assert.equal(
    agentRunCompleted({
      code: 0,
      error: undefined,
      signal: null,
      superseded: true,
    }),
    false,
  );
  assert.equal(
    agentRunCompleted({
      code: 0,
      error: undefined,
      signal: null,
      superseded: false,
    }),
    true,
  );
});

test('classifies failed agent runs and selects pending work', () => {
  const failure = new Error('agent failed');
  assert.equal(agentRunSuperseded('next', 'current'), true);
  assert.equal(agentRunSuperseded('current', 'current'), false);
  assert.equal(
    agentFallbackRecordNeeded({
      closing: false,
      error: failure,
    }),
    true,
  );
  assert.equal(
    agentFallbackRecordNeeded({
      closing: false,
      queuedFingerprint: 'next',
      error: failure,
    }),
    false,
  );
  assert.equal(
    agentFallbackRecordNeeded({
      closing: false,
      code: 1,
    }),
    false,
  );
  assert.equal(
    agentRunFailed({
      closing: false,
      code: 1,
      superseded: false,
    }),
    true,
  );
  assert.equal(
    agentRunFailed({
      closing: false,
      code: 1,
      superseded: true,
    }),
    false,
  );
  assert.equal(
    nextAgentFingerprint({
      queuedFingerprint: 'next',
      observedFingerprint: 'observed',
      finishedFingerprint: 'current',
    }),
    'next',
  );
  assert.equal(
    nextAgentFingerprint({
      observedFingerprint: 'observed',
      finishedFingerprint: 'current',
    }),
    'observed',
  );
  assert.equal(
    nextAgentFingerprint({
      observedFingerprint: 'current',
      finishedFingerprint: 'current',
    }),
    undefined,
  );
});

test('retries a failed fingerprint after observing another diff', () => {
  let failedFingerprint = 'first';
  assert.equal(
    agentRunNeeded('first', { failedFingerprint }),
    false,
  );

  failedFingerprint = failedAgentRunForFingerprint(
    failedFingerprint,
    'second',
  );
  assert.equal(failedFingerprint, undefined);
  assert.equal(
    agentRunNeeded('first', { failedFingerprint }),
    true,
  );
});

test('selects a browser command for every supported platform', () => {
  assert.deepEqual(browserCommand({ url, platform: 'darwin' }), {
    command: 'open',
    args: [url],
  });
  assert.deepEqual(browserCommand({ url, platform: 'win32' }), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'start', '', url],
  });
  assert.deepEqual(browserCommand({ url, platform: 'linux' }), {
    command: 'xdg-open',
    args: [url],
  });
  assert.deepEqual(browserCommand({ url, browser: '/custom/browser' }), {
    command: '/custom/browser',
    args: [url],
  });
});

test('reports browser launch failures without throwing', () => {
  const child = new EventEmitter();
  let unref = false;
  child.unref = () => {
    unref = true;
  };
  const failures = [];

  openBrowser(url, {
    platform: 'linux',
    spawnProcess: (command, args, options) => {
      assert.equal(command, 'xdg-open');
      assert.deepEqual(args, [url]);
      assert.deepEqual(options, { detached: true, stdio: 'ignore' });
      return child;
    },
    onError: (error) => failures.push(error.message),
  });
  child.emit('error', new Error('browser missing'));

  assert.deepEqual(failures, ['browser missing']);
  assert.equal(unref, true);
});

test('builds missing assets once and reports a failed build clearly', () => {
  const files = new Set();
  const exists = (file) => files.has(file);
  const calls = [];
  const root = '/tmp/diffsplain';
  const index = `${root}/dist/index.html`;
  const assets = `${root}/dist/assets`;

  assert.equal(
    ensureBuiltAssets({
      root,
      exists,
      run: (command, args) => {
        calls.push({ command, args });
        files.add(index);
        files.add(assets);
        return { status: 0 };
      },
    }),
    true,
  );
  assert.deepEqual(calls, [{ command: 'npm', args: ['run', 'build'] }]);
  assert.equal(ensureBuiltAssets({ root, exists, run: () => assert.fail() }), false);

  let failedCalls = 0;
  assert.throws(
    () =>
      ensureBuiltAssets({
        root: '/tmp/missing-diffsplain',
        exists: () => false,
        run: () => {
          failedCalls += 1;
          return { status: 2 };
        },
      }),
    /npm run build exited with 2/i,
  );
  assert.equal(failedCalls, 1);
});

function refreshFixture() {
  const previous = {
    repo: { target: { pullRequest: { state: 'OPEN' } } },
    change: { title: 'Agent title', summary: 'Agent summary', why: 'Agent reason', highlights: [], risks: [], url: 'old-url' },
    files: [{ path: 'a.txt', sourceUrl: 'old-source', summary: { title: 'Agent note' }, noteReady: true }],
    notes: { reviewFingerprint: 'review', agentReviewFingerprint: 'agent', generatedFor: 'agent', fresh: true, complete: false, changeReady: true, totalFiles: 1, updatedAt: '2026-09-19T01:00:02.000Z' },
    usage: { agentNotes: { calls: 2 } },
  };
  const raw = structuredClone(previous);
  raw.repo.target.pullRequest.state = 'CLOSED';
  raw.change = { ...raw.change, title: 'New PR title', summary: 'Fallback summary', url: 'new-url' };
  raw.files[0] = { ...raw.files[0], sourceUrl: 'new-source', comparisonUrl: 'new-comparison', summary: { title: 'Fallback note' }, noteReady: false, noteFailure: 'Stale failure' };
  raw.notes.changeReady = false;
  raw.notes.updatedAt = '2026-09-19T01:00:01.000Z';
  raw.usage.agentNotes.calls = 0;
  return { previous, raw };
}

test('refreshes metadata while preserving published agent notes and usage', () => {
  const { previous, raw } = refreshFixture();
  const merged = preserveAgentNotes(raw, previous);
  assert.equal(merged.repo.target.pullRequest.state, 'CLOSED');
  assert.equal(merged.change.url, 'new-url');
  assert.equal(merged.change.title, 'Agent title');
  assert.equal(merged.change.summary, 'Agent summary');
  assert.equal(merged.files[0].sourceUrl, 'new-source');
  assert.equal(merged.files[0].comparisonUrl, 'new-comparison');
  assert.deepEqual(merged.files[0].summary, previous.files[0].summary);
  assert.equal(merged.files[0].noteReady, true);
  assert.equal(Object.hasOwn(merged.files[0], 'noteFailure'), false);
  assert.deepEqual(merged.notes, previous.notes);
  assert.deepEqual(merged.usage, previous.usage);
  assert.equal(raw.files[0].noteReady, false);
});

test('refreshes fallback change text until an agent change note is ready', () => {
  const { previous, raw } = refreshFixture();
  previous.notes.changeReady = false;
  assert.deepEqual(preserveAgentNotes(raw, previous).change, raw.change);
});

test('does not carry notes across changed reviews or stale agent output', () => {
  const { previous, raw } = refreshFixture();
  for (const notes of [
    { ...previous.notes, reviewFingerprint: 'other-review' },
    { ...previous.notes, agentReviewFingerprint: 'other-agent-review' },
    { ...previous.notes, generatedFor: 'old-agent-review' },
    { ...previous.notes, fresh: false },
  ]) {
    assert.equal(preserveAgentNotes(raw, { ...previous, notes }), raw);
  }
  assert.equal(preserveAgentNotes(raw), raw);
});

test('accepts newer agent progress from shared saved notes', () => {
  const { previous, raw } = refreshFixture();
  raw.notes.updatedAt = '2026-09-19T01:00:03.000Z';
  raw.notes.complete = true;
  raw.notes.changeReady = true;
  raw.files[0].noteReady = true;
  raw.files[0].summary = { title: 'Newer completed note' };
  delete raw.files[0].noteFailure;
  assert.equal(preserveAgentNotes(raw, previous), raw);
  raw.notes.updatedAt = previous.notes.updatedAt;
  assert.equal(preserveAgentNotes(raw, previous), raw);
  delete previous.notes.updatedAt;
  assert.equal(preserveAgentNotes(raw, previous), raw);
});
