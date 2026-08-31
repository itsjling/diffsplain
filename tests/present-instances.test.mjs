import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { summaryPath } from '../scripts/summary-path.mjs';

const script = new URL('../scripts/present.mjs', import.meta.url).pathname;

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function makeRepo(root, name, file) {
  const repo = join(root, name);
  await mkdir(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'diffsplain@example.test');
  git(repo, 'config', 'user.name', 'Diffsplain');
  git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, file), 'before\n');
  git(repo, 'add', file);
  git(repo, 'commit', '-qm', 'base');
  await writeFile(join(repo, file), 'after\n');
  return repo;
}

function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`Presenter did not start: ${output}`));
    }, 12_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Diffsplain: (http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Presenter exited with ${code}: ${output}`));
    });
  });
}

function waitForText(stream, pattern) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`Did not find ${pattern}: ${output}`));
    }, 12_000);
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
    const next = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Did not find ${pattern}: ${output}`)),
        12_000,
      );
      reader.read().then(
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
    if (next.done) throw new Error(`Stream ended before ${pattern}: ${output}`);
    output += decoder.decode(next.value, { stream: true });
  }
  return output;
}

async function waitFor(read, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('Timed out waiting for presenter data');
}

function stop(child) {
  return new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
    child.kill('SIGTERM');
  });
}

function reviewUrl(base, path) {
  const url = new URL(path, base);
  const access = new URLSearchParams(new URL(base).hash.slice(1)).get('access');
  if (access) url.searchParams.set('access', access);
  return url;
}

