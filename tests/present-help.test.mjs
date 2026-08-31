import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('../scripts/present.mjs', import.meta.url).pathname;
const supportRecordMarker = 'Diffsplain support record:\n';

function parseLastSupportRecord(stderr) {
  const markerIndex = stderr.lastIndexOf(supportRecordMarker);
  assert.ok(markerIndex >= 0, stderr);
  return JSON.parse(stderr.slice(markerIndex + supportRecordMarker.length));
}

test('prints help with either help flag', () => {
  for (const flag of ['-h', '--help']) {
    const result = spawnSync(process.execPath, [script, flag], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: diffsplain/m);
    assert.match(result.stdout, /doctor \[--json\] \[--deep\]/);
    assert.match(result.stdout, /config agent \[NAME\|--unset\]/);
    assert.match(
      result.stdout,
      /Check review, agent, and pull request capabilities/,
    );
    assert.match(result.stdout, /--support-record/);
    assert.match(result.stdout, /--support-record-file FILE/);
    assert.match(result.stdout, /-v, --version/);
  }
});

test('sets, shows, and unsets the default coding agent', async () => {
  const configRoot = await mkdtemp(join(tmpdir(), 'diffsplain-config-command-'));
  const env = { ...process.env, XDG_CONFIG_HOME: configRoot };

  try {
    const empty = spawnSync(process.execPath, [script, 'config', 'agent'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /No default coding agent is configured/);

    const set = spawnSync(
      process.execPath,
      [script, 'config', 'agent', 'claude'],
      { encoding: 'utf8', env },
    );
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /set to "claude"/);

    const shown = spawnSync(process.execPath, [script, 'config', 'agent'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(shown.stdout.trim(), 'claude');

    const unset = spawnSync(
      process.execPath,
      [script, 'config', 'agent', '--unset'],
      { encoding: 'utf8', env },
    );
    assert.equal(unset.status, 0, unset.stderr);
    assert.match(unset.stdout, /unset/);
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
});

test('prints the package version with either version flag', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  for (const flag of ['-v', '--version']) {
    const result = spawnSync(process.execPath, [script, flag], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `diffsplain ${packageJson.version}`);
  }
});

test('shows cache status and guards prune and clear commands', async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'diffsplain-cache-command-'));
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot };

  try {
    const status = spawnSync(process.execPath, [script, 'cache'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Location:/);
    assert.match(status.stdout, /Active use: 0 targets/);

    for (const args of [
      ['cache', 'prune', '--age', '0'],
      ['cache', 'prune', '--size', '0'],
      ['cache', 'clear', '--yes'],
    ]) {
      const result = spawnSync(process.execPath, [script, ...args], {
        encoding: 'utf8',
        env,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Removed 0 inactive cache entries/);
    }

    for (const args of [
      ['cache', 'prune', '--other', '1'],
      ['cache', 'clear'],
      ['cache', 'unknown'],
    ]) {
      const result = spawnSync(process.execPath, [script, ...args], {
        encoding: 'utf8',
        env,
      });
      assert.equal(result.status, 2, result.stdout);
      assert.match(result.stderr, /diffsplain cache/);
    }
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('reports missing option values before startup', () => {
  for (const option of [
    '--repo',
    '--branch',
    '--pr',
    '--base',
    '--head',
    '--remote',
    '--summaries',
    '--output',
    '--cache-dir',
    '--codex-bin',
    '--model',
    '--reasoning',
    '--batch-size',
    '--jobs',
    '--port',
    '--agent',
  ]) {
    const result = spawnSync(process.execPath, [script, option], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '' },
    });
    assert.equal(result.status, 2, `${option}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`${option} needs a value`));
    assert.match(result.stderr, /diffsplain --help/);
  }
});

test('requires an agent choice before the presenter starts', async () => {
  const configRoot = await mkdtemp(join(tmpdir(), 'diffsplain-empty-config-'));
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '', XDG_CONFIG_HOME: configRoot },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /interactive terminal/i);
    assert.match(result.stderr, /--agent.*--no-agent/i);
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
});

test('prints the configured agent when provider selection fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-present-provider-'));
  const repo = join(root, 'not-a-repo');
  const configRoot = join(root, 'config');

  try {
    await mkdir(repo);
    await mkdir(join(configRoot, 'diffsplain'), { recursive: true });
    await writeFile(
      join(configRoot, 'diffsplain', 'config.json'),
      JSON.stringify({ agent: 'codex' }),
    );
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--repo',
        repo,
        '--codex-bin',
        join(root, 'missing-codex'),
        '--support-record',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, XDG_CONFIG_HOME: configRoot },
      },
    );

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /not available/i);
    const record = parseLastSupportRecord(result.stderr);
    assert.deepEqual(record.provider, {
      name: 'codex',
      version: null,
    });
    assert.equal(record.stages.agent.state, 'failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a missing base before agent selection or page setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-present-missing-base-'));
  const repo = join(root, 'repo');
  const output = join(root, 'snapshot.json');

  try {
    await mkdir(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const result = spawnSync(
      process.execPath,
      [script, '--repo', repo, '--base', 'not-a-ref', '--output', output],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: '' },
      },
    );

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Could not resolve base ref "not-a-ref"/);
    assert.doesNotMatch(result.stderr, /interactive terminal/i);
    await assert.rejects(readFile(output, 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prints a support record when snapshot startup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-present-support-'));
  const repo = join(root, 'not-a-repo');
  const bin = join(root, 'bin');

  try {
    await mkdir(repo);
    await mkdir(bin);
    await writeFile(
      join(bin, 'codex'),
      '#!/bin/sh\nprintf "codex-cli 7.6.5\\n"\n',
    );
    await chmod(join(bin, 'codex'), 0o755);
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--repo',
        repo,
        '--worktree',
        '--agent',
        'codex',
        '--support-record',
        '--port',
        '0',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
        },
      },
    );

    assert.notEqual(result.status, 0);
    const record = parseLastSupportRecord(result.stderr);
    assert.deepEqual(record.provider, {
      name: 'codex',
      version: '7.6.5',
    });
    assert.ok(
      record.durationMs >= record.stages.agent.durationMs,
      JSON.stringify(record),
    );
    assert.equal(record.stages.snapshot.state, 'failed');
    assert.deepEqual(record.exit, {
      state: 'failed',
      code: 1,
      stage: 'snapshot',
    });
    assert.equal(JSON.stringify(record).includes(repo), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps the failed build process exit code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-present-build-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const copiedPackage = join(root, 'package');

  try {
    await mkdir(repo);
    await mkdir(bin);
    await mkdir(copiedPackage);
    await cp(
      new URL('../scripts/', import.meta.url),
      join(copiedPackage, 'scripts'),
      { recursive: true },
    );
    await cp(
      new URL('../package.json', import.meta.url),
      join(copiedPackage, 'package.json'),
    );
    await writeFile(
      join(bin, 'codex'),
      '#!/bin/sh\nprintf "codex-cli 7.6.5\\n"\n',
    );
    await writeFile(join(bin, 'npm'), '#!/bin/sh\nexit 23\n');
    await chmod(join(bin, 'codex'), 0o755);
    await chmod(join(bin, 'npm'), 0o755);

    const result = spawnSync(
      process.execPath,
      [
        join(copiedPackage, 'scripts/present.mjs'),
        '--repo',
        repo,
        '--worktree',
        '--agent',
        'codex',
        '--support-record',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
        },
      },
    );

    assert.equal(result.status, 23, result.stderr);
    assert.equal(parseLastSupportRecord(result.stderr).exit.code, 23);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prints a support record when the summary generator is killed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-present-signal-'));
  const repo = join(root, 'repo');
  const agent = join(root, 'codex');
  let child;

  try {
    await mkdir(repo);
    spawnSync('git', ['init'], { cwd: repo });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repo,
    });
    spawnSync('git', ['config', 'user.name', 'Test User'], {
      cwd: repo,
    });
    await writeFile(join(repo, 'file.txt'), 'before\n');
    spawnSync('git', ['add', 'file.txt'], { cwd: repo });
    spawnSync('git', ['commit', '-m', 'Initial'], { cwd: repo });
    await writeFile(join(repo, 'file.txt'), 'after\n');
    await writeFile(
      agent,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        '  printf "codex-cli 7.6.5\\n"',
        '  exit 0',
        'fi',
        'kill -KILL "$PPID"',
        '',
      ].join('\n'),
    );
    await chmod(agent, 0o755);

    let stderr = '';
    const record = await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        child?.kill('SIGTERM');
        rejectPromise(new Error(stderr || 'Timed out waiting for support record'));
      }, 15_000);
      child = spawn(
        process.execPath,
        [
          script,
          '--repo',
          repo,
          '--worktree',
          '--agent',
          'codex',
          '--support-record',
          '--codex-bin',
          agent,
          '--port',
          '0',
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            BROWSER: '/usr/bin/true',
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        const markerIndex = stderr.lastIndexOf(supportRecordMarker);
        if (markerIndex === -1 || !stderr.endsWith('\n}\n')) return;
        clearTimeout(timeout);
        try {
          resolvePromise(parseLastSupportRecord(stderr));
        } catch (error) {
          rejectPromise(error);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      });
      child.once('exit', (code) => {
        if (!stderr.includes(supportRecordMarker)) {
          clearTimeout(timeout);
          rejectPromise(
            new Error(`Presenter exited with ${code}: ${stderr}`),
          );
        }
      });
    });

    assert.equal(record.stages.agent.state, 'failed');
    assert.deepEqual(record.exit, {
      state: 'failed',
      code: 1,
      stage: 'agent',
    });
  } finally {
    child?.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  }
});
