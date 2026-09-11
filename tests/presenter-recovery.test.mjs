import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const script = new URL('../scripts/present.mjs', import.meta.url).pathname;

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function makeRepo(root, paths) {
  const repo = join(root, 'repo');
  await mkdir(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'diffsplain@example.test');
  git(repo, 'config', 'user.name', 'Diffsplain');
  git(repo, 'config', 'commit.gpgsign', 'false');
  for (const path of paths) await writeFile(join(repo, path), 'before\n');
  git(repo, 'add', ...paths);
  git(repo, 'commit', '-qm', 'base');
  for (const path of paths) await writeFile(join(repo, path), 'after\n');
  return repo;
}

async function readIfReady(read) {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

async function waitFor(read, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await readIfReady(read);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for presenter recovery');
}

function stop(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Presenter did not stop after SIGTERM')),
      5_000,
    );
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', reject);
    child.kill('SIGTERM');
  });
}

function present(repo, summaries, output, codex, environment = {}, target = ['--worktree']) {
  return spawn(
    process.execPath,
    [
      script,
      '--repo',
      repo,
      ...target,
      '--agent',
      'codex',
      '--summaries',
      summaries,
      '--output',
      output,
      '--codex-bin',
      codex,
      '--batch-size',
      '1',
      '--jobs',
      '1',
      '--no-browser',
      '--port',
      '0',
    ],
    {
      cwd: dirname(summaries),
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function recordedCalls(text) {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function stopIfRunning(child) {
  if (child?.exitCode === null) await stop(child);
}

test('leaves a failed agent job recoverable without retrying it in a loop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-present-failure-'));
  const repo = await makeRepo(root, ['changed.txt']);
  const summaries = join(root, 'notes.json');
  const output = join(root, 'diff-data.json');
  const codex = join(root, 'failing-codex.mjs');
  const calls = join(root, 'calls.log');
  let presenter;

  try {
    await writeFile(
      codex,
      `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const paths = input.files.map((file) => file.path);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(paths) + '\\n');
if (paths.length) {
  process.stderr.write('planned agent failure\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ change: {
  title: 'Change note',
  summary: 'Keeps the failed file job recoverable.',
  why: 'Tests the presenter retry policy.',
  highlights: [],
  risks: [],
} }));
`,
    );
    await chmod(codex, 0o755);
    presenter = present(repo, summaries, output, codex);

    const failed = await waitFor(async () => {
      const notes = JSON.parse(await readFile(summaries, 'utf8'));
      return notes.meta?.status === 'failed' ? notes : undefined;
    });
    assert.equal(failed.meta.status, 'failed');
    assert.equal(presenter.exitCode, null);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const attempted = recordedCalls(await readFile(calls, 'utf8'));
    assert.equal(
      attempted.filter((paths) => paths.includes('changed.txt')).length,
      1,
    );
  } finally {
    await stopIfRunning(presenter);
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps completed notes and resumes only queued work after cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-present-resume-'));
  const repo = await makeRepo(root, ['first.txt', 'second.txt']);
  const summaries = join(root, 'notes.json');
  const output = join(root, 'diff-data.json');
  const codex = join(root, 'resumable-codex.mjs');
  const calls = join(root, 'calls.jsonl');
  const resume = join(root, 'resume');
  let first;
  let second;

  try {
    await writeFile(
      codex,
      `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const paths = input.files.map((file) => file.path);
const priorCalls = existsSync(${JSON.stringify(calls)})
  ? readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').filter(Boolean).length
  : 0;
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(paths) + '\\n');
if (paths.length && priorCalls === 1 && !existsSync(${JSON.stringify(resume)})) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
}
const response = paths.length
  ? { files: input.files.map((file) => ({
      path: file.path,
      title: 'Note for ' + file.path,
      what: 'Explains ' + file.path + '.',
      why: 'Covers recovery.',
      details: [],
      risks: [],
    })) }
  : { change: {
      title: 'Recovered change',
      summary: 'Resumes the remaining note.',
      why: 'Keeps completed work.',
      highlights: [],
      risks: [],
    } };
process.stdout.write(JSON.stringify(response));
`,
    );
    await chmod(codex, 0o755);
    first = present(repo, summaries, output, codex);

    const progress = await waitFor(async () => {
      const notes = JSON.parse(await readFile(summaries, 'utf8'));
      const seen = recordedCalls(await readFile(calls, 'utf8'));
      const fileAttempts = seen.filter((paths) => paths.length);
      return fileAttempts.length >= 2 && notes.files?.[fileAttempts[0][0]]
        ? { notes, fileAttempts }
        : undefined;
    });
    assert.deepEqual(await stop(first), { code: 0, signal: null });
    first = undefined;

    const partial = JSON.parse(await readFile(summaries, 'utf8'));
    const completedPath = progress.fileAttempts[0][0];
    const queuedPath = progress.fileAttempts[1][0];
    assert.notEqual(completedPath, queuedPath);
    assert.deepEqual(Object.keys(partial.files), [completedPath]);
    assert.equal(partial.meta.status, 'generating');

    await writeFile(resume, '');
    second = present(repo, summaries, output, codex);
    const complete = await waitFor(async () => {
      const notes = JSON.parse(await readFile(summaries, 'utf8'));
      return notes.meta?.status === 'complete' ? notes : undefined;
    });
    assert.deepEqual(Object.keys(complete.files).sort(), ['first.txt', 'second.txt']);
    assert.equal(complete.change.title, 'Recovered change');

    const attempted = recordedCalls(await readFile(calls, 'utf8'));
    assert.equal(attempted.filter((paths) => paths[0] === completedPath).length, 1);
    assert.equal(attempted.filter((paths) => paths[0] === queuedPath).length, 2);
    assert.equal(attempted.filter((paths) => paths.length === 0).length, 1);
  } finally {
    await stopIfRunning(first);
    await stopIfRunning(second);
    await rm(root, { recursive: true, force: true });
  }
});


test('serves completed notes and lets an active agent finish during a remote outage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-remote-recovery-'));
  const repo = await makeRepo(root, ['changed.txt']);
  const remote = join(root, 'remote.git');
  const bin = join(root, 'bin');
  const failure = join(root, 'offline');
  const release = join(root, 'release-agent');
  const active = join(root, 'agent-active');
  const calls = join(root, 'calls.jsonl');
  const summaries = join(root, 'notes.json');
  const output = join(root, 'snapshot.json');
  const codex = join(root, 'codex.mjs');
  let presenter;
  let logs = '';
  try {
    git(repo, 'branch', '-M', 'main');
    git(repo, 'switch', '-qc', 'feature');
    git(repo, 'commit', '-qam', 'feature');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'main', 'feature');
    git(repo, 'switch', '-q', 'main');
    await mkdir(bin);
    await writeFile(join(bin, 'git'), `#!/usr/bin/env node
const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('fetch') && existsSync(${JSON.stringify(failure)})) {
  process.stderr.write('fatal: Failed to connect to github.com port 443');
  process.exit(128);
}
const result = spawnSync('git', process.argv.slice(2), {
  env: { ...process.env, PATH: process.env.RECOVERY_REAL_PATH }, stdio: 'inherit',
});
process.exit(result.status ?? 1);
`);
    await chmod(join(bin, 'git'), 0o755);
    await writeFile(codex, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const paths = input.files.map((file) => file.path);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(paths) + '\\n');
if (!paths.length) {
  writeFileSync(${JSON.stringify(active)}, 'active');
  while (!existsSync(${JSON.stringify(release)})) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
process.stdout.write(JSON.stringify({
  change: { title: 'Feature', summary: 'Updates text.', why: 'Tests recovery.', highlights: [], risks: [] },
  files: paths.map((path) => ({ path, title: 'Updated text', what: 'Changes text.', why: 'Tests recovery.', details: [], risks: [] })),
}));
`);
    await chmod(codex, 0o755);
    presenter = present(repo, summaries, output, codex, {
      PATH: `${bin}:${process.env.PATH}`,
      RECOVERY_REAL_PATH: process.env.PATH,
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_CONFIG_HOME: join(root, 'config'),
      DIFFSPLAIN_WATCH_INTERVAL_MS: '50',
      DIFFSPLAIN_REMOTE_REFRESH_INTERVAL_MS: '200',
    }, ['--branch', 'feature', '--base', 'main']);
    presenter.stdout.on('data', (chunk) => { logs += chunk; });
    presenter.stderr.on('data', (chunk) => { logs += chunk; });
    const ready = await waitFor(() => {
      const line = logs.split('\n').find((value) => value.startsWith('{"event":"ready"'));
      return line && JSON.parse(line);
    });
    const url = new URL('diff-data.json', ready.url);
    url.searchParams.set('access', ready.access);
    const served = async () => {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      return response.json();
    };
    await waitFor(() => readFile(active, 'utf8'));
    const before = await served();
    assert.equal(before.files[0].noteReady, true);
    assert.equal(before.notes.status, 'generating');
    await writeFile(failure, 'offline');
    await waitFor(() => (logs.match(/Keeping the last valid review/g) || []).length >= 2);
    assert.equal(presenter.exitCode, null, logs);
    assert.deepEqual(await served(), before);
    await writeFile(release, 'finish');
    const completed = await waitFor(async () => {
      const snapshot = await served();
      return snapshot.notes.complete && snapshot;
    });
    assert.equal(completed.files[0].noteReady, true);
    const callsBefore = await readFile(calls, 'utf8');
    const notesBefore = await readFile(summaries, 'utf8');
    await rm(failure);
    await waitFor(() => logs.includes('Remote refresh recovered'));
    const recovered = await served();
    assert.deepEqual(recovered.files, completed.files);
    assert.deepEqual(recovered.change, completed.change);
    assert.deepEqual(recovered.notes, completed.notes);
    assert.deepEqual(recovered.repo, completed.repo);
    assert.equal(await readFile(calls, 'utf8'), callsBefore);
    assert.equal(await readFile(summaries, 'utf8'), notesBefore);
    const stopped = await stop(presenter);
    assert.equal(stopped.code, 0);
    await assert.rejects(fetch(url));
  } catch (error) {
    throw new Error(`${error.message}\n${logs}`, { cause: error });
  } finally {
    await stopIfRunning(presenter);
    await rm(root, { recursive: true, force: true });
  }
});
