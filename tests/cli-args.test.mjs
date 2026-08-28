import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseCliArgs } from '../scripts/cli-args.mjs';
import { reviewAccessMode } from '../scripts/local-target.mjs';

const cwd = '/work/project';
const missing = () => false;

function valuesFor(args, name) {
  return args.flatMap((argument, index) =>
    argument === name ? [args[index + 1]] : []);
}

test('leaves agent selection open when no agent is passed', () => {
  const parsed = parseCliArgs([], {
    callerDirectory: cwd,
    pathExists: missing,
  });

  assert.equal(parsed.agentEnabled, true);
  assert.equal(parsed.agent, undefined);
  assert.equal(parsed.port, 2299);
  assert.equal(parsed.portWasPassed, false);
  assert.equal(parsed.host, 'localhost');
  assert.equal(parsed.browserEnabled, true);
  assert.deepEqual(parsed.feedArgs, ['--repo', cwd, '--checkout']);
  assert.deepEqual(parsed.agentArgs, [
    '--repo',
    cwd,
    '--checkout',
    '--batch-size',
    '12',
    '--jobs',
    '3',
  ]);
});

test('passes no-checkout-access only to agent notes', () => {
  const parsed = parseCliArgs(['--no-checkout-access'], {
    callerDirectory: cwd,
    pathExists: missing,
  });

  assert.equal(parsed.noCheckoutAccess, true);
  assert.ok(parsed.agentArgs.includes('--no-checkout-access'));
  assert.ok(!parsed.feedArgs.includes('--no-checkout-access'));
});

test('keeps repeated exclusion rules in encounter order for both builders', () => {
  const parsed = parseCliArgs([
    '--exclude',
    'private/**',
    '--base',
    'main',
    '--exclude=!private/keep.txt',
    '--exclude',
    '\\!literal.txt',
  ], {
    callerDirectory: cwd,
    pathExists: missing,
  });

  const expected = ['private/**', '!private/keep.txt', '\\!literal.txt'];
  assert.deepEqual(valuesFor(parsed.feedArgs, '--exclude'), expected);
  assert.deepEqual(valuesFor(parsed.agentArgs, '--exclude'), expected);
  assert.equal(parsed.excludePatterns.join('\0'), expected.join('\0'));
});

test('forwards exclusion rules for a plain review', () => {
  const parsed = parseCliArgs([
    '--no-agent',
    '--exclude=private/**',
    '--exclude',
    '!private/keep.txt',
  ], {
    callerDirectory: cwd,
    pathExists: missing,
  });

  assert.equal(parsed.agentEnabled, false);
  assert.deepEqual(parsed.agentArgs, parsed.feedArgs);
  assert.deepEqual(valuesFor(parsed.feedArgs, '--exclude'), [
    'private/**',
    '!private/keep.txt',
  ]);
});

test('classifies local targets for checkout access and remote targets for snapshots', () => {
  const local = { repo: cwd };
  assert.deepEqual(reviewAccessMode(local), {
    mode: 'checkout-read-only',
    root: cwd,
  });
  for (const target of [
    { ...local, checkout: true },
    { ...local, worktree: true },
    { ...local, base: 'release-1' },
  ]) {
    assert.deepEqual(reviewAccessMode(target), {
      mode: 'checkout-read-only',
      root: cwd,
    });
  }
  for (const target of [
    { ...local, branch: 'topic' },
    { ...local, pullRequest: '42' },
    { ...local, base: 'main', head: 'topic' },
    { ...local, range: 'main..topic' },
    { ...local, snapshotSupplied: true, snapshotTargetKind: 'checkout' },
    { ...local, snapshotSupplied: true, snapshotTargetKind: 'worktree' },
    { ...local, snapshotSupplied: true, snapshotTargetKind: 'base-worktree' },
    { ...local, snapshotSupplied: true, snapshotTargetKind: 'range' },
    { ...local, snapshotSupplied: true, snapshotTargetKind: 'branch' },
    { ...local, snapshotSupplied: true, snapshotTargetKind: 'pr' },
    { ...local, snapshotSupplied: true },
  ]) {
    assert.deepEqual(reviewAccessMode(target), {
      mode: 'snapshot-only',
      reason: 'target-mismatch',
    });
  }
  assert.deepEqual(reviewAccessMode({ ...local, noCheckoutAccess: true }), {
    mode: 'snapshot-only',
    reason: 'disabled',
  });
});

test('accepts headless browser and explicit bind options', () => {
  const parsed = parseCliArgs(['--no-browser', '--host', '0.0.0.0'], {
    callerDirectory: cwd,
    pathExists: missing,
  });

  assert.equal(parsed.browserEnabled, false);
  assert.equal(parsed.host, '0.0.0.0');
});

