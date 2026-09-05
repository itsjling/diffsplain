#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { helpText, parseCliArgs } from './cli-args.mjs';
import { applyAgentConfigOperation } from './agent-config.mjs';
import {
  agentReadOnlyWarning,
  assertFastCompatible,
  assertReasoningSupported,
  codingAgentFromSelectionError,
  codingAgentAvailability,
  codingAgentBinary,
  selectCodingAgent,
} from './coding-agents.mjs';
import {
  isBaseWorktreeTarget,
  reviewAccessMode,
  resolveBaseWorktreeCommit,
} from './local-target.mjs';
import { doctorReport } from './doctor.mjs';
import { accessTokenDirectory } from './access-token.mjs';
import {
  emptyUsageAccumulator,
  reviewUsage,
  usageSummary,
} from './agent-usage.mjs';
import { cacheStatus, clearCache, formatCacheStatus, pruneCache } from './cache.mjs';
import {
  agentFallbackRecordNeeded,
  agentRunCompleted,
  agentRunFailed,
  agentRunNeeded,
  agentRunSuperseded,
  ensureBuiltAssets,
  failedAgentRunForFingerprint,
  nextAgentFingerprint,
  openBrowser,
} from './presenter-runtime.mjs';
import {
  createSupportRecorder,
  formatSupportRecord,
  safeCommandVersion,
  writeSupportRecord,
} from './support-record.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const callerDirectory = process.cwd();
const cacheArgs = process.argv.slice(2);

function cacheUsage() {
  console.error(
    'Use: diffsplain cache [status|prune --age DAYS|prune --size BYTES|clear --yes]',
  );
  return 2;
}

function printCacheChange(result) {
  console.log(
    `Removed ${result.removed.length} inactive cache entries; kept ${result.retainedActive.length} active.`,
  );
  return 0;
}

function statusCommand(args) {
  if (args.length !== 1 && args.length !== 2) return cacheUsage();
  console.log(formatCacheStatus(cacheStatus()));
  return 0;
}

function clearCommand(args) {
  if (args.length !== 3 || args[2] !== '--yes') return cacheUsage();
  return printCacheChange(clearCache());
}

function pruneOptions(flag, rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) return undefined;
  if (flag === '--age') return { maxAgeMs: value * 86_400_000 };
  if (flag === '--size') return { maxBytes: value };
  return undefined;
}

function pruneCommand(args) {
  if (args.length !== 4) return cacheUsage();
  const options = pruneOptions(args[2], args[3]);
  return options ? printCacheChange(pruneCache(options)) : cacheUsage();
}

function runCacheCommand(args) {
  const commands = {
    status: statusCommand,
    clear: clearCommand,
    prune: pruneCommand,
  };
  const command = args[1] || 'status';
  return commands[command]?.(args) ?? cacheUsage();
}

if (cacheArgs[0] === 'cache') {
  process.exit(runCacheCommand(cacheArgs));
}
let cli;
try {
  cli = parseCliArgs(process.argv.slice(2), { callerDirectory });
} catch (error) {
  console.error(error.message);
  console.error('Run diffsplain --help for usage.');
  process.exit(2);
}

