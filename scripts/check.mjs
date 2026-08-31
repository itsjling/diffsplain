import { execFile, spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageManager = (() => {
  if (process.env.npm_execpath) {
    return { command: process.execPath, prefix: [process.env.npm_execpath] };
  }
  return { command: 'corepack', prefix: ['pnpm'] };
})();

async function runCommand(command, args) {
  await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
    });

    child.once('error', rejectCommand);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      rejectCommand(new Error(`exited with ${code ?? signal ?? 'an error'}`));
    });
  });
}

function runPackageManager(args) {
  return runCommand(packageManager.command, [...packageManager.prefix, ...args]);
}

function execPackageManager(args, options) {
  return execFileAsync(
    packageManager.command,
    [...packageManager.prefix, ...args],
    options,
  );
}

const proofFailure = process.env.DIFFSPLAIN_CHECK_PROOF_FAIL_STAGE;
const proofMode = process.env.DIFFSPLAIN_CHECK_PROOF_MODE === '1';
const executeStage = proofMode
  ? (id) => {
      if (proofFailure === id) throw new Error('proof failure');
    }
  : (_id, run) => run();
const packageOnly = process.argv.includes('--package-only');
const releaseTarballIndex = process.argv.indexOf('--release-tarball');
const releaseTarball =
  releaseTarballIndex === -1
    ? undefined
    : resolve(root, process.argv[releaseTarballIndex + 1]);
const requiredPackageFiles = [
  'README.md',
  'package.json',
  'dist/index.html',
  'scripts/access-token.mjs',
  'scripts/agent-config.mjs',
  'scripts/agent-exclusions.mjs',
  'scripts/agent-review.mjs',
  'scripts/build-diff-data.mjs',
  'scripts/cache.mjs',
  'scripts/cli-args.mjs',
  'scripts/coding-agents.mjs',
  'scripts/dev.mjs',
  'scripts/doctor.mjs',
  'scripts/generate-summaries.mjs',
  'scripts/local-target.mjs',
  'scripts/mock-agent.mjs',
  'scripts/present.mjs',
  'scripts/presenter-runtime.mjs',
  'scripts/review-chat.mjs',
  'scripts/review-chat-context.mjs',
  'scripts/review-chat-controller.mjs',
  'scripts/review-chat-provider.mjs',
  'scripts/serve-built.mjs',
  'scripts/summary-path.mjs',
  'scripts/support-record.mjs',
];
const allowedPackageFile = /^(README(?:\.md)?|LICENSE(?:\.md)?|NOTICE(?:\.md)?|package\.json|dist\/.+|scripts\/(?:access-token|agent-config|agent-exclusions|agent-review|build-diff-data|cache|cli-args|coding-agents|dev|doctor|generate-summaries|local-target|mock-agent|present|presenter-runtime|review-chat(?:-context|-controller|-provider)?|serve-built|summary-path|support-record)\.mjs)$/;
const privatePackageFile = /(^|\/)(?:\.env|\.npmrc|\.git|\.github|\.agents|\.codex)(?:\/|$)|\.(?:pem|key)$/i;

export function validatePackageManifest(pack) {
  const files = pack.files ?? [];
  const paths = new Set(files.map((file) => file.path));
  const missing = requiredPackageFiles.filter((path) => !paths.has(path));
  const unexpected = files.filter((file) => !allowedPackageFile.test(file.path));
  const privateFiles = files.filter((file) => privatePackageFile.test(file.path));
  const oversizedPackage = pack.unpackedSize > 12_000_000;
  const oversizedFile = files.some((file) => file.size > 1_000_000);
  const problems = [
    { present: missing.length > 0, text: `missing ${missing.join(', ')}` },
    {
      present: unexpected.length > 0,
      text: `unexpected ${unexpected.map((file) => file.path).join(', ')}`,
    },
    {
      present: privateFiles.length > 0,
      text: `private ${privateFiles.map((file) => file.path).join(', ')}`,
    },
    { present: oversizedPackage, text: 'package exceeds 12 MB' },
    { present: oversizedFile, text: 'file exceeds 1 MB' },
  ]
    .filter((problem) => problem.present)
    .map((problem) => problem.text);

  if (problems.length) {
    throw new Error(`Package manifest failed: ${problems.join('; ')}`);
  }
}

async function runStage(id, name, run) {
  console.log(`\n==> ${name}`);

  try {
    await executeStage(id, run);
  } catch (error) {
    throw new Error(`${name} failed: ${error.message}`);
  }

  console.log(`✓ ${name}`);
}

async function makeSmokeCommandFixtures(consumerRoot) {
  const bin = join(consumerRoot, 'bin');
  const windows = process.platform === 'win32';
  const extension = windows ? '.cmd' : '';
  const contents = windows
    ? '@echo off\r\necho test version\r\n'
    : '#!/bin/sh\nprintf "%s\\n" "test version"\n';
  await mkdir(bin);
  for (const command of ['git', 'gh', 'codex']) {
    const path = join(bin, `${command}${extension}`);
    await writeFile(path, contents);
    await chmod(path, 0o755);
  }
  return bin;
}