test('accepts a GitHub owner/name repo and a branch', () => {
  const parsed = parseCliArgs(['acme/widgets', '--branch', 'feature/search'], {
    callerDirectory: cwd,
    pathExists: missing,
  });

  assert.deepEqual(parsed.feedArgs, [
    '--repo',
    cwd,
    '--branch',
    'feature/search',
    '--remote',
    'https://github.com/acme/widgets.git',
  ]);
});

test('accepts a repo URL and pull request', () => {
  const parsed = parseCliArgs(
    [
      '--repo',
      'https://github.com/acme/widgets',
      '--pr',
      '42',
      '--no-agent',
      '--port',
      '4000',
    ],
    { callerDirectory: cwd, pathExists: missing },
  );

  assert.equal(parsed.agentEnabled, false);
  assert.equal(parsed.port, 4000);
  assert.equal(parsed.portWasPassed, true);
  assert.deepEqual(parsed.feedArgs, [
    '--repo',
    cwd,
    '--pr',
    '42',
    '--remote',
    'https://github.com/acme/widgets',
  ]);
});

test('keeps split and equals-style values consistent', () => {
  const split = parseCliArgs(
    [
      '--repo',
      'repos/widgets',
      '--base',
      'refs/heads/main',
      '--head',
      'refs/heads/topic',
      '--remote',
      'upstream',
      '--summaries',
      'state/notes.json',
      '--output',
      'state/review.json',
      '--cache-dir',
      'state/git',
      '--codex-bin',
      'bin/codex',
      '--model',
      'review-model',
      '--port',
      '0',
    ],
    {
      callerDirectory: cwd,
      pathExists: (path) => path === resolve(cwd, 'repos/widgets'),
    },
  );
  const equals = parseCliArgs(
    [
      '--repo=repos/widgets',
      '--base=refs/heads/main',
      '--head=refs/heads/topic',
      '--remote=upstream',
      '--summaries=state/notes.json',
      '--output=state/review.json',
      '--cache-dir=state/git',
      '--codex-bin=bin/codex',
      '--model=review-model',
      '--port=0',
    ],
    {
      callerDirectory: cwd,
      pathExists: (path) => path === resolve(cwd, 'repos/widgets'),
    },
  );

  assert.deepEqual(equals, split);
  assert.deepEqual(split.feedArgs, [
    '--repo',
    resolve(cwd, 'repos/widgets'),
    '--base',
    'refs/heads/main',
    '--head',
    'refs/heads/topic',
    '--remote',
    'upstream',
    '--summaries',
    resolve(cwd, 'state/notes.json'),
    '--output',
    resolve(cwd, 'state/review.json'),
    '--cache-dir',
    resolve(cwd, 'state/git'),
  ]);
  assert.deepEqual(split.agentArgs.slice(-8), [
    '--codex-bin',
    resolve(cwd, 'bin/codex'),
    '--model',
    'review-model',
    '--batch-size',
    '12',
    '--jobs',
    '3',
  ]);
});

test('passes the worktree target to both builders unchanged', () => {
  const parsed = parseCliArgs(
    ['--repo', 'repos/widgets', '--worktree', '--no-agent'],
    {
      callerDirectory: cwd,
      pathExists: (path) => path === resolve(cwd, 'repos/widgets'),
    },
  );

  assert.deepEqual(parsed.feedArgs, [
    '--repo',
    resolve(cwd, 'repos/widgets'),
    '--worktree',
  ]);
  assert.deepEqual(parsed.agentArgs, parsed.feedArgs);
});

test('passes a base-only working-tree target to both builders unchanged', () => {
  const parsed = parseCliArgs(
    ['--repo', 'repos/widgets', '--base', 'release-1', '--no-agent'],
    {
      callerDirectory: cwd,
      pathExists: (path) => path === resolve(cwd, 'repos/widgets'),
    },
  );

  assert.deepEqual(parsed.feedArgs, [
    '--repo',
    resolve(cwd, 'repos/widgets'),
    '--base',
    'release-1',
  ]);
  assert.deepEqual(parsed.agentArgs, parsed.feedArgs);
});

test('keeps an existing repo path local', () => {
  const parsed = parseCliArgs(['repos/widgets', '--pr', '42'], {
    callerDirectory: cwd,
    pathExists: (path) => path === resolve(cwd, 'repos/widgets'),
  });

  assert.deepEqual(parsed.feedArgs, [
    '--repo',
    resolve(cwd, 'repos/widgets'),
    '--pr',
    '42',
  ]);
});

