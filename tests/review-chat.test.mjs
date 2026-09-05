import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ReviewChatError,
  createCodingAgentChatProvider,
  createReviewChat,
} from '../scripts/review-chat.mjs';

function snapshot(fingerprint = 'review-one') {
  return {
    repo: { name: 'sample', base: 'base', head: 'head' },
    change: { title: 'Change' },
    files: [
      {
        path: 'visible.txt',
        status: 'modified',
        additions: 1,
        deletions: 1,
        isBinary: false,
        patch: '@@ -1 +1 @@\n-before\n+after\n',
        summary: { title: 'Visible cached note' },
      },
      {
        path: 'secret.txt',
        status: 'modified',
        additions: 1,
        deletions: 0,
        isBinary: false,
        patch: '@@ -1 +1 @@\n+secret\n',
        agentExcluded: true,
        summary: { title: 'Hidden cached note' },
      },
    ],
    notes: { reviewFingerprint: fingerprint, agentReviewFingerprint: 'agent-only' },
  };
}

function controlledProvider() {
  const calls = [];
  return {
    calls,
    run(input) {
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const call = { input, resolve, reject, cancelled: false };
      calls.push(call);
      return {
        promise,
        cancel() {
          call.cancelled = true;
        },
      };
    },
  };
}

function answer(path = 'visible.txt', markdown = 'Complete answer.') {
  return {
    markdown,
    citations: [{ path, startLine: 1, endLine: 1 }],
  };
}

function thread(state, scope, path, { current = true } = {}) {
  return state.threads.find((entry) =>
    entry.scope === scope && entry.path === path && entry.current === current,
  );
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Keep fixture polling on real time when a test controls provider deadlines.
const realSetTimeout = setTimeout;

function pause(milliseconds) {
  return new Promise((resolve) => realSetTimeout(resolve, milliseconds));
}

async function waitFor(read, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = read();
    if (predicate(value)) return value;
    await pause(5);
  }
  throw new Error(`Review chat did not settle: ${JSON.stringify(value)}`);
}

async function waitForFileNumber(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return Number((await readFile(path, 'utf8')).trim());
    } catch {
      await pause(5);
    }
  }
  throw new Error(`File was not written: ${path}`);
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-review-chat-'));
  const snapshotPath = join(directory, 'diff-data.json');
  await writeFile(snapshotPath, JSON.stringify(snapshot()));
  return { directory, snapshotPath };
}