if (cli.help) {
  console.log(helpText);
  process.exit(0);
}
if (cli.version) {
  const packageJson = JSON.parse(
    readFileSync(resolve(root, 'package.json'), 'utf8'),
  );
  console.log(`diffsplain ${packageJson.version}`);
  process.exit(0);
}
if (cli.config) {
  try {
    const result = applyAgentConfigOperation(cli.config);
    if (result.kind === 'show') {
      console.log(result.agent ?? 'No default coding agent is configured.');
    } else if (result.kind === 'set') {
      console.log(`Default coding agent set to "${result.agent}".`);
    } else {
      console.log('Default coding agent unset.');
    }
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
if (cli.doctor) {
  if (cli.doctor.deep) {
    console.error(
      'Warning: deep checks run local provider commands. They do not send a provider prompt.',
    );
  }
  const report = await doctorReport({ deep: cli.doctor.deep });
  console.log(cli.doctor.json ? JSON.stringify(report.json, null, 2) : report.text);
  process.exit(report.ready ? 0 : 1);
}

let supportRecorder;
let supportRecordEmitted = false;

function wantsSupportRecord() {
  return cli.supportRecord || Boolean(cli.supportRecordFile);
}

function selectedProviderVersion(provider, binary) {
  if (!binary) return null;
  return safeCommandVersion(provider, binary);
}

function beginSupportRecord() {
  if (supportRecorder) return;
  if (!wantsSupportRecord()) return;
  supportRecorder = createSupportRecorder();
}

function recordSelectedProvider(provider, binary) {
  supportRecorder?.setProvider(
    provider,
    selectedProviderVersion(provider, binary),
  );
}

function deliverSupportRecord(record) {
  if (cli.supportRecordFile) {
    writeSupportRecord(cli.supportRecordFile, record);
    console.error(`Wrote support record to ${cli.supportRecordFile}`);
    return;
  }
  process.stderr.write(
    `Diffsplain support record:\n${formatSupportRecord(record)}`,
  );
}

function emitSupportRecord(code = 1) {
  if (!supportRecorder) return;
  if (supportRecordEmitted) return;
  supportRecordEmitted = true;
  const record = supportRecorder.failure(code);
  try {
    deliverSupportRecord(record);
  } catch {
    console.error('Could not write the support record.');
  }
}

function targetOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const { agentEnabled, browserEnabled, host, port } = cli;
const feedArgs = [...cli.feedArgs];
const agentArgs = [...cli.agentArgs];
const base = targetOption(feedArgs, '--base');
const head = targetOption(feedArgs, '--head');
const branch = targetOption(feedArgs, '--branch');
const checkout = feedArgs.includes('--checkout');
const reviewRepo = targetOption(feedArgs, '--repo');
const accessMode = reviewAccessMode({
  repo: reviewRepo,
  base,
  branch,
  checkout,
  head,
  noCheckoutAccess: cli.noCheckoutAccess,
  pullRequest: targetOption(feedArgs, '--pr'),
  worktree: feedArgs.includes('--worktree'),
});
if (isBaseWorktreeTarget({
  base,
  branch,
  checkout,
  head,
  pullRequest: targetOption(feedArgs, '--pr'),
  worktree: feedArgs.includes('--worktree'),
})) {
  try {
    resolveBaseWorktreeCommit(targetOption(feedArgs, '--repo'), base);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
let selectedAgent;
let selectedAgentBinary;
beginSupportRecord();
if (agentEnabled) {
  const selectionStarted = performance.now();
  try {
    selectedAgent = await selectCodingAgent(
      cli.agent,
      {
        available: (agent) =>
          codingAgentAvailability(agent, {
            binary: codingAgentBinary(agent, { codexBin: cli.codexBin }),
          }),
      },
    );
    selectedAgentBinary = codingAgentBinary(selectedAgent, {
      codexBin: cli.codexBin,
    });
    assertReasoningSupported(selectedAgent, cli.reasoning);
    assertFastCompatible(selectedAgent, selectedAgentBinary, cli.fast);
    recordSelectedProvider(selectedAgent, selectedAgentBinary);
    supportRecorder?.addStage(
      'agent',
      performance.now() - selectionStarted,
    );
    agentArgs.push('--agent', selectedAgent);
    const readOnlyWarning = agentReadOnlyWarning(selectedAgent, accessMode);
    if (readOnlyWarning) {
      console.log(readOnlyWarning);
      agentArgs.push('--provider-read-only-warning-emitted');
    }
  } catch (error) {
    recordSelectedProvider(
      codingAgentFromSelectionError(error) ||
        selectedAgent ||
        cli.agent ||
        'unknown',
    );
    supportRecorder?.addStage(
      'agent',
      performance.now() - selectionStarted,
      'failed',
    );
    console.error(error.message);
    emitSupportRecord();
    process.exit(1);
  }
} else {
  feedArgs.push('--no-summaries');
}
if (agentEnabled) {
  agentArgs.push('--access-mode', accessMode.mode);
  if (accessMode.mode === 'snapshot-only') {
    agentArgs.push('--access-reason', accessMode.reason);
  }
}
const outputIndex = feedArgs.indexOf('--output');
let runtimeDirectory;

if (outputIndex === -1) {
  runtimeDirectory = mkdtempSync(join(tmpdir(), 'diffsplain-live-'));
  const liveOutput = resolve(runtimeDirectory, 'diff-data.json');
  feedArgs.push('--output', liveOutput);
  agentArgs.push('--output', liveOutput);
}
const outputPath = resolve(
  callerDirectory,
  feedArgs[feedArgs.indexOf('--output') + 1],
);
let rawSnapshotPath = outputPath;
if (agentEnabled) {
  if (!runtimeDirectory) {
    runtimeDirectory = mkdtempSync(join(tmpdir(), 'diffsplain-live-'));
  }
  rawSnapshotPath = resolve(runtimeDirectory, 'raw-diff-data.json');
  const feedOutputIndex = feedArgs.indexOf('--output');
  feedArgs[feedOutputIndex + 1] = rawSnapshotPath;
  feedArgs.push('--exclude-output', outputPath);
}
const reviewSnapshotPath = agentEnabled ? rawSnapshotPath : outputPath;
process.on('exit', () => {
  if (runtimeDirectory) {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
if (!feedArgs.includes('--watch')) feedArgs.push('--watch');
const repoIndex = feedArgs.indexOf('--repo');
const remoteIndex = feedArgs.indexOf('--remote');
const projectKey = createHash('sha256')
  .update(
    remoteIndex === -1
      ? feedArgs[repoIndex + 1]
      : `${feedArgs[repoIndex + 1]}\0${feedArgs[remoteIndex + 1]}`,
  )
  .digest('hex')
  .slice(0, 12);
const accessDirectory = accessTokenDirectory();
const accessPath = join(accessDirectory, `${projectKey}.token`);
mkdirSync(accessDirectory, { recursive: true, mode: 0o700 });
chmodSync(accessDirectory, 0o700);
let previousAccess;
try {
  const savedAccess = readFileSync(accessPath, 'utf8').trim();
  if (/^[A-Za-z0-9_-]{43}$/.test(savedAccess)) previousAccess = savedAccess;
} catch {
  // The first run for a project has no prior tab access value.
}
const access = randomBytes(32).toString('base64url');
writeFileSync(accessPath, access, { mode: 0o600 });
chmodSync(accessPath, 0o600);
if (agentEnabled) {
  feedArgs.push('--ignore-summary-watch');
  agentArgs.push('--snapshot', rawSnapshotPath);
}

const snapshotStarted = performance.now();
let snapshotReady = false;
try {
  ensureBuiltAssets({ root });
} catch (error) {
  const exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  supportRecorder?.addStage(
    'snapshot',
    performance.now() - snapshotStarted,
    'failed',
  );
  console.error(error.message);
  emitSupportRecord(exitCode);
  process.exit(exitCode);
}

const feed = spawn(
  process.execPath,
  [resolve(root, 'scripts/build-diff-data.mjs'), ...feedArgs],
  {
    cwd: callerDirectory,
    stdio: ['inherit', 'pipe', 'inherit'],
  },
);
let closing = false;
let site;
let agent;
let agentTimer;
let agentFingerprint;
let completedAgentFingerprint;
let failedAgentFingerprint;
let queuedFingerprint;
let browserOpened = false;
let browserOpenTimer;
let siteReady = false;
let siteStarted;

function handleConnectedTab(line) {
  if (line !== 'Diffsplain tab: connected') return false;
  if (!browserOpened && browserOpenTimer) {
    clearTimeout(browserOpenTimer);
    browserOpenTimer = undefined;
    browserOpened = true;
    console.log('Reusing the open Diffsplain tab.');
  }
  return true;
}

function markSiteReady(match) {
  if (siteReady || !match) return;
  siteReady = true;
  supportRecorder?.addStage(
    'serve',
    performance.now() - siteStarted,
  );
}

function scheduleBrowserOpen(match) {
  if (!browserEnabled || browserOpened || browserOpenTimer || !match) return;
  browserOpenTimer = setTimeout(() => {
    browserOpenTimer = undefined;
    browserOpened = true;
    openBrowser(match[1], {
      onError: (error) =>
        console.error(`Could not open the browser: ${error.message}`),
    });
  }, 750);
}

function optionalSiteArgument(flag, value) {
  return value ? [flag, value] : [];
}

function chatAccessArguments() {
  if (accessMode.mode !== 'checkout-read-only') return [];
  return ['--chat-access-root', accessMode.root];
}

function chatAgentArguments() {
  if (!agentEnabled) return [];
  return [
    '--chat-agent',
    selectedAgent,
    '--chat-binary',
    selectedAgentBinary,
    '--chat-access-mode',
    accessMode.mode,
    ...chatAccessArguments(),
    ...optionalSiteArgument('--chat-model', cli.model),
    ...optionalSiteArgument('--chat-reasoning', cli.reasoning),
    ...(cli.fast ? ['--chat-fast'] : []),
  ];
}

function siteArguments() {
  return [
    resolve(root, 'scripts/serve-built.mjs'),
    '--output',
    outputPath,
    '--port',
    String(port),
    '--host',
    host,
    '--project',
    projectKey,
    '--access',
    access,
    ...optionalSiteArgument('--previous-access', previousAccess),
    '--chat-snapshot',
    outputPath,
    ...chatAgentArguments(),
    ...(!cli.portWasPassed ? ['--increment-port'] : []),
  ];
}

function handleSiteLine(line) {
  if (handleConnectedTab(line)) return;
  console.log(line);
  const match = line.match(/^Diffsplain: (http:\/\/\S+)$/);
  markSiteReady(match);
  scheduleBrowserOpen(match);
}

function listenForSiteLines(child) {
  if (!child.stdout) return;
  createInterface({ input: child.stdout }).on('line', handleSiteLine);
}

function siteFailed(code, signal) {
  return Boolean(code || signal);
}

function recordSiteFailure(code) {
  supportRecorder?.addStage('serve', performance.now() - siteStarted, 'failed');
  emitSupportRecord(code || 1);
}

function handleSiteExit(code, signal) {
  if (closing) return;
  if (siteFailed(code, signal)) recordSiteFailure(code);
  stop(code || (signal ? 1 : 0));
}

function handleSiteError(error) {
  if (closing) return;
  supportRecorder?.addStage('serve', performance.now() - siteStarted, 'failed');
  console.error(`Could not start the local page: ${error.message}`);
  emitSupportRecord();
  stop(1);
}

function startSite() {
  if (closing || site) return;
  siteStarted = performance.now();
  const child = spawn(process.execPath, siteArguments(), {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  site = child;
  listenForSiteLines(child);
  child.on('exit', handleSiteExit);
  child.on('error', handleSiteError);
}

function savedReviewFingerprint(notes) {
  if (!notes) return undefined;
  if (notes.agentReviewFingerprint) return notes.agentReviewFingerprint;
  return notes.reviewFingerprint;
}

function snapshotReviewFingerprint(snapshot) {
  const savedFingerprint = savedReviewFingerprint(snapshot.notes);
  if (savedFingerprint) return savedFingerprint;
  const reviewData = {
    repo: {
      name: snapshot.repo.name,
      base: snapshot.repo.base,
      head: snapshot.repo.head,
      branch: snapshot.repo.branch,
      baseBranch: snapshot.repo.baseBranch,
      remote: snapshot.repo.remote,
      targetKind: snapshot.repo.target?.kind,
    },
    change: {
      title: snapshot.change.title,
      number: snapshot.change.number,
    },
    files: snapshot.files.map((file) => ({
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      isBinary: file.isBinary,
      patch: file.patch,
    })),
  };
  return createHash('sha256')
    .update(JSON.stringify(reviewData))
    .digest('hex');
}

function noteMetadataMatches(notes, fingerprint) {
  return [
    notes.complete,
    notes.fresh,
    notes.generatedFor === fingerprint,
    notes.accessMode === accessMode.mode,
  ].every(Boolean);
}

function normalizedAgentSetting(value) {
  return value ?? null;
}

function agentSettingsMatch(notes) {
  return [
    notes.agent === selectedAgent,
    normalizedAgentSetting(notes.model) === normalizedAgentSetting(cli.model),
    normalizedAgentSetting(notes.reasoning) ===
      normalizedAgentSetting(cli.reasoning),
  ].every(Boolean);
}

function emptyReview(files) {
  return Array.isArray(files) && files.length === 0;
}

function hasCurrentAgentNotes(snapshot, fingerprint) {
  const notes = snapshot.notes;
  if (!savedReviewFingerprint(notes)) return false;
  if (!noteMetadataMatches(notes, fingerprint)) return false;
  if (emptyReview(snapshot.files)) return true;
  return agentSettingsMatch(notes);
}

function snapshotStateFromSnapshot(snapshot) {
  const fingerprint = snapshotReviewFingerprint(snapshot);
  return {
    fingerprint,
    hasCurrentAgentNotes: hasCurrentAgentNotes(snapshot, fingerprint),
  };
}

function snapshotState() {
  try {
    return snapshotStateFromSnapshot(
      JSON.parse(readFileSync(reviewSnapshotPath, 'utf8')),
    );
  } catch {
    return undefined;
  }
}

function snapshotFingerprint() {
  return snapshotState()?.fingerprint;
}

function recordAgentFallbackStage(needed, startedAt) {
  if (!needed) return;
  supportRecorder?.addStage(
    'agent',
    performance.now() - startedAt,
    'failed',
  );
}

function releaseAgentChild(child) {
  if (agent === child) agent = undefined;
  agentFingerprint = undefined;
}

function recordAgentRunResult({
  closing,
  code,
  error,
  signal,
  superseded,
  finishedFingerprint,
}) {
  if (agentRunCompleted({ code, error, signal, superseded })) {
    completedAgentFingerprint = finishedFingerprint;
  }
  if (!agentRunFailed({ closing, code, error, signal, superseded })) return;
  failedAgentFingerprint = finishedFingerprint;
  if (error) console.error(error.message);
  console.error(
    'The coding agent could not write notes. It will retry after the diff changes or Diffsplain restarts.',
  );
}

function scheduleNextAgentFingerprint({
  pendingFingerprint,
  finishedFingerprint,
}) {
  const nextFingerprint = nextAgentFingerprint({
    queuedFingerprint: pendingFingerprint,
    observedFingerprint: snapshotFingerprint(),
    finishedFingerprint,
  });
  queuedFingerprint = undefined;
  if (nextFingerprint) scheduleAgent(nextFingerprint);
}

function emitAgentFallbackRecord(needed, code) {
  if (needed) emitSupportRecord(code || 1);
}

function runAgent(fingerprint) {
  if (closing || !agentEnabled) return;
  if (agent) {
    if (fingerprint !== agentFingerprint) {
      queuedFingerprint = fingerprint;
      agent.kill('SIGTERM');
    }
    return;
  }
  agentFingerprint = fingerprint;
  const agentStarted = performance.now();
  const child = spawn(
    process.execPath,
    [resolve(root, 'scripts/generate-summaries.mjs'), ...agentArgs],
    { cwd: callerDirectory, stdio: 'inherit' },
  );
  agent = child;
  let settled = false;
  const finish = (code, signal, error) => {
    if (settled) return;
    settled = true;
    const finishedFingerprint = agentFingerprint;
    const pendingFingerprint = queuedFingerprint;
    const superseded = agentRunSuperseded(
      pendingFingerprint,
      finishedFingerprint,
    );
    const needsFallbackRecord = agentFallbackRecordNeeded({
      closing,
      queuedFingerprint: pendingFingerprint,
      error,
      signal,
    });
    recordAgentFallbackStage(needsFallbackRecord, agentStarted);
    releaseAgentChild(child);
    recordAgentRunResult({
      closing,
      code,
      error,
      signal,
      superseded,
      finishedFingerprint,
    });
    scheduleNextAgentFingerprint({
      pendingFingerprint,
      finishedFingerprint,
    });
    emitAgentFallbackRecord(needsFallbackRecord, code);
  };
  child.on('error', (error) => finish(1, undefined, error));
  child.on('exit', (code, signal) => finish(code, signal));
}

function scheduleAgent(fingerprint) {
  const state = snapshotState();
  const selectedFingerprint = fingerprint || state?.fingerprint;
  failedAgentFingerprint = failedAgentRunForFingerprint(
    failedAgentFingerprint,
    selectedFingerprint,
  );
  if (
    !cli.forceSummaryRegeneration &&
    !agentFingerprint &&
    state?.hasCurrentAgentNotes &&
    selectedFingerprint === state.fingerprint
  ) {
    console.log('Reusing current agent notes.');
    return;
  }
  if (
    !agentRunNeeded(selectedFingerprint, {
      activeFingerprint: agentFingerprint,
      completedFingerprint: completedAgentFingerprint,
      failedFingerprint: failedAgentFingerprint,
    })
  ) {
    return;
  }
  if (agent) {
    if (selectedFingerprint !== agentFingerprint) {
      queuedFingerprint = selectedFingerprint;
      console.log(
        'Review changed while notes were generated. Restarting agent notes...',
      );
      agent.kill('SIGTERM');
    }
    return;
  }
  clearTimeout(agentTimer);
  const delay = agentFingerprint ? 300 : 0;
  console.log('Preparing agent notes...');
  agentTimer = setTimeout(() => runAgent(selectedFingerprint), delay);
}

function markSnapshotReady() {
  if (snapshotReady) return;
  snapshotReady = true;
  try {
    supportRecorder?.addBytes('snapshot', statSync(reviewSnapshotPath).size);
  } catch {}
  supportRecorder?.addStage(
    'snapshot',
    performance.now() - snapshotStarted,
  );
}

function snapshotForPresentation(snapshot) {
  const zeroUsage = usageSummary(emptyUsageAccumulator());
  const hasCurrentNotes = snapshotStateFromSnapshot(snapshot)
    .hasCurrentAgentNotes;
  const current = {
    ...snapshot,
    usage: reviewUsage(zeroUsage, zeroUsage),
  };
  if (hasCurrentNotes && snapshot.notes?.fast === cli.fast) return current;
  const content = {
    ...current,
    notes: {
      ...snapshot.notes,
      fast: cli.fast,
      ...(hasCurrentNotes
        ? {}
        : { complete: false, status: 'generating' }),
    },
  };
  delete content.version;
  delete content.generatedAt;
  return {
    version: createHash('sha256')
      .update(JSON.stringify(content))
      .digest('hex')
      .slice(0, 12),
    generatedAt: new Date().toISOString(),
    ...content,
  };
}

function seedPresentationSnapshot() {
  const snapshot = snapshotForPresentation(
    JSON.parse(readFileSync(rawSnapshotPath, 'utf8')),
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  const pendingOutput = `${outputPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(pendingOutput, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(pendingOutput, outputPath);
}

function isSnapshotLine(line) {
  return line.startsWith('Wrote ') || line === 'No diff-data changes';
}

function startSnapshotDependents({ rawSnapshotWritten = false } = {}) {
  if (agentEnabled && rawSnapshotWritten) {
    try {
      seedPresentationSnapshot();
    } catch (error) {
      console.error(`Could not publish the live snapshot: ${error.message}`);
      emitSupportRecord();
      stop(1);
      return;
    }
  }
  markSnapshotReady();
  startSite();
  if (agentEnabled) scheduleAgent();
}

function shouldPrintFeedLine(line) {
  return line !== 'No diff-data changes' || !agentEnabled;
}

function handleFeedLine(line) {
  if (isSnapshotLine(line)) {
    startSnapshotDependents({ rawSnapshotWritten: line.startsWith('Wrote ') });
  }
  if (shouldPrintFeedLine(line)) console.log(line);
}

if (feed.stdout) {
  const feedLines = createInterface({ input: feed.stdout });
  feedLines.on('line', handleFeedLine);
}

function stopChild(child) {
  if (child && !child.killed) child.kill('SIGTERM');
}

function stop(code = 0) {
  if (closing) return;
  closing = true;
  clearTimeout(browserOpenTimer);
  clearTimeout(agentTimer);
  [feed, site, agent].forEach(stopChild);
  process.exitCode = code;
}

feed.on('exit', (code, signal) => {
  if (!closing && (code || signal)) {
    supportRecorder?.addStage(
      'snapshot',
      performance.now() - snapshotStarted,
      'failed',
    );
    emitSupportRecord(code || 1);
    stop(code || 1);
  }
});
feed.on('error', (error) => {
  if (!closing) {
    supportRecorder?.addStage(
      'snapshot',
      performance.now() - snapshotStarted,
      'failed',
    );
    console.error(`Could not start the diff watcher: ${error.message}`);
    emitSupportRecord();
    stop(1);
  }
});
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