test('gets the repo from a full pull request URL', () => {
  const parsed = parseCliArgs(
    ['--pr', 'https://github.com/acme/widgets/pull/42'],
    { callerDirectory: cwd, pathExists: missing },
  );

  assert.deepEqual(parsed.feedArgs, [
    '--repo',
    cwd,
    '--pr',
    'https://github.com/acme/widgets/pull/42',
    '--remote',
    'https://github.com/acme/widgets.git',
  ]);
});

test('rejects remote repos without a branch or pull request', () => {
  assert.throws(
    () =>
      parseCliArgs(['acme/widgets'], {
        callerDirectory: cwd,
        pathExists: missing,
      }),
    /remote repo needs --branch or --pr/i,
  );
});

test('accepts each supported coding agent', () => {
  for (const agent of ['codex', 'claude', 'copilot', 'cursor', 'opencode']) {
    const parsed = parseCliArgs(['--agent', agent], {
      callerDirectory: cwd,
      pathExists: missing,
    });
    assert.equal(parsed.agent, agent);
  }
});

test('rejects an unknown coding agent', () => {
  assert.throws(
    () =>
      parseCliArgs(['--agent', 'unknown'], {
        callerDirectory: cwd,
        pathExists: missing,
      }),
    (error) => {
      assert.match(error.message, /unsupported agent/i);
      assert.match(
        error.message,
        /Choose codex, claude, copilot, cursor, opencode/,
      );
      return true;
    },
  );
});

test('rejects a missing value for every value option', () => {
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
    '--host',
    '--exclude',
    '--agent',
  ]) {
    assert.throws(
      () => parseCliArgs([option]),
      new RegExp(`${option} needs a value`),
      option,
    );
    assert.throws(
      () => parseCliArgs([`${option}=`]),
      new RegExp(`${option} needs a value`),
      `${option}=`,
    );
    assert.throws(
      () => parseCliArgs([option, '--help']),
      new RegExp(`${option} needs a value`),
      `${option} --help`,
    );
  }
});

test('rejects duplicate options and aliases', () => {
  for (const args of [
    ['--repo', 'first', '--repo', 'second'],
    ['--agent', 'codex', '--agent=claude'],
    ['--no-agent', '--no-agent'],
    ['--worktree', '--worktree'],
    ['--force', '--force'],
    ['--no-browser', '--no-browser'],
    ['--host', 'localhost', '--host', '0.0.0.0'],
    ['-h', '--help'],
    ['-v', '--version'],
  ]) {
    assert.throws(
      () => parseCliArgs(args),
      /was passed more than once/i,
      args.join(' '),
    );
  }
});

test('rejects unknown short options and empty positional repos', () => {
  assert.throws(() => parseCliArgs(['-x']), /unknown option: -x/i);
  assert.throws(() => parseCliArgs(['']), /repo cannot be empty/i);
});

test('accepts short help and version flags', () => {
  assert.deepEqual(parseCliArgs(['-h']), { help: true });
  assert.deepEqual(parseCliArgs(['-v']), { version: true });
});

test('accepts the doctor command without review options', () => {
  assert.deepEqual(parseCliArgs(['doctor']), {
    doctor: { json: false, deep: false },
  });
  assert.deepEqual(parseCliArgs(['doctor', '--json', '--deep']), {
    doctor: { json: true, deep: true },
  });
  assert.throws(
    () => parseCliArgs(['doctor', '--no-agent']),
    /doctor only accepts --json and --deep/i,
  );
});

test('passes agent model, reasoning, and batch settings through', () => {
  const parsed = parseCliArgs(
    [
      '--model',
      'gpt-test',
      '--reasoning',
      'low',
      '--batch-size',
      '2',
      '--jobs',
      '4',
    ],
    {
      callerDirectory: cwd,
      pathExists: missing,
    },
  );

  assert.deepEqual(parsed.agentArgs.slice(-8), [
    '--model',
    'gpt-test',
    '--reasoning',
    'low',
    '--batch-size',
    '2',
    '--jobs',
    '4',
  ]);
  assert.equal(parsed.model, 'gpt-test');
});

test('forces note regeneration only in the agent process', () => {
  const parsed = parseCliArgs(['--force'], {
    callerDirectory: cwd,
    pathExists: missing,
  });

  assert.equal(parsed.forceSummaryRegeneration, true);
  assert.doesNotMatch(parsed.feedArgs.join(' '), /--force/);
  assert.ok(parsed.agentArgs.includes('--force'));
});

