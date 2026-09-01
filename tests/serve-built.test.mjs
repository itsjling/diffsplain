import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('../scripts/serve-built.mjs', import.meta.url).pathname;

function start(args, env = process.env) {
  return spawn(process.execPath, [script, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => {
      reject(new Error(`Built server did not report readiness: ${output}`));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      for (const line of output.split('\n')) {
        try {
          const event = JSON.parse(line);
          if (event.event === 'ready') {
            clearTimeout(timer);
            resolve(event);
            return;
          }
        } catch {
          // The server also writes a browser URL.
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Built server exited with ${code}: ${output}${errors}`));
    });
  });
}

function stop(child) {
  return new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
    child.kill('SIGTERM');
  });
}

function within(promise, message, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeout);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function providerPid(path) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return Number((await readFile(path, 'utf8')).trim());
    } catch {
      await pause(25);
    }
  }
  throw new Error('Provider did not record its process ID');
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return;
    await pause(25);
  }
  throw new Error(`Provider process ${pid} did not exit`);
}

async function waitForFile(path, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch {
      await pause(25);
    }
  }
  throw new Error(message);
}

async function stopIfRunning(child) {
  if (child?.exitCode === null) await stop(child);
}

function waitForText(stream, pattern) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`Did not find ${pattern}: ${output}`));
    }, 10_000);
    stream.on('data', (chunk) => {
      output += chunk;
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve(output);
      }
    });
  });
}

async function readUntil(reader, pattern) {
  const decoder = new TextDecoder();
  let output = '';
  while (!pattern.test(output)) {
    const next = await within(reader.read(), `Did not find ${pattern}: ${output}`);
    if (next.done) throw new Error(`Stream ended before ${pattern}: ${output}`);
    output += decoder.decode(next.value, { stream: true });
  }
  return output;
}

function reviewUrl(ready, path) {
  const url = new URL(path, ready.url);
  url.searchParams.set('access', ready.access);
  return url;
}

async function waitForChat(ready, condition) {
  const deadline = Date.now() + 10_000;
  let state;
  while (Date.now() < deadline) {
    const response = await fetch(reviewUrl(ready, 'api/chat'));
    state = await response.json();
    if (condition(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Chat state did not settle: ${JSON.stringify(state)}`);
}

function rawRequest(
  ready,
  {
    host = 'localhost',
    method = 'GET',
    path = '/',
    headers = {},
    body,
    chunks,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      host,
      port: ready.port,
      method,
      path,
      headers: { Host: `${host}:${ready.port}`, ...headers },
    };
    const client = request(requestOptions, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    client.once('error', reject);
    if (chunks) {
      for (const chunk of chunks) client.write(chunk);
      client.end();
      return;
    }
    client.end(body);
  });
}

function unavailableChatArgs(output, access, previousAccess) {
  return [
    '--output',
    output,
    '--port',
    '0',
    '--access',
    access,
    '--previous-access',
    previousAccess,
  ];
}

async function startUnavailableChat(directory, access, previousAccess) {
  const output = join(directory, 'diff-data.json');
  await writeFile(output, JSON.stringify({
    files: [],
    notes: { reviewFingerprint: 'review-one' },
  }));
  const child = start(unavailableChatArgs(output, access, previousAccess));
  const ready = await waitForReady(child);
  return { child, output, ready };
}

function chatRequests(ready, chatPath, previousAccess) {
  const command = JSON.stringify({ type: 'new', scope: 'review' });
  return Promise.all([
    rawRequest(ready, { path: chatPath }),
    rawRequest(ready, { path: '/api/chat' }),
    rawRequest(ready, { path: `/api/chat?access=${previousAccess}` }),
    rawRequest(ready, { method: 'POST', path: chatPath, body: command }),
    rawRequest(ready, {
      method: 'POST',
      path: chatPath,
      headers: { 'Content-Type': 'application/json' },
      body: command,
    }),
    rawRequest(ready, {
      method: 'POST',
      path: chatPath,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'new', scope: 'review', extra: true }),
    }),
    rawRequest(ready, {
      method: 'POST',
      path: chatPath,
      headers: { 'Content-Type': 'application/json' },
      chunks: [Buffer.alloc(40_000, 'a'), Buffer.alloc(40_000, 'b')],
    }),
  ]);
}

function assertChatRequests(results) {
  const [current, missing, prior, noJson, unavailable, unknown, oversized] = results;
  assert.equal(current.status, 200);
  assert.equal(current.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(current.body).available, false);
  assert.equal(missing.status, 403);
  assert.equal(prior.status, 403);
  assert.equal(noJson.status, 415);
  assert.equal(unavailable.status, 409);
  assert.equal(unknown.status, 400);
  assert.equal(oversized.status, 413);
}

async function waitForChatEvent(ready, output) {
  const response = await fetch(reviewUrl(ready, 'events'));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = decoder.decode((await reader.read()).value);
  await writeFile(output, JSON.stringify({
    files: [],
    notes: { reviewFingerprint: 'review-two' },
  }));
  while (!buffered.includes('event: chat')) {
    const next = await within(reader.read(), 'Server did not send a chat event');
    assert.equal(next.done, false);
    buffered += decoder.decode(next.value);
  }
  return reader;
}

function providerSnapshot({ withUsage = true } = {}) {
  const value = {
    version: 'provider-one',
    generatedAt: new Date().toISOString(),
    files: [{
      path: 'changed.txt',
      status: 'modified',
      additions: 1,
      deletions: 1,
      isBinary: false,
      patch: '@@ -1 +1 @@\n-before\n+after\n',
    }],
    notes: { reviewFingerprint: 'review-one' },
  };
  if (withUsage) {
    value.usage = {
      agentNotes: {
        status: 'complete',
        calls: 1,
        reportedCalls: 1,
        tokens: { inputTokens: 50, outputTokens: 10 },
      },
      reviewChat: {
        status: 'complete',
        calls: 0,
        reportedCalls: 0,
        tokens: { inputTokens: 0, outputTokens: 0 },
      },
      combined: {
        status: 'complete',
        calls: 1,
        reportedCalls: 1,
        tokens: { inputTokens: 50, outputTokens: 10 },
      },
    };
  }
  return value;
}

function providerScript(calls, argumentsLog) {
  return [
    '#!/usr/bin/env node',
    "const { appendFileSync } = require('node:fs');",
    `appendFileSync(${JSON.stringify(calls)}, 'run\\n');`,
    `appendFileSync(${JSON.stringify(argumentsLog)}, process.argv.slice(2).join('\\n') + '\\n');`,
    `console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(JSON.stringify({ markdown: 'Complete answer.', citations: [] }))} } }));`,
    "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3, cached_input_tokens: 2 } }));",
    '',
  ].join('\n');
}

async function snapshotReadBarrier(directory, output) {
  const preloader = join(directory, 'pause-snapshot-read.cjs');
  const reached = join(directory, 'snapshot-read-reached');
  const release = join(directory, 'snapshot-read-release');
  await writeFile(preloader, [
    "const { existsSync, writeFileSync } = require('node:fs');",
    "const promises = require('node:fs/promises');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const { resolve } = require('node:path');",
    "const { fileURLToPath } = require('node:url');",
    'const readFile = promises.readFile;',
    'promises.readFile = async function (file, ...args) {',
    '  const value = await readFile.call(this, file, ...args);',
    '  const path = file instanceof URL ? fileURLToPath(file) : file;',
    `  if (typeof path === 'string' && resolve(path) === ${JSON.stringify(output)} && !existsSync(${JSON.stringify(reached)})) {`,
    `    writeFileSync(${JSON.stringify(reached)}, 'reached\\n');`,
    `    while (!existsSync(${JSON.stringify(release)})) {`,
    '      await new Promise((done) => setTimeout(done, 10));',
    '    }',
    '  }',
    '  return value;',
    '};',
    'syncBuiltinESMExports();',
    '',
  ].join('\n'));
  return {
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloader}`]
        .filter(Boolean)
        .join(' '),
    },
    reached,
    release,
  };
}

async function writeProviderFixture(output, provider, calls, argumentsLog) {
  await writeFile(output, JSON.stringify(providerSnapshot()));
  await writeFile(provider, providerScript(calls, argumentsLog));
  await chmod(provider, 0o755);
}

function selectedProviderArgs(output, provider) {
  return [
    '--output',
    output,
    '--port',
    '0',
    '--chat-agent',
    'codex',
    '--chat-binary',
    provider,
    '--chat-model',
    'test-model',
    '--chat-reasoning',
    'low',
  ];
}

function chatCommand(endpoint, body) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function askProviderChat(endpoint, question) {
  const response = await chatCommand(endpoint, {
    type: 'ask',
    scope: 'review',
    question,
  });
  assert.equal(response.status, 202);
}

async function exerciseSelectedProvider(ready, calls, argumentsLog) {
  const endpoint = reviewUrl(ready, 'api/chat');
  const newThread = await chatCommand(endpoint, { type: 'new', scope: 'review' });
  assert.equal(newThread.status, 200);
  await askProviderChat(endpoint, 'Why?');
  const complete = await waitForChat(
    ready,
    (state) => state.threads[0]?.status === 'ready',
  );
  assert.deepEqual(complete.threads[0].messages.at(-1).answer, {
    markdown: 'Complete answer.',
    citations: [],
  });
  await askProviderChat(endpoint, 'And then?');
  const secondComplete = await waitForChat(
    ready,
    (state) => state.threads[0]?.messages.length === 4,
  );
  assert.equal(secondComplete.threads[0].status, 'ready');
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), ['run', 'run']);
  const argumentsText = await readFile(argumentsLog, 'utf8');
  assert.match(argumentsText, /--model\ntest-model/);
  assert.match(argumentsText, /model_reasoning_effort="low"/);
  const snapshot = await fetch(reviewUrl(ready, 'diff-data.json')).then(
    (response) => response.json(),
  );
  assert.deepEqual(snapshot.usage.reviewChat, {
    status: 'complete',
    calls: 2,
    reportedCalls: 2,
    tokens: { inputTokens: 14, outputTokens: 6, cacheReadTokens: 4 },
  });
  assert.deepEqual(snapshot.usage.combined.tokens, {
    inputTokens: 64,
    outputTokens: 16,
    cacheReadTokens: 4,
  });
}

test('requires a per-run access value for data and event routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-server-'));
  const output = join(directory, 'diff-data.json');
  let child;

  try {
    await writeFile(output, JSON.stringify({ version: 'test-version' }));
    child = start(['--output', output, '--port', '0']);
    const ready = await waitForReady(child);
    assert.match(ready.access, /^[A-Za-z0-9_-]{43}$/);

    const [page, data, deniedData, deniedEvents] = await Promise.all([
      fetch(ready.url),
      fetch(reviewUrl(ready, 'diff-data.json')),
      fetch(new URL('diff-data.json', ready.url)),
      fetch(new URL('events', ready.url)),
    ]);
    const health = await fetch(new URL('health', ready.url));
    assert.equal(page.status, 200);
    assert.equal(data.status, 200);
    assert.deepEqual(await data.json(), { version: 'test-version' });
    assert.equal(deniedData.status, 403);
    assert.equal(deniedEvents.status, 403);
    assert.deepEqual(await health.json(), {
      status: 'ok',
      address: ready.address,
      port: ready.port,
    });
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.match(
      page.headers.get('content-security-policy'),
      /style-src 'self' 'unsafe-inline'/,
    );
    assert.equal(page.headers.get('x-frame-options'), 'DENY');

    const html = await page.text();
    const asset = html.match(/\.\/assets\/[^"']+\.js/)?.[0];
    assert.ok(asset);
    const assetResponse = await fetch(new URL(asset, ready.url));
    assert.match(assetResponse.headers.get('cache-control'), /immutable/);
  } finally {
    if (child && child.exitCode === null) await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('hands a prior protected tab the current access value', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-handoff-'));
  const output = join(directory, 'diff-data.json');
  const access = 'a'.repeat(43);
  const previousAccess = 'b'.repeat(43);
  let child;
  let reader;

  try {
    await writeFile(output, '{}');
    child = start([
      '--output',
      output,
      '--port',
      '0',
      '--access',
      access,
      '--previous-access',
      previousAccess,
    ]);
    const ready = await waitForReady(child);
    const events = new URL('events', ready.url);
    events.searchParams.set('access', previousAccess);
    const data = new URL('diff-data.json', ready.url);
    data.searchParams.set('access', previousAccess);
    const [response, deniedData] = await Promise.all([
      fetch(events),
      fetch(data),
    ]);
    assert.equal(response.status, 200);
    assert.equal(deniedData.status, 403);
    reader = response.body.getReader();
    const initialEvents = await readUntil(reader, /event: access/);
    assert.match(initialEvents, /event: access/);
    assert.match(initialEvents, new RegExp(access));
  } finally {
    await reader?.cancel();
    if (child && child.exitCode === null) await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('protects chat state and accepts only strict, bounded JSON commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-chat-server-'));
  const access = 'a'.repeat(43);
  const previousAccess = 'b'.repeat(43);
  let child;
  let reader;

  try {
    const fixture = await startUnavailableChat(directory, access, previousAccess);
    child = fixture.child;
    const { output, ready } = fixture;
    const chatPath = `/api/chat?access=${access}`;
    assertChatRequests(await chatRequests(ready, chatPath, previousAccess));
    reader = await waitForChatEvent(ready, output);
  } finally {
    await reader?.cancel();
    if (child && child.exitCode === null) await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('starts complete chat answers asynchronously with the selected provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-chat-provider-'));
  const output = join(directory, 'diff-data.json');
  const provider = join(directory, 'codex');
  const calls = join(directory, 'calls.log');
  const argumentsLog = join(directory, 'args.log');
  let child;

  try {
    await writeProviderFixture(output, provider, calls, argumentsLog);
    child = start(selectedProviderArgs(output, provider));
    const ready = await waitForReady(child);
    const lifecycle = waitForText(child.stdout, /answer completed/);
    await exerciseSelectedProvider(ready, calls, argumentsLog);
    const outputText = await lifecycle;
    assert.match(outputText, /Diffsplain chat #\d+: answer started/);
    assert.match(outputText, /Review chat usage: input 7, output 3, cache read 2/);
    assert.match(outputText, /Combined agent usage: input 57, output 13, cache read 2/);
    assert.doesNotMatch(outputText, /Why\?|And then\?|changed\.txt|Complete answer/);
  } finally {
    if (child && child.exitCode === null) await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('adds live chat usage to snapshots without preseeded note usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-chat-usage-'));
  const output = join(directory, 'diff-data.json');
  const provider = join(directory, 'codex');
  const calls = join(directory, 'calls.log');
  const argumentsLog = join(directory, 'args.log');
  let child;

  try {
    await writeFile(output, JSON.stringify(providerSnapshot({ withUsage: false })));
    await writeFile(provider, providerScript(calls, argumentsLog));
    await chmod(provider, 0o755);
    child = start(selectedProviderArgs(output, provider));
    const ready = await waitForReady(child);
    const endpoint = reviewUrl(ready, 'api/chat');
    await chatCommand(endpoint, { type: 'new', scope: 'review' });
    await askProviderChat(endpoint, 'Why?');
    await waitForChat(ready, (state) => state.threads[0]?.status === 'ready');

    const snapshot = await fetch(reviewUrl(ready, 'diff-data.json')).then(
      (response) => response.json(),
    );
    assert.deepEqual(snapshot.usage.agentNotes, {
      status: 'complete',
      calls: 0,
      reportedCalls: 0,
      tokens: { inputTokens: 0, outputTokens: 0 },
    });
    assert.deepEqual(snapshot.usage.reviewChat, {
      status: 'complete',
      calls: 1,
      reportedCalls: 1,
      tokens: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 },
    });
    assert.deepEqual(snapshot.usage.combined.tokens, {
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 2,
    });

    const nextReview = providerSnapshot({ withUsage: false });
    nextReview.version = 'provider-two';
    nextReview.notes.reviewFingerprint = 'review-two';
    await writeFile(output, JSON.stringify(nextReview));
    const resetSnapshot = await fetch(reviewUrl(ready, 'diff-data.json')).then(
      (response) => response.json(),
    );
    assert.deepEqual(resetSnapshot.usage.reviewChat, {
      status: 'complete',
      calls: 0,
      reportedCalls: 0,
      tokens: { inputTokens: 0, outputTokens: 0 },
    });
    assert.deepEqual(
      resetSnapshot.usage.combined,
      resetSnapshot.usage.agentNotes,
    );
  } finally {
    if (child && child.exitCode === null) await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps current chat usage when a stale snapshot response finishes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-chat-usage-race-'));
  const output = join(directory, 'diff-data.json');
  const provider = join(directory, 'codex');
  const calls = join(directory, 'calls.log');
  const argumentsLog = join(directory, 'args.log');
  let child;

  try {
    await writeProviderFixture(output, provider, calls, argumentsLog);
    const barrier = await snapshotReadBarrier(directory, output);
    child = start(selectedProviderArgs(output, provider), barrier.env);
    const ready = await waitForReady(child);
    const endpoint = reviewUrl(ready, 'api/chat');

    const staleResponse = fetch(reviewUrl(ready, 'diff-data.json')).then(
      (response) => response.json(),
    );
    await waitForFile(
      barrier.reached,
      'The stale snapshot response did not reach its read barrier',
    );

    const nextReview = providerSnapshot({ withUsage: false });
    nextReview.version = 'provider-two';
    nextReview.notes.reviewFingerprint = 'review-two';
    await writeFile(output, JSON.stringify(nextReview));
    await waitForChat(ready, (state) => state.fingerprint === 'review-two');
    await chatCommand(endpoint, { type: 'new', scope: 'review' });
    await askProviderChat(endpoint, 'Why now?');
    await waitForChat(ready, (state) => state.threads[0]?.status === 'ready');

    await writeFile(barrier.release, 'release\n');
    await staleResponse;
    const current = await fetch(reviewUrl(ready, 'diff-data.json')).then(
      (response) => response.json(),
    );
    assert.deepEqual(current.usage.reviewChat, {
      status: 'complete',
      calls: 1,
      reportedCalls: 1,
      tokens: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 },
    });
  } finally {
    if (child && child.exitCode === null) await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('reports provider failures to chat state and redacted stdout lifecycle logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-chat-error-'));
  const output = join(directory, 'diff-data.json');
  const provider = join(directory, 'codex');
  const calls = join(directory, 'calls.txt');
  let child;

  try {
    await writeFile(output, JSON.stringify(providerSnapshot()));
    await writeFile(provider, [
      '#!/usr/bin/env node',
      "const { existsSync, readFileSync, writeFileSync } = require('node:fs');",
      `const calls = existsSync(${JSON.stringify(calls)}) ? Number(readFileSync(${JSON.stringify(calls)}, 'utf8')) + 1 : 1;`,
      `writeFileSync(${JSON.stringify(calls)}, String(calls));`,
      "if (calls > 1) console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ markdown: 'Recovered answer.', citations: [] }) } }));",
      "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 4, cached_input_tokens: 3, cache_write_input_tokens: 1 } }));",
      "if (calls === 1) console.error('raw-provider-diagnostic');",
      'if (calls === 1) process.exitCode = 7;',
      '',
    ].join('\n'));
    await chmod(provider, 0o755);
    child = start(selectedProviderArgs(output, provider));
    const ready = await waitForReady(child);
    const lifecycle = waitForText(child.stdout, /answer failed/);
    const endpoint = reviewUrl(ready, 'api/chat');
    await chatCommand(endpoint, { type: 'new', scope: 'review' });
    await askProviderChat(endpoint, 'private-question');
    const failed = await waitForChat(
      ready,
      (state) => state.threads[0]?.status === 'failed',
    );
    assert.match(failed.threads[0].error, /raw-provider-diagnostic/);
    const outputText = await lifecycle;
    assert.match(outputText, /codex exited with status 7/);
    assert.doesNotMatch(
      outputText,
      /private-question|changed\.txt|raw-provider-diagnostic|responseSchema/,
    );

    const afterFailure = await fetch(reviewUrl(ready, 'diff-data.json')).then(
      (response) => response.json(),
    );
    assert.deepEqual(afterFailure.usage.reviewChat, {
      status: 'complete',
      calls: 1,
      reportedCalls: 1,
      tokens: {
        inputTokens: 9,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
      },
    });

    const completedLifecycle = waitForText(child.stdout, /answer completed/);
    const retry = await chatCommand(endpoint, { type: 'retry', scope: 'review' });
    assert.equal(retry.status, 202);
    const recovered = await waitForChat(
      ready,
      (state) => state.threads[0]?.status === 'ready',
    );
    assert.equal(
      recovered.threads[0].messages.at(-1).answer.markdown,
      'Recovered answer.',
    );
    await completedLifecycle;
    const afterRetry = await fetch(reviewUrl(ready, 'diff-data.json')).then(
      (response) => response.json(),
    );
    assert.deepEqual(afterRetry.usage.reviewChat, {
      status: 'complete',
      calls: 2,
      reportedCalls: 2,
      tokens: {
        inputTokens: 18,
        outputTokens: 8,
        cacheReadTokens: 6,
        cacheWriteTokens: 2,
      },
    });
  } finally {
    if (child && child.exitCode === null) await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('forces shutdown after a provider ignores SIGTERM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-chat-shutdown-'));
  const output = join(directory, 'diff-data.json');
  const provider = join(directory, 'codex');
  const providerPidPath = join(directory, 'provider.pid');
  let child;

  try {
    await writeFile(output, JSON.stringify({
      files: [],
      notes: { reviewFingerprint: 'review-one' },
    }));
    await writeFile(provider, [
      '#!/usr/bin/env node',
      `require('node:fs').writeFileSync(${JSON.stringify(providerPidPath)}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1_000);',
      '',
    ].join('\n'));
    await chmod(provider, 0o755);
    child = start([
      '--output',
      output,
      '--port',
      '0',
      '--chat-agent',
      'codex',
      '--chat-binary',
      provider,
    ]);
    const ready = await waitForReady(child);
    const endpoint = reviewUrl(ready, 'api/chat');
    const newThread = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'new', scope: 'review' }),
    });
    assert.equal(newThread.status, 200);
    const ask = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'ask', scope: 'review', question: 'Wait?' }),
    });
    assert.equal(ask.status, 202);
    const pid = await providerPid(providerPidPath);
    await within(stop(child), 'Server did not force-stop the provider', 5_000);
    await waitForProcessExit(pid);
    assert.equal(child.signalCode, null);
  } finally {
    if (child && child.exitCode === null) await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects hostile hosts, origins, methods, and malformed paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-hostile-'));
  const output = join(directory, 'diff-data.json');
  let child;

  try {
    await writeFile(output, '{}');
    child = start(['--output', output, '--port', '0']);
    const ready = await waitForReady(child);
    const [host, origin, method, traversal, authority, malformed] =
      await Promise.all([
        rawRequest(ready, { headers: { Host: 'attacker.test' } }),
        rawRequest(ready, { headers: { Origin: 'http://attacker.test' } }),
        rawRequest(ready, { method: 'POST' }),
        rawRequest(ready, { path: '/%2e%2e/package.json' }),
        rawRequest(ready, { path: '//attacker.test/' }),
        rawRequest(ready, { path: '/%' }),
      ]);
    assert.equal(host.status, 400);
    assert.equal(origin.status, 403);
    assert.equal(method.status, 405);
    assert.equal(traversal.status, 400);
    assert.equal(authority.status, 400);
    assert.equal(malformed.status, 400);
  } finally {
    if (child && child.exitCode === null) await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('guards an explicit remote bind with host, origin, and access checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-remote-'));
  const output = join(directory, 'diff-data.json');
  let child;

  try {
    await writeFile(output, JSON.stringify({ version: 'remote' }));
    child = start([
      '--output',
      output,
      '--port',
      '0',
      '--host',
      '0.0.0.0',
    ]);
    const warning = waitForText(child.stderr, /access value/i);
    const ready = await waitForReady(child);
    await warning;
    assert.equal(ready.address, '0.0.0.0');

    const path = `/diff-data.json?access=${ready.access}`;
    const origin = `http://127.0.0.1:${ready.port}`;
    const [allowed, missingAccess, hostileOrigin] = await Promise.all([
      rawRequest(ready, {
        host: '127.0.0.1',
        path,
        headers: { Origin: origin },
      }),
      rawRequest(ready, {
        host: '127.0.0.1',
        path: '/diff-data.json',
        headers: { Origin: origin },
      }),
      rawRequest(ready, {
        host: '127.0.0.1',
        path,
        headers: { Origin: 'http://attacker.test' },
      }),
    ]);
    assert.equal(allowed.status, 200);
    assert.deepEqual(JSON.parse(allowed.body), { version: 'remote' });
    assert.equal(missingAccess.status, 403);
    assert.equal(hostileOrigin.status, 403);
  } finally {
    if (child && child.exitCode === null) await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('contains handler failures and keeps the review server available', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-failure-'));
  const output = join(directory, 'diff-data.json');
  let child;

  try {
    await writeFile(output, '{}');
    child = start(['--output', output, '--port', '0'], {
      ...process.env,
      DIFFSPLAIN_TEST_HANDLER_FAILURE: '1',
    });
    const ready = await waitForReady(child);
    const logged = waitForText(child.stdout, /Diffsplain request handler error/);
    const failed = await rawRequest(ready, { path: '/__test/fail' });
    assert.equal(failed.status, 500);
    assert.equal(failed.body, 'Internal server error');
    assert.doesNotMatch(failed.body, /forced|handler/i);
    assert.equal((await fetch(ready.url)).status, 200);
    assert.equal(child.exitCode, null);
    assert.match(await logged, /forced request handler failure/);
  } finally {
    if (child && child.exitCode === null) await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves live updates and closes event streams on shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-events-'));
  const output = join(directory, 'diff-data.json');
  let child;
  let reader;

  try {
    await writeFile(output, JSON.stringify({ version: 'before' }));
    child = start(['--output', output, '--port', '0', '--project', 'project-key']);
    const ready = await waitForReady(child);
    const events = reviewUrl(ready, 'events');
    events.searchParams.set('project', 'project-key');
    const response = await fetch(events);
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = decoder.decode((await reader.read()).value);
    assert.match(buffered, /event: ready/);

    await writeFile(output, JSON.stringify({ version: 'after' }));
    while (!buffered.includes('event: update')) {
      const next = await within(
        reader.read(),
        'Server did not send an update event',
      );
      assert.equal(next.done, false);
      buffered += decoder.decode(next.value);
    }
    assert.equal(await stop(child), 0);
    const closed = await reader.read();
    assert.equal(closed.done, true);
    await assert.rejects(fetch(ready.url));
  } finally {
    await reader?.cancel();
    if (child && child.exitCode === null) await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails on an occupied fixed port and increments only when asked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-port-'));
  const output = join(directory, 'diff-data.json');
  const blocker = createServer();
  let fixed;
  let incremented;

  try {
    await writeFile(output, '{}');
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, 'localhost', resolve);
    });
    const address = blocker.address();
    assert.ok(address && typeof address === 'object');

    fixed = start(['--output', output, '--port', String(address.port)]);
    const fixedOutput = await new Promise((resolve) => {
      let outputText = '';
      fixed.stderr.on('data', (chunk) => {
        outputText += chunk;
      });
      fixed.once('exit', (code) => resolve({ code, outputText }));
    });
    assert.equal(fixedOutput.code, 1);
    assert.match(fixedOutput.outputText, /port .*already in use/i);

    incremented = start([
      '--output',
      output,
      '--port',
      String(address.port),
      '--increment-port',
    ]);
    const ready = await waitForReady(incremented);
    assert.ok(ready.port > address.port);
  } finally {
    await stopIfRunning(fixed);
    await stopIfRunning(incremented);
    await new Promise((resolve) => blocker.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