test('keeps simultaneous presenters on separate ports and data files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-instances-'));
  const browser = join(root, 'browser');
  const browserLog = join(root, 'browser.log');
  let first;
  let second;

  try {
    const firstRepo = await makeRepo(root, 'repo-one', 'one.txt');
    const secondRepo = await makeRepo(root, 'repo-two', 'two.txt');
    await writeFile(
      browser,
      '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$BROWSER_LOG"\n',
    );
    await chmod(browser, 0o755);

    const environment = {
      ...process.env,
      BROWSER: browser,
      BROWSER_LOG: browserLog,
    };
    first = spawn(
      process.execPath,
      [script, '--repo', firstRepo, '--worktree', '--no-agent'],
      { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    second = spawn(
      process.execPath,
      [script, '--repo', secondRepo, '--worktree', '--no-agent'],
      { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const [firstUrl, secondUrl] = await Promise.all([
      waitForUrl(first),
      waitForUrl(second),
    ]);
    assert.notEqual(new URL(firstUrl).port, new URL(secondUrl).port);

    const [firstData, secondData] = await Promise.all([
      waitFor(async () => {
        const response = await fetch(reviewUrl(firstUrl, 'diff-data.json'));
        return response.ok ? response.json() : undefined;
      }),
      waitFor(async () => {
        const response = await fetch(reviewUrl(secondUrl, 'diff-data.json'));
        return response.ok ? response.json() : undefined;
      }),
    ]);
    assert.equal(firstData.repo.name, 'repo-one');
    assert.deepEqual(firstData.files.map((file) => file.path), ['one.txt']);
    assert.equal(secondData.repo.name, 'repo-two');
    assert.deepEqual(secondData.files.map((file) => file.path), ['two.txt']);

    const opened = await waitFor(async () => {
      const urls = (await readFile(browserLog, 'utf8')).trim().split('\n');
      return urls.length === 2 ? urls : undefined;
    });
    assert.deepEqual(new Set(opened), new Set([firstUrl, secondUrl]));
  } finally {
    if (first && first.exitCode === null) await stop(first);
    if (second && second.exitCode === null) await stop(second);
    await rm(root, { recursive: true, force: true });
  }
});

test('does not expose cached notes when --no-agent is set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-no-agent-'));
  let summaries;
  let child;

  try {
    const repo = await makeRepo(root, 'repo', 'note.txt');
    const cacheBase = join(root, 'cache');
    summaries = summaryPath({
      cacheRoot: join(cacheBase, 'diffsplain'),
      callerDirectory: root,
      repo,
    });
    await mkdir(dirname(summaries), { recursive: true });
    await writeFile(
      summaries,
      JSON.stringify({
        change: {
          title: 'Seeded change title',
          summary: 'Seeded change body',
          why: 'Seeded reason',
          highlights: [],
          risks: [],
        },
        files: {
          'note.txt': {
            title: 'Seeded file title',
            what: 'Seeded file body',
            why: 'Seeded file reason',
            details: [],
            risks: [],
          },
        },
      }),
    );
    child = spawn(
      process.execPath,
      [script, '--repo', repo, '--worktree', '--no-agent'],
      {
        cwd: root,
        env: {
          ...process.env,
          BROWSER: 'true',
          XDG_CACHE_HOME: cacheBase,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const url = await waitForUrl(child);
    const data = await waitFor(async () => {
      const response = await fetch(reviewUrl(url, 'diff-data.json'));
      return response.ok ? response.json() : undefined;
    });

    assert.doesNotMatch(JSON.stringify(data), /Seeded (change|file) (title|body)/);
    assert.equal(data.notes.complete, false);
    assert.equal(data.notes.completedFiles, 0);
    assert.equal(data.notes.status, 'idle');
  } finally {
    if (child && child.exitCode === null) await stop(child);
    if (summaries) await rm(summaries, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('does not serve an old snapshot while the first refresh runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-startup-'));
  const repo = await makeRepo(root, 'repo', 'file.txt');
  const bin = join(root, 'bin');
  const browser = join(bin, 'browser');
  const gitWrapper = join(bin, 'git');
  const gitDelayMarker = join(root, 'git-delay-marker');
  const output = join(root, 'diff-data.json');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  let presenter;

  try {
    await mkdir(bin);
    await writeFile(
      output,
      JSON.stringify({
        version: 'stale',
        repo: { name: 'prior-run' },
        files: [],
      }),
    );
    await writeFile(browser, '#!/bin/sh\nexit 0\n');
    await writeFile(
      gitWrapper,
      '#!/bin/sh\n' +
        'if [ ! -f "$GIT_DELAY_MARKER" ]; then\n' +
        '  : > "$GIT_DELAY_MARKER"\n' +
        '  sleep 1\n' +
        'fi\n' +
        'exec "$REAL_GIT" "$@"\n',
    );
    await chmod(browser, 0o755);
    await chmod(gitWrapper, 0o755);

    presenter = spawn(
      process.execPath,
      [
        script,
        '--repo',
        repo,
        '--worktree',
        '--no-agent',
        '--output',
        output,
        '--port',
        '0',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          BROWSER: browser,
          GIT_DELAY_MARKER: gitDelayMarker,
          PATH: `${bin}:${process.env.PATH}`,
          REAL_GIT: realGit,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const url = await waitForUrl(presenter);
    const response = await fetch(reviewUrl(url, 'diff-data.json'));
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.repo.name, 'repo');
    assert.deepEqual(snapshot.files.map((file) => file.path), ['file.txt']);
  } finally {
    if (presenter && presenter.exitCode === null) await stop(presenter);
    await rm(root, { recursive: true, force: true });
  }
});

test('reuses a matching project tab when it reconnects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-reuse-'));
  const browser = join(root, 'browser');
  const browserLog = join(root, 'browser.log');
  let first;
  let second;
  let reader;

  try {
    const repo = await makeRepo(root, 'repo', 'file.txt');
    await writeFile(
      browser,
      '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$BROWSER_LOG"\n',
    );
    await chmod(browser, 0o755);
    const environment = {
      ...process.env,
      BROWSER: browser,
      BROWSER_LOG: browserLog,
    };

    first = spawn(
      process.execPath,
      [
        script,
        '--repo',
        repo,
        '--worktree',
        '--no-agent',
        '--port',
        '0',
      ],
      { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const firstUrl = new URL(await waitForUrl(first));
    await waitFor(async () => {
      const urls = (await readFile(browserLog, 'utf8')).trim().split('\n');
      return urls.length === 1 ? urls : undefined;
    });
    await stop(first);

    second = spawn(
      process.execPath,
      [
        script,
        '--repo',
        repo,
        '--worktree',
        '--no-agent',
        '--port',
        firstUrl.port,
      ],
      { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const secondUrl = new URL(await waitForUrl(second));
    const firstSession = new URLSearchParams(firstUrl.hash.slice(1));
    const secondSession = new URLSearchParams(secondUrl.hash.slice(1));
    assert.equal(secondSession.get('project'), firstSession.get('project'));
    assert.notEqual(secondSession.get('access'), firstSession.get('access'));

    const reused = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Presenter did not reuse the open tab')),
        10_000,
      );
      second.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('Reusing the open Diffsplain tab.')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const eventsUrl = reviewUrl(secondUrl, 'events');
    eventsUrl.searchParams.set('access', firstSession.get('access'));
    eventsUrl.searchParams.set(
      'project',
      secondSession.get('project'),
    );
    const response = await fetch(eventsUrl);
    reader = response.body.getReader();
    const initialEvents = await readUntil(reader, /event: access/);
    assert.match(initialEvents, /event: access/);
    assert.match(initialEvents, new RegExp(secondSession.get('access')));
    await reused;

    const opened = (await readFile(browserLog, 'utf8')).trim().split('\n');
    assert.equal(opened.length, 1);
  } finally {
    await reader?.cancel();
    if (first && first.exitCode === null) await stop(first);
    if (second && second.exitCode === null) await stop(second);
    await rm(root, { recursive: true, force: true });
  }
});

test('stays available when browser launch fails and skips it when asked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-headless-'));
  const browserLog = join(root, 'browser.log');
  const browser = join(root, 'browser');
  let failingPresenter;
  let headlessPresenter;

  try {
    const repo = await makeRepo(root, 'repo', 'file.txt');
    failingPresenter = spawn(
      process.execPath,
      [
        script,
        '--repo',
        repo,
        '--worktree',
        '--no-agent',
        '--port',
        '0',
      ],
      {
        cwd: root,
        env: { ...process.env, BROWSER: join(root, 'missing-browser') },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const browserFailure = waitForText(
      failingPresenter.stderr,
      /Could not open the browser:/,
    );
    const failingUrl = await waitForUrl(failingPresenter);
    await browserFailure;
    assert.equal((await fetch(new URL('health', failingUrl))).status, 200);
    assert.equal(failingPresenter.exitCode, null);

    await writeFile(browser, '#!/bin/sh\nprintf opened > "$BROWSER_LOG"\n');
    await chmod(browser, 0o755);
    headlessPresenter = spawn(
      process.execPath,
      [
        script,
        '--repo',
        repo,
        '--worktree',
        '--no-agent',
        '--no-browser',
        '--port',
        '0',
      ],
      {
        cwd: root,
        env: { ...process.env, BROWSER: browser, BROWSER_LOG: browserLog },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const headlessUrl = await waitForUrl(headlessPresenter);
    assert.equal((await fetch(new URL('health', headlessUrl))).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await assert.rejects(readFile(browserLog, 'utf8'));
  } finally {
    if (failingPresenter && failingPresenter.exitCode === null) {
      await stop(failingPresenter);
    }
    if (headlessPresenter && headlessPresenter.exitCode === null) {
      await stop(headlessPresenter);
    }
    await rm(root, { recursive: true, force: true });
  }
});
