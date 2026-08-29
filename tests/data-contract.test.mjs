import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const builder = new URL('../scripts/build-diff-data.mjs', import.meta.url).pathname;

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function build(repo, root, name, args) {
  const output = join(root, `${name}.json`);
  execFileSync(
    process.execPath,
    [builder, '--repo', repo, ...args, '--output', output],
    { encoding: 'utf8', stdio: 'pipe' },
  );
  return JSON.parse(await readFile(output, 'utf8'));
}

test('documents each supported target and its settled refresh contract', async () => {
  const data = await readFile(new URL('../docs/content/data.mdx', import.meta.url), 'utf8');
  for (const target of ['--worktree', 'Current checkout', '--base REF', '--base REF --head REF', '--branch NAME', '--pr NUMBER']) {
    assert.match(data, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(data, /Remote data every 30 seconds/);
  assert.match(data, /`snapshot-only`/);
  assert.match(data, /`checkout-read-only`/);
  assert.match(data, /`notes\.accessMode`/);
  assert.match(data, /--no-checkout-access/);
  assert.match(data, /ignored files, Git history, and symlink targets/);
  assert.doesNotMatch(data, /does not receive files\s+outside that snapshot/i);
  assert.match(data, /--output FILE[\s\S]*stays at the chosen path until you delete it/);
  assert.match(data, /platform user cache/);
  assert.match(data, /installed package's\s+`\.cache\/git` folder/);
  assert.doesNotMatch(data, /node scripts\//);
  assert.doesNotMatch(data, /worktree notes persist in the selected repo/i);
});

test('keeps checkout, worktree, base-worktree, and exact-range Git semantics distinct', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-data-contract-'));
  const repo = join(root, 'repo');

  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'diffsplain@example.test');
    git(repo, 'config', 'user.name', 'Diffsplain');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', 'base.txt');
    git(repo, 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');

    git(repo, 'switch', '-qc', 'feature');
    await writeFile(join(repo, 'committed.txt'), 'committed\n');
    git(repo, 'add', 'committed.txt');
    git(repo, 'commit', '-qm', 'feature');
    const head = git(repo, 'rev-parse', 'HEAD');

    await writeFile(join(repo, 'staged.txt'), 'staged\n');
    git(repo, 'add', 'staged.txt');
    await writeFile(join(repo, 'base.txt'), 'unstaged\n');
    await writeFile(join(repo, 'untracked.txt'), 'untracked\n');

    const checkout = await build(repo, root, 'checkout', ['--checkout']);
    const worktree = await build(repo, root, 'worktree', ['--worktree']);
    const baseWorktree = await build(repo, root, 'base-worktree', ['--base', base]);
    const range = await build(repo, root, 'range', ['--base', base, '--head', head]);

    assert.deepEqual(
      checkout.files.map(({ path }) => path),
      ['base.txt', 'committed.txt', 'staged.txt', 'untracked.txt'],
    );
    assert.equal(checkout.repo.target.kind, 'checkout');
    assert.equal(checkout.repo.base, base);
    assert.equal(checkout.repo.head, head);

    assert.deepEqual(
      worktree.files.map(({ path }) => path),
      ['base.txt', 'staged.txt', 'untracked.txt'],
    );
    assert.equal(worktree.repo.target.kind, 'worktree');
    assert.equal(worktree.repo.base, head);
    assert.equal(worktree.repo.head, head);

    assert.deepEqual(
      baseWorktree.files.map(({ path }) => path),
      ['base.txt', 'committed.txt', 'staged.txt', 'untracked.txt'],
    );
    assert.deepEqual(baseWorktree.repo.target, {
      kind: 'base-worktree',
      base: { ref: base, oid: base },
      head: { ref: 'WORKTREE', oid: head },
    });
    assert.equal(baseWorktree.repo.base, base);
    assert.equal(baseWorktree.repo.head, head);
    assert.ok(
      baseWorktree.files.every(
        (file) => file.sourceUrl === undefined && file.comparisonUrl === undefined,
      ),
    );

    git(repo, 'branch', 'base-branch', base);
    git(repo, 'tag', '-a', 'base-tag', '-m', 'base tag', base);
    for (const ref of ['base-branch', 'base-tag', base.slice(0, 12), 'HEAD~1']) {
      const resolved = await build(repo, root, `base-${ref.replaceAll('~', '-')}`, [
        '--base',
        ref,
      ]);
      assert.equal(resolved.repo.target.kind, 'base-worktree');
      assert.equal(resolved.repo.target.base.ref, ref);
      assert.equal(resolved.repo.target.base.oid, base);
    }

    assert.deepEqual(
      range.files.map(({ path }) => path),
      ['committed.txt'],
    );
    assert.equal(range.repo.target.kind, 'range');
    assert.equal(range.repo.base, base);
    assert.equal(range.repo.head, head);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('coalesces a base file deletion with an untracked live replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-untracked-replacement-'));
  const repo = join(root, 'repo');

  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'diffsplain@example.test');
    git(repo, 'config', 'user.name', 'Diffsplain');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(repo, 'recreated.txt'), 'base contents\n');
    git(repo, 'add', 'recreated.txt');
    git(repo, 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');

    git(repo, 'rm', 'recreated.txt');
    git(repo, 'commit', '-qm', 'delete tracked file');
    await writeFile(join(repo, 'recreated.txt'), 'live replacement\n');

    const snapshot = await build(repo, root, 'base-untracked-replacement', [
      '--base',
      base,
    ]);

    assert.deepEqual(snapshot.files.map((file) => file.path), ['recreated.txt']);
    const [file] = snapshot.files;
    assert.equal(file.status, 'modified');
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
    assert.equal(file.isBinary, false);
    assert.match(file.patch, /^diff --git a\/recreated\.txt b\/recreated\.txt\n/);
    assert.match(file.patch, /--- a\/recreated\.txt\n\+\+\+ b\/recreated\.txt\n/);
    assert.match(file.patch, /-base contents\n\+live replacement\n/);
    assert.equal(file.snippet, file.patch);

    await writeFile(join(repo, 'recreated.txt'), 'base contents\n');
    const unchanged = await build(repo, root, 'base-untracked-replacement', [
      '--base',
      base,
    ]);
    assert.deepEqual(unchanged.files, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('compares the exact base tree instead of a merge base', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-exact-base-'));
  const repo = join(root, 'repo');

  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'diffsplain@example.test');
    git(repo, 'config', 'user.name', 'Diffsplain');
    await writeFile(join(repo, 'shared.txt'), 'base\n');
    git(repo, 'add', 'shared.txt');
    git(repo, 'commit', '-qm', 'base');

    git(repo, 'branch', 'comparison-base');
    await writeFile(join(repo, 'head-side.txt'), 'head\n');
    git(repo, 'add', 'head-side.txt');
    git(repo, 'commit', '-qm', 'head side');

    git(repo, 'switch', '-q', 'comparison-base');
    await writeFile(join(repo, 'base-side.txt'), 'base side\n');
    git(repo, 'add', 'base-side.txt');
    git(repo, 'commit', '-qm', 'base side');
    const comparisonBase = git(repo, 'rev-parse', 'HEAD');

    git(repo, 'switch', '-q', 'main');
    const snapshot = await build(repo, root, 'exact-base', [
      '--base',
      'comparison-base',
    ]);

    assert.equal(snapshot.repo.target.base.oid, comparisonBase);
    assert.deepEqual(
      snapshot.files.map(({ path }) => path),
      ['base-side.txt', 'head-side.txt'],
    );
    assert.equal(
      snapshot.files.find((file) => file.path === 'base-side.txt').status,
      'deleted',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a missing base before it writes a snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-missing-base-'));
  const repo = join(root, 'repo');
  const output = join(root, 'snapshot.json');

  try {
    execFileSync('git', ['init', '-q', repo]);
    const result = spawnSync(
      process.execPath,
      [builder, '--repo', repo, '--base', 'not-a-ref', '--output', output],
      { encoding: 'utf8' },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Could not resolve base ref "not-a-ref"/);
    assert.equal(existsSync(output), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('marks ordered agent exclusions without removing local review files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diffsplain-agent-exclusions-'));
  const repo = join(root, 'repo');

  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'diffsplain@example.test');
    git(repo, 'config', 'user.name', 'Diffsplain');
    git(repo, 'config', 'core.ignoreCase', 'true');
    await writeFile(join(repo, 'old-secret.txt'), 'secret\n');
    await writeFile(join(repo, 'private-drop.txt'), 'old\n');
    await writeFile(join(repo, 'private-keep.txt'), 'old\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');

    git(repo, 'mv', 'old-secret.txt', 'new-visible.txt');
    await writeFile(join(repo, 'private-drop.txt'), 'new\n');
    await writeFile(join(repo, 'private-keep.txt'), 'new\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'change');

    const snapshot = await build(repo, root, 'ordered', [
      '--base',
      base,
      '--head',
      'HEAD',
      '--exclude',
      'PRIVATE-*.TXT',
      '--exclude',
      '!private-keep.txt',
      '--exclude',
      'old-secret.txt',
    ]);
    const byPath = new Map(snapshot.files.map((file) => [file.path, file]));

    assert.deepEqual([...byPath.keys()].sort(), [
      'new-visible.txt',
      'private-drop.txt',
      'private-keep.txt',
    ]);
    assert.equal(byPath.get('private-drop.txt').agentExcluded, true);
    assert.equal(byPath.get('private-keep.txt').agentExcluded, undefined);
    assert.equal(byPath.get('new-visible.txt').oldPath, 'old-secret.txt');
    assert.equal(byPath.get('new-visible.txt').agentExcluded, undefined);
    assert.ok(byPath.get('private-drop.txt').patch.includes('+new'));
    assert.equal(snapshot.notes.totalFiles, 2);

    const renamed = await build(repo, root, 'renamed', [
      '--base',
      base,
      '--head',
      'HEAD',
      '--exclude',
      'new-visible.txt',
    ]);
    assert.equal(
      renamed.files.find((file) => file.path === 'new-visible.txt').agentExcluded,
      true,
    );

    await writeFile(join(repo, 'private-drop.txt'), 'excluded again\n');
    git(repo, 'add', 'private-drop.txt');
    git(repo, 'commit', '-qm', 'excluded only');
    const excludedOnly = await build(repo, root, 'excluded-only', [
      '--base',
      base,
      '--head',
      'HEAD',
      '--exclude',
      'PRIVATE-*.TXT',
      '--exclude',
      '!private-keep.txt',
      '--exclude',
      'old-secret.txt',
    ]);
    assert.notEqual(
      excludedOnly.notes.reviewFingerprint,
      snapshot.notes.reviewFingerprint,
    );
    assert.equal(
      excludedOnly.notes.agentReviewFingerprint,
      snapshot.notes.agentReviewFingerprint,
    );
    assert.notEqual(excludedOnly.version, snapshot.version);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