test('rejects the removed Cursor safety bypass flag', () => {
  assert.throws(
    () => parseCliArgs(['--skip-safety-checks']),
    /unknown option: --skip-safety-checks/i,
  );
  assert.throws(
    () => parseCliArgs(['--agent', 'cursor', '--skip-safety-checks']),
    /unknown option: --skip-safety-checks/i,
  );
});

test('passes one opt-in support record only to the agent process', () => {
  const printed = parseCliArgs(['--support-record'], {
    callerDirectory: cwd,
    pathExists: missing,
  });
  assert.equal(printed.agentArgs.at(-1), '--support-record');
  assert.doesNotMatch(printed.feedArgs.join(' '), /support-record/);

  const exported = parseCliArgs(
    ['--support-record-file', 'support.json'],
    {
      callerDirectory: cwd,
      pathExists: missing,
    },
  );
  assert.deepEqual(exported.agentArgs.slice(-2), [
    '--support-record-file',
    resolve(cwd, 'support.json'),
  ]);
  assert.deepEqual(exported.feedArgs.slice(-2), [
    '--exclude-output',
    resolve(cwd, 'support.json'),
  ]);
});

test('rejects conflicting or agent-free support record options', () => {
  assert.throws(
    () =>
      parseCliArgs(
        [
          '--support-record',
          '--support-record-file',
          'support.json',
        ],
        { callerDirectory: cwd, pathExists: missing },
      ),
    /either --support-record/i,
  );
  assert.throws(
    () =>
      parseCliArgs(['--no-agent', '--support-record'], {
        callerDirectory: cwd,
        pathExists: missing,
      }),
    /--no-agent.*support record/i,
  );
});

test('rejects invalid reasoning and batch settings', () => {
  assert.throws(
    () =>
      parseCliArgs(['--reasoning', 'fast'], {
        callerDirectory: cwd,
        pathExists: missing,
      }),
    /--reasoning must be/i,
  );
  assert.throws(
    () =>
      parseCliArgs(['--batch-size', '0'], {
        callerDirectory: cwd,
        pathExists: missing,
      }),
    /--batch-size must be/i,
  );
  assert.throws(
    () =>
      parseCliArgs(['--jobs', '9'], {
        callerDirectory: cwd,
        pathExists: missing,
      }),
    /--jobs must be/i,
  );
});

test('rejects supplied notes with --no-agent', () => {
  assert.throws(
    () =>
      parseCliArgs(['--no-agent', '--summaries', 'notes.json'], {
        callerDirectory: cwd,
        pathExists: missing,
      }),
    /--no-agent.*--summaries/i,
  );
});

test('rejects reasoning for an unsupported requested agent', () => {
  assert.throws(
    () =>
      parseCliArgs(['--agent', 'claude', '--reasoning', 'low'], {
        callerDirectory: cwd,
        pathExists: missing,
      }),
    /reasoning.*codex.*opencode/i,
  );
});

test('rejects invalid ports', () => {
  for (const port of ['-1', '1.5', 'word', '65536']) {
    for (const args of [['--port', port], [`--port=${port}`]]) {
      assert.throws(
        () => parseCliArgs(args),
        /--port must be a number from 0 to 65535/i,
        args.join(' '),
      );
    }
  }
});

test('rejects unsupported pull request values', () => {
  for (const pullRequest of ['0', 'topic', 'https://github.com/acme/widgets']) {
    assert.throws(
      () => parseCliArgs(['--pr', pullRequest]),
      /--pr must be a positive number or a pull request url/i,
      pullRequest,
    );
  }
});

test('rejects conflicting review targets', () => {
  for (const args of [
    ['--branch', 'topic', '--pr', '42'],
    ['--pr', '42', '--base', 'main'],
    ['--pr', '42', '--head', 'topic'],
    ['--branch', 'topic', '--head', 'other'],
    ['--worktree', '--branch', 'topic'],
    ['--worktree', '--pr', '42'],
    ['--worktree', '--base', 'main', '--head', 'topic'],
    ['--head', 'topic'],
  ]) {
    assert.throws(
      () => parseCliArgs(args),
      /cannot|must be used/i,
      args.join(' '),
    );
  }
});

test('publishes the diffsplain executable', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.bin['diffsplain'], 'scripts/present.mjs');
  assert.ok(packageJson.files.includes('dist'));
  assert.equal(
    packageJson.scripts.diffsplain,
    'node scripts/present.mjs',
  );
  assert.equal(
    packageJson.scripts.doctor,
    'node scripts/present.mjs doctor',
  );
  assert.ok(packageJson.scripts.prepack);
});