async function makeSmokeRuntimeFixture(consumerRoot) {
  const fixture = join(consumerRoot, 'fixture');
  await mkdir(fixture);
  await execFileAsync('git', ['init', '-q'], { cwd: fixture });
  await execFileAsync('git', ['config', 'user.email', 'release@example.test'], {
    cwd: fixture,
  });
  await execFileAsync('git', ['config', 'user.name', 'Release test'], {
    cwd: fixture,
  });
  await writeFile(join(fixture, 'changed.txt'), 'before\n');
  await execFileAsync('git', ['add', 'changed.txt'], { cwd: fixture });
  await execFileAsync('git', ['commit', '-qm', 'base'], { cwd: fixture });
  await writeFile(join(fixture, 'changed.txt'), 'after\n');
  const runtimeOutput = join(consumerRoot, 'runtime.json');
  await execFileAsync(
    process.execPath,
    [
      resolve(
        consumerRoot,
        'node_modules/diffsplain/scripts/build-diff-data.mjs',
      ),
      '--repo',
      fixture,
      '--output',
      runtimeOutput,
    ],
    { cwd: consumerRoot },
  );
  return JSON.parse(await readFile(runtimeOutput, 'utf8'));
}

function verifySmokeResults({ packageJson, version, help, doctor, runtime }) {
  const checks = [
    packageJson.name === 'diffsplain',
    version.stdout.includes(packageJson.version),
    help.stdout.includes('Usage:'),
    doctor.stdout.includes('Diffsplain doctor'),
    runtime.files?.[0]?.path === 'changed.txt',
  ];
  if (checks.includes(false)) {
    throw new Error('packed package has the wrong name');
  }
}

async function smokeTestPackage() {
  const packageRoot = await mkdtemp(join(tmpdir(), 'diffsplain-package-'));
  const consumerRoot = join(packageRoot, 'consumer');

  try {
    const { stdout } = await execPackageManager(
      [
        'pack',
        '--config.ignore-scripts=true',
        '--json',
        '--pack-destination',
        packageRoot,
      ],
      { cwd: root },
    );
    const packResult = JSON.parse(stdout);
    const pack = Array.isArray(packResult) ? packResult[0] : packResult;
    const tarball = isAbsolute(pack.filename)
      ? pack.filename
      : join(packageRoot, pack.filename);
    validatePackageManifest(pack);
    if (releaseTarball) {
      await mkdir(dirname(releaseTarball), { recursive: true });
      await copyFile(tarball, releaseTarball);
    }

    await mkdir(consumerRoot);
    await writeFile(
      join(consumerRoot, 'package.json'),
      JSON.stringify({ private: true, name: 'diffsplain-smoke-test' }),
    );
    await execPackageManager(
      ['install', '--ignore-scripts', tarball],
      { cwd: consumerRoot },
    );

    const packageJson = JSON.parse(
      await readFile(join(consumerRoot, 'node_modules/diffsplain/package.json')),
    );
    const executable = resolve(
      consumerRoot,
      'node_modules/diffsplain',
      packageJson.bin.diffsplain,
    );
    const version = await execFileAsync(process.execPath, [executable, '--version'], {
      cwd: consumerRoot,
    });
    const help = await execFileAsync(process.execPath, [executable, '--help'], {
      cwd: consumerRoot,
    });

    const bin = await makeSmokeCommandFixtures(consumerRoot);
    const doctor = await execFileAsync(process.execPath, [executable, 'doctor'], {
      cwd: consumerRoot,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
    const runtime = await makeSmokeRuntimeFixture(consumerRoot);
    verifySmokeResults({ packageJson, version, help, doctor, runtime });
  } finally {
    await rm(packageRoot, { force: true, recursive: true });
  }
}

const stages = [
  ['lint', 'React and TypeScript lint', () => runPackageManager(['run', 'lint'])],
  ['build', 'Production app build', () => runPackageManager(['run', 'build'])],
  ['test', 'Unit and integration tests', () => runPackageManager(['run', 'test:run'])],
  ['docs', 'Documentation checks', () => runPackageManager(['run', 'docs:check'])],
  ['docs', 'Production docs build', () => runPackageManager(['run', 'docs:build'])],
];

export async function runCheck() {
  const selectedStages = packageOnly
    ? stages.filter(([id]) => id === 'build')
    : stages;
  for (const [id, name, run] of selectedStages) {
    await runStage(id, name, run);
  }
  await runStage('package', 'Packed-package smoke test', smokeTestPackage);
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCheck();
  } catch (error) {
    console.error(`\nCheck stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