test('keeps file and review threads separate and withholds excluded context', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const chat = createReviewChat({ snapshotPath: fixture.snapshotPath, provider });

  try {
    chat.command({ type: 'new', scope: 'file', path: 'secret.txt' });
    const started = chat.command({
      type: 'ask',
      scope: 'file',
      path: 'secret.txt',
      question: 'What changed?',
    });
    assert.equal(started.accepted, true);
    assert.equal(thread(chat.getState(), 'file', 'secret.txt').status, 'running');
    assert.deepEqual(
      provider.calls[0].input.review.review.files.map((file) => file.path),
      ['visible.txt'],
    );
    assert.equal(provider.calls[0].input.review.file.path, 'secret.txt');
    assert.deepEqual(provider.calls[0].input.history, []);
    assert.equal(provider.calls[0].input.question, 'What changed?');
    assert.match(JSON.stringify(provider.calls[0].input), /Visible cached note/);
    assert.doesNotMatch(JSON.stringify(provider.calls[0].input.review.file), /Hidden cached note/);
    provider.calls[0].resolve(answer('secret.txt'));
    await flush();

    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'Is it safe?' });
    const reviewInput = JSON.stringify(provider.calls[1].input);
    assert.doesNotMatch(reviewInput, /secret\.txt|Hidden cached note/);
    assert.match(reviewInput, /Visible cached note/);
    provider.calls[1].resolve(answer());
    await flush();

    assert.equal(thread(chat.getState(), 'file', 'secret.txt').status, 'ready');
    assert.equal(thread(chat.getState(), 'review').status, 'ready');
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('keeps large changed path sets out of the provider response schema', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const largeSnapshot = snapshot();
  largeSnapshot.files = Array.from({ length: 1_000 }, (_, index) => ({
    path: `changed-${String(index).padStart(4, '0')}.txt`,
    status: 'modified',
    additions: 1,
    deletions: 0,
    isBinary: false,
    patch: '@@ -1 +1 @@\n+after\n',
  }));
  await writeFile(fixture.snapshotPath, JSON.stringify(largeSnapshot));
  const chat = createReviewChat({ snapshotPath: fixture.snapshotPath, provider });

  try {
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'What changed?' });
    const schema = provider.calls[0].input.responseSchema;
    const citationPathSchema = schema.properties.citations.items.properties.path;
    assert.deepEqual(citationPathSchema, { type: 'string' });
    assert.doesNotMatch(JSON.stringify(schema), /changed-\d{4}\.txt/);
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('uses the full review fingerprint to stale threads and fences late output', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const chat = createReviewChat({ snapshotPath: fixture.snapshotPath, provider });

  try {
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'First?' });
    const active = provider.calls[0];
    await writeFile(fixture.snapshotPath, JSON.stringify(snapshot('review-two')));
    chat.refresh();
    assert.equal(active.cancelled, true);
    assert.equal(thread(chat.getState(), 'review').status, 'stale');
    active.resolve(answer());
    await flush();
    assert.equal(thread(chat.getState(), 'review').messages.length, 1);
    assert.throws(
      () => chat.command({ type: 'ask', scope: 'review', question: 'Again?' }),
      (error) => error instanceof ReviewChatError && error.status === 409,
    );

    const staleId = thread(chat.getState(), 'review').id;
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'Fresh?' });
    provider.calls[1].resolve(answer());
    await flush();
    const current = thread(chat.getState(), 'review');
    const stale = thread(chat.getState(), 'review', undefined, { current: false });
    assert.notEqual(current.id, staleId);
    assert.equal(current.messages.length, 2);
    assert.equal(stale.id, staleId);
    assert.equal(stale.status, 'stale');
    assert.equal(stale.messages.length, 1);
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('rereads the full fingerprint before accepting a provider result', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const chat = createReviewChat({ snapshotPath: fixture.snapshotPath, provider });

  try {
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'Race?' });
    await writeFile(fixture.snapshotPath, JSON.stringify(snapshot('review-later')));
    provider.calls[0].resolve(answer());
    await flush();
    const stale = thread(chat.getState(), 'review');
    assert.equal(stale.status, 'stale');
    assert.equal(stale.messages.length, 1);
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('uses different access instructions for snapshot and checkout providers', async () => {
  const fixture = await createFixture();
  const snapshotProvider = controlledProvider();
  const checkoutProvider = controlledProvider();
  const snapshotChat = createReviewChat({
    snapshotPath: fixture.snapshotPath,
    provider: snapshotProvider,
  });
  const checkoutChat = createReviewChat({
    snapshotPath: fixture.snapshotPath,
    provider: checkoutProvider,
    accessMode: { mode: 'checkout-read-only', root: '/review' },
  });

  try {
    snapshotChat.command({ type: 'new', scope: 'review' });
    snapshotChat.command({ type: 'ask', scope: 'review', question: 'Scope?' });
    checkoutChat.command({ type: 'new', scope: 'review' });
    checkoutChat.command({ type: 'ask', scope: 'review', question: 'Scope?' });
    assert.match(snapshotProvider.calls[0].input.prompt, /Use only the supplied review context/);
    assert.doesNotMatch(snapshotProvider.calls[0].input.prompt, /checkout inspection/);
    assert.match(checkoutProvider.calls[0].input.prompt, /checkout inspection/);
    assert.doesNotMatch(checkoutProvider.calls[0].input.prompt, /Use only the supplied review context/);
    assert.match(snapshotProvider.calls[0].input.prompt, /question field is the user\s+request/i);
    assert.doesNotMatch(snapshotProvider.calls[0].input.prompt, /conversation are evidence/i);
  } finally {
    snapshotChat.close();
    checkoutChat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('retains same-fingerprint threads across refresh and only accepts current file paths', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const chat = createReviewChat({ snapshotPath: fixture.snapshotPath, provider });

  try {
    chat.command({ type: 'new', scope: 'file', path: 'visible.txt' });
    const sameReview = snapshot('review-one');
    sameReview.notes.agentReviewFingerprint = 'changed-agent-only';
    await writeFile(fixture.snapshotPath, JSON.stringify(sameReview));
    chat.refresh();
    assert.equal(thread(chat.getState(), 'file', 'visible.txt').status, 'ready');
    assert.throws(
      () => chat.command({ type: 'new', scope: 'file', path: 'old-visible.txt' }),
      /not in the current review/i,
    );
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('keeps old output out after cancellation and retry', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const chat = createReviewChat({ snapshotPath: fixture.snapshotPath, provider });

  try {
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'Retry me.' });
    const first = provider.calls[0];
    chat.command({ type: 'cancel', scope: 'review' });
    assert.equal(first.cancelled, true);
    chat.command({ type: 'retry', scope: 'review' });
    first.resolve(answer());
    await flush();
    assert.equal(thread(chat.getState(), 'review').messages.length, 1);
    provider.calls[1].resolve(answer());
    await flush();
    assert.equal(thread(chat.getState(), 'review').messages.length, 2);
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('settles cancellation exactly once across provider rejection and close', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const lifecycle = [];
  const chat = createReviewChat({
    snapshotPath: fixture.snapshotPath,
    provider,
    onLifecycle: (event) => lifecycle.push(event),
  });

  try {
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'Cancel once.' });
    chat.command({ type: 'cancel', scope: 'review' });
    provider.calls[0].reject(new Error('late rejection'));
    chat.close();
    await flush();
    assert.deepEqual(
      lifecycle.filter((event) => event.terminal).map((event) => event.type),
      ['cancel'],
    );
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('times out an answer once, preserves retry state, and fences late output', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const lifecycle = [];
  const chat = createReviewChat({
    snapshotPath: fixture.snapshotPath,
    provider,
    runTimeoutMs: 30,
    onLifecycle: (event) => lifecycle.push(event),
  });

  try {
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'Keep this pending.' });
    const failed = await waitFor(
      () => thread(chat.getState(), 'review'),
      (value) => value.status === 'failed',
    );
    assert.equal(provider.calls[0].cancelled, true);
    assert.equal(failed.pendingQuestion, 'Keep this pending.');
    assert.equal(failed.canRetry, true);
    assert.match(failed.error, /timed out/i);
    provider.calls[0].resolve(answer('visible.txt', 'Late answer.'));
    await flush();
    assert.equal(thread(chat.getState(), 'review').messages.length, 1);
    assert.deepEqual(
      lifecycle.filter((event) => event.terminal).map((event) => event.type),
      ['timeout'],
    );
    assert.ok(lifecycle.some((event) => event.type === 'progress'));

    chat.command({ type: 'retry', scope: 'review' });
    provider.calls[1].resolve(answer());
    await flush();
    assert.equal(thread(chat.getState(), 'review').status, 'ready');
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('times out compaction into the existing retryable blocked state', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const chat = createReviewChat({
    snapshotPath: fixture.snapshotPath,
    provider,
    inputLimitBytes: 820,
    runTimeoutMs: 30,
  });

  try {
    chat.command({ type: 'new', scope: 'review' });
    await seedCompactionHistory(chat, provider);
    chat.command({ type: 'ask', scope: 'review', question: 'Question 5' });
    assert.equal(provider.calls.at(-1).input.kind, 'compact');
    const blocked = await waitFor(
      () => thread(chat.getState(), 'review'),
      (value) => value.status === 'blocked',
    );
    assert.equal(provider.calls.at(-1).cancelled, true);
    assert.equal(blocked.pendingQuestion, 'Question 5');
    assert.equal(blocked.canRetryCompaction, true);
    assert.match(blocked.error, /timed out/i);
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('timeout reaps a built-in provider child that ignores SIGTERM', async (context) => {
  const fixture = await createFixture();
  const binary = join(fixture.directory, 'codex');
  const pidPath = join(fixture.directory, 'provider.pid');
  await writeFile(binary, [
    '#!/usr/bin/env node',
    "process.on('SIGTERM', () => {});",
    `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    'setInterval(() => {}, 1_000);',
    '',
  ].join('\n'));
  await chmod(binary, 0o755);
  const provider = createCodingAgentChatProvider({ agent: 'codex', binary });
  const chat = createReviewChat({
    snapshotPath: fixture.snapshotPath,
    provider,
    runTimeoutMs: 500,
  });

  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'Please wait.' });
    const pid = await waitForFileNumber(pidPath, 10_000);
    assert.equal(thread(chat.getState(), 'review').status, 'running');
    context.mock.timers.tick(500);
    const failed = thread(chat.getState(), 'review');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /timed out/i);
    assert.doesNotThrow(() => process.kill(pid, 0));
    context.mock.timers.tick(250);
    await waitFor(
      () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      (running) => !running,
    );
  } finally {
    chat.close();
    context.mock.timers.tick(250);
    context.mock.timers.reset();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('reports structured usage for successful and failed provider calls', async () => {
  const fixture = await createFixture();
  const successBinary = join(fixture.directory, 'claude-success');
  const failureBinary = join(fixture.directory, 'claude-failure');
  const missingBinary = join(fixture.directory, 'claude-missing-usage');
  const usage = {
    input_tokens: 31,
    output_tokens: 7,
    cache_read_input_tokens: 19,
    cache_creation_input_tokens: 4,
  };
  await writeFile(successBinary, [
    '#!/usr/bin/env node',
    `process.stdout.write(${JSON.stringify(JSON.stringify({ structured_output: answer(), usage }))});`,
    '',
  ].join('\n'));
  await writeFile(failureBinary, [
    '#!/usr/bin/env node',
    `process.stdout.write(${JSON.stringify(JSON.stringify({ usage }))});`,
    'process.exitCode = 1;',
    '',
  ].join('\n'));
  await writeFile(missingBinary, [
    '#!/usr/bin/env node',
    `process.stdout.write(${JSON.stringify(JSON.stringify({ structured_output: answer() }))});`,
    '',
  ].join('\n'));
  await chmod(successBinary, 0o755);
  await chmod(failureBinary, 0o755);
  await chmod(missingBinary, 0o755);
  const events = [];
  const request = {
    prompt: 'Answer.',
    responseSchema: { type: 'object' },
  };

  try {
    const success = createCodingAgentChatProvider({
      agent: 'claude',
      binary: successBinary,
      onUsage: (event) => events.push(event),
    });
    assert.deepEqual(
      await success.run(request, { reviewFingerprint: 'review-one' }).promise,
      answer(),
    );
    success.close();

    const failure = createCodingAgentChatProvider({
      agent: 'claude',
      binary: failureBinary,
      onUsage: (event) => events.push(event),
    });
    await assert.rejects(
      failure.run(request, { reviewFingerprint: 'review-one' }).promise,
      /exited with status 1/,
    );
    failure.close();

    const missing = createCodingAgentChatProvider({
      agent: 'claude',
      binary: missingBinary,
      onUsage: (event) => events.push(event),
    });
    assert.deepEqual(
      await missing.run(request, { reviewFingerprint: 'review-one' }).promise,
      answer(),
    );
    missing.close();

    assert.deepEqual(events, [
      {
        reviewFingerprint: 'review-one',
        usage: {
          inputTokens: 31,
          outputTokens: 7,
          cacheReadTokens: 19,
          cacheWriteTokens: 4,
        },
      },
      {
        reviewFingerprint: 'review-one',
        usage: {
          inputTokens: 31,
          outputTokens: 7,
          cacheReadTokens: 19,
          cacheWriteTokens: 4,
        },
      },
      { reviewFingerprint: 'review-one', usage: undefined },
    ]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('uses Fast mode for Review chat provider calls', async () => {
  const fixture = await createFixture();
  const binary = join(fixture.directory, 'codex');
  const argsPath = join(fixture.directory, 'provider-args.json');
  await writeFile(binary, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
    'process.stdin.resume();',
    'process.stdin.on("end", () => process.stdout.write(JSON.stringify({ markdown: "Fast answer.", citations: [] })));',
    '',
  ].join('\n'));
  await chmod(binary, 0o755);
  const provider = createCodingAgentChatProvider({
    agent: 'codex',
    binary,
    fast: true,
  });
  const chat = createReviewChat({ snapshotPath: fixture.snapshotPath, provider });

  try {
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'Answer quickly.' });
    const ready = await waitFor(
      () => thread(chat.getState(), 'review'),
      (value) => value.status === 'ready' && value.messages.length === 2,
    );
    assert.equal(ready.messages.at(-1).answer.markdown, 'Fast answer.');
    const args = JSON.parse(await readFile(argsPath, 'utf8'));
    assert.ok(args.includes('service_tier="fast"'));
    assert.ok(args.includes('features.fast_mode=true'));
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('sends prior thread history to each fresh provider question', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const chat = createReviewChat({ snapshotPath: fixture.snapshotPath, provider });

  try {
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'First?' });
    provider.calls[0].resolve(answer());
    await flush();
    chat.command({ type: 'ask', scope: 'review', question: 'Second?' });
    assert.equal(provider.calls.length, 2);
    assert.deepEqual(provider.calls[1].input.history, [
      { role: 'user', text: 'First?' },
      { role: 'assistant', answer: answer() },
    ]);
    assert.equal(provider.calls[1].input.question, 'Second?');
    provider.calls[1].resolve(answer());
    await flush();
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('uses a renamed file current path while keeping its old path as evidence', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const chat = createReviewChat({ snapshotPath: fixture.snapshotPath, provider });

  try {
    const renamed = snapshot('review-renamed');
    renamed.files[0] = {
      ...renamed.files[0],
      path: 'renamed.txt',
      oldPath: 'visible.txt',
      status: 'renamed',
    };
    await writeFile(fixture.snapshotPath, JSON.stringify(renamed));
    chat.refresh();
    assert.throws(
      () => chat.command({ type: 'new', scope: 'file', path: 'visible.txt' }),
      /not in the current review/i,
    );
    chat.command({ type: 'new', scope: 'file', path: 'renamed.txt' });
    chat.command({
      type: 'ask',
      scope: 'file',
      path: 'renamed.txt',
      question: 'What moved?',
    });
    assert.equal(provider.calls[0].input.review.file.oldPath, 'visible.txt');
    provider.calls[0].resolve(answer('renamed.txt'));
    await flush();
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function seedCompactionHistory(chat, provider) {
  for (let index = 0; index < 5; index += 1) {
    chat.command({ type: 'ask', scope: 'review', question: `Question ${index}` });
    provider.calls.at(-1).resolve(answer());
    await flush();
  }
}

async function failCompaction(chat, provider, before) {
  chat.command({ type: 'ask', scope: 'review', question: 'Question 5' });
  const compact = provider.calls.at(-1);
  assert.equal(compact.input.kind, 'compact');
  assert.equal(thread(chat.getState(), 'review').status, 'compacting');
  compact.reject(new Error('Compaction failed'));
  await flush();
  const blocked = thread(chat.getState(), 'review');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.pendingQuestion, 'Question 5');
  assert.deepEqual(blocked.messages, before);
  assert.equal(blocked.canRetryCompaction, true);
  assert.throws(
    () => chat.command({ type: 'ask', scope: 'review', question: 'Blocked?' }),
    /Retry compaction/i,
  );
}

function pendingQuestionInHistory(input) {
  return input.history.some(
    (message) => message.role === 'user' && message.text === 'Question 5',
  );
}

async function retryCompaction(chat, provider, before) {
  chat.command({ type: 'retry-compaction', scope: 'review' });
  provider.calls.at(-1).resolve(answer());
  await flush();
  const retryAnswer = provider.calls.at(-1);
  assert.equal(retryAnswer.input.kind, 'answer');
  assert.equal(pendingQuestionInHistory(retryAnswer.input), false);
  retryAnswer.resolve(answer());
  await flush();
  const complete = thread(chat.getState(), 'review');
  assert.equal(complete.status, 'ready');
  assert.equal(complete.messages[0].role, 'compacted');
  assert.deepEqual(complete.messages.slice(1, 9), before.slice(-8));
  assert.equal(
    complete.messages.filter(
      (message) => message.role === 'user' && message.text === 'Question 5',
    ).length,
    1,
  );
}

async function exerciseCompaction(chat, provider) {
  chat.command({ type: 'new', scope: 'review' });
  await seedCompactionHistory(chat, provider);
  const before = structuredClone(thread(chat.getState(), 'review').messages);
  await failCompaction(chat, provider, before);
  await retryCompaction(chat, provider, before);
}

test('compacts older messages, restores them after failure, and retries the pending question', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const chat = createReviewChat({
    snapshotPath: fixture.snapshotPath,
    provider,
    inputLimitBytes: 820,
  });

  try {
    await exerciseCompaction(chat, provider);
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('blocks an over-limit short history without starting a compaction run', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const chat = createReviewChat({
    snapshotPath: fixture.snapshotPath,
    provider,
    inputLimitBytes: 300,
  });

  try {
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'First?' });
    provider.calls[0].resolve(answer('visible.txt', 'x'.repeat(500)));
    await flush();
    const before = structuredClone(thread(chat.getState(), 'review').messages);

    const result = chat.command({
      type: 'ask',
      scope: 'review',
      question: 'Second?',
    });
    assert.equal(result.accepted, false);
    const blocked = thread(chat.getState(), 'review');
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.pendingQuestion, 'Second?');
    assert.equal(blocked.canRetryCompaction, false);
    assert.deepEqual(blocked.messages, before);
    assert.equal(provider.calls.length, 1);

    assert.throws(
      () => chat.command({ type: 'retry-compaction', scope: 'review' }),
      (error) => error instanceof ReviewChatError && error.status === 409,
    );
    assert.equal(provider.calls.length, 1);
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('blocks when the required eight-message tail exceeds the input limit', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const chat = createReviewChat({
    snapshotPath: fixture.snapshotPath,
    provider,
    inputLimitBytes: 800,
  });

  try {
    chat.command({ type: 'new', scope: 'review' });
    for (let index = 0; index < 4; index += 1) {
      chat.command({ type: 'ask', scope: 'review', question: `Question ${index}` });
      provider.calls.at(-1).resolve(answer());
      await flush();
    }
    chat.command({ type: 'ask', scope: 'review', question: 'Question 4' });
    provider.calls.at(-1).resolve(answer('visible.txt', 'x'.repeat(500)));
    await flush();
    const before = structuredClone(thread(chat.getState(), 'review').messages);

    const result = chat.command({
      type: 'ask',
      scope: 'review',
      question: 'Question 5',
    });
    assert.equal(result.accepted, false);
    const blocked = thread(chat.getState(), 'review');
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.pendingQuestion, 'Question 5');
    assert.equal(blocked.canRetryCompaction, false);
    assert.deepEqual(blocked.messages, before);
    assert.equal(provider.calls.length, 5);
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects bad citations and preserves a failed question for retry', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const chat = createReviewChat({ snapshotPath: fixture.snapshotPath, provider });

  try {
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'Cite it.' });
    provider.calls[0].resolve({
      markdown: 'Bad citation.',
      citations: [{ path: 'missing.txt', startLine: 1, endLine: 1 }],
    });
    await flush();
    const failed = thread(chat.getState(), 'review');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /current visible file path/);
    assert.equal(failed.pendingQuestion, 'Cite it.');
    chat.command({ type: 'retry', scope: 'review' });
    provider.calls[1].resolve(answer());
    await flush();
    assert.equal(thread(chat.getState(), 'review').status, 'ready');
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('does not discard a live thread after a transient snapshot read error', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const changes = [];
  const chat = createReviewChat({
    snapshotPath: fixture.snapshotPath,
    provider,
    onChange: (state) => changes.push(state),
  });

  try {
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'Pause here.' });
    const active = provider.calls[0];
    await writeFile(fixture.snapshotPath, '{');
    chat.refresh();
    assert.equal(thread(chat.getState(), 'review').status, 'running');
    assert.match(chat.getState().error, /snapshot/i);
    for (const command of [
      { type: 'new', scope: 'review' },
      { type: 'ask', scope: 'review', question: 'Blocked?' },
      { type: 'retry', scope: 'review' },
      { type: 'retry-compaction', scope: 'review' },
    ]) {
      assert.throws(
        () => chat.command(command),
        (error) => error instanceof ReviewChatError && error.status === 409,
      );
    }
    chat.command({ type: 'cancel', scope: 'review' });
    assert.equal(active.cancelled, true);
    assert.equal(thread(chat.getState(), 'review').status, 'cancelled');
    await writeFile(fixture.snapshotPath, JSON.stringify(snapshot()));
    chat.refresh();
    assert.equal(thread(chat.getState(), 'review').status, 'cancelled');
    assert.equal(chat.getState().error, undefined);
    assert.equal(changes.at(-1).error, undefined);
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('makes a settled answer retryable when its completion sees a broken snapshot', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const chat = createReviewChat({ snapshotPath: fixture.snapshotPath, provider });

  try {
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'Recover?' });
    await writeFile(fixture.snapshotPath, '{');
    provider.calls[0].resolve(answer());
    await flush();
    const failed = thread(chat.getState(), 'review');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.pendingQuestion, 'Recover?');
    assert.equal(failed.canRetry, true);
    assert.equal(failed.messages.length, 1);
    await writeFile(fixture.snapshotPath, JSON.stringify(snapshot()));
    chat.refresh();
    chat.command({ type: 'retry', scope: 'review' });
    provider.calls[1].resolve(answer());
    await flush();
    assert.equal(thread(chat.getState(), 'review').status, 'ready');
  } finally {
    chat.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('cancels active work and clears in-memory state on close', async () => {
  const fixture = await createFixture();
  const provider = controlledProvider();
  const chat = createReviewChat({ snapshotPath: fixture.snapshotPath, provider });

  try {
    chat.command({ type: 'new', scope: 'review' });
    chat.command({ type: 'ask', scope: 'review', question: 'Stop.' });
    const active = provider.calls[0];
    chat.close();
    assert.equal(active.cancelled, true);
    assert.deepEqual(chat.getState().threads, []);
    assert.equal(chat.getState().fingerprint, null);
    active.resolve(answer());
    await flush();
    assert.deepEqual(chat.getState().threads, []);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
