import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function agentRunNeeded(
  fingerprint,
  { activeFingerprint, completedFingerprint, failedFingerprint } = {},
) {
  return Boolean(
    fingerprint &&
      fingerprint !== activeFingerprint &&
      fingerprint !== completedFingerprint &&
      fingerprint !== failedFingerprint,
  );
}

function agentRunStopped({ code, error, signal }) {
  return Boolean(error || code || signal);
}

export function agentRunCompleted({ code, error, signal, superseded }) {
  if (superseded) return false;
  return !agentRunStopped({ code, error, signal });
}

export function agentRunSuperseded(
  queuedFingerprint,
  finishedFingerprint,
) {
  return Boolean(
    queuedFingerprint && queuedFingerprint !== finishedFingerprint,
  );
}

export function agentFallbackRecordNeeded({
  closing,
  queuedFingerprint,
  error,
  signal,
}) {
  if (closing) return false;
  if (queuedFingerprint) return false;
  return Boolean(error || signal);
}

export function agentRunFailed({
  closing,
  code,
  error,
  signal,
  superseded,
}) {
  if (closing) return false;
  if (superseded) return false;
  return agentRunStopped({ code, error, signal });
}

export function failedAgentRunForFingerprint(
  failedFingerprint,
  observedFingerprint,
) {
  if (!failedFingerprint || !observedFingerprint) return failedFingerprint;
  return failedFingerprint === observedFingerprint
    ? failedFingerprint
    : undefined;
}

export function nextAgentFingerprint({
  queuedFingerprint,
  observedFingerprint,
  finishedFingerprint,
}) {
  const latest = queuedFingerprint || observedFingerprint;
  if (!latest || latest === finishedFingerprint) return undefined;
  return latest;
}

export function browserCommand({ url, browser, platform = process.platform }) {
  if (browser) return { command: browser, args: [url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', url] };
  }
  return { command: 'xdg-open', args: [url] };
}

export function openBrowser(
  url,
  {
    browser = process.env.BROWSER,
    platform = process.platform,
    spawnProcess = spawn,
    onError = () => {},
  } = {},
) {
  try {
    const { command, args } = browserCommand({ url, browser, platform });
    const opener = spawnProcess(command, args, { detached: true, stdio: 'ignore' });
    opener.once('error', onError);
    opener.unref();
    return opener;
  } catch (error) {
    onError(error);
    return undefined;
  }
}

function builtAssetsReady({ root, exists = existsSync }) {
  const dist = join(root, 'dist');
  return exists(join(dist, 'index.html')) && exists(join(dist, 'assets'));
}

function npmCommand(platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function buildAssets(runtime) {
  const result = runtime.run(npmCommand(runtime.platform), ['run', 'build'], {
    cwd: runtime.root,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(`Could not build the local page: ${result.error.message}`);
  }
  if (result.status === 0) return;
  const status = Number.isInteger(result.status) ? Number(result.status) : 1;
  const error = new Error(
    `Could not build the local page: npm run build exited with ${status}.`,
  );
  error.exitCode = status;
  throw error;
}

export function ensureBuiltAssets(options) {
  const runtime = {
    exists: existsSync,
    run: spawnSync,
    platform: process.platform,
    ...options,
  };
  if (builtAssetsReady({ root: runtime.root, exists: runtime.exists })) return false;

  buildAssets(runtime);
  if (!builtAssetsReady({ root: runtime.root, exists: runtime.exists })) {
    throw new Error('Could not build the local page: built assets are still missing.');
  }
  return true;
}

function matchingAgentNotes(snapshot, previous) {
  return previous?.notes.fresh &&
    previous.notes.reviewFingerprint === snapshot.notes.reviewFingerprint &&
    previous.notes.agentReviewFingerprint === snapshot.notes.agentReviewFingerprint &&
    previous.notes.generatedFor === snapshot.notes.agentReviewFingerprint;
}

function newerAgentNotes(current, previous) {
  if (current.updatedAt !== previous.updatedAt) {
    return Boolean(current.updatedAt &&
      (!previous.updatedAt || current.updatedAt > previous.updatedAt));
  }
  return ['complete', 'changeReady', 'completedFiles'].some(
    (key) => Number(current[key] || 0) > Number(previous[key] || 0),
  );
}

function copyNoteFields(target, source, keys) {
  const next = { ...target };
  for (const key of keys) {
    if (Object.hasOwn(source, key)) next[key] = source[key];
    else delete next[key];
  }
  return next;
}

export function preserveAgentNotes(snapshot, previous) {
  if (!matchingAgentNotes(snapshot, previous)) return snapshot;
  if (newerAgentNotes(snapshot.notes, previous.notes)) return snapshot;

  const priorFiles = new Map(previous.files.map((file) => [file.path, file]));
  const files = snapshot.files.map((file) => {
    const prior = priorFiles.get(file.path);
    return prior ? copyNoteFields(file, prior, ['summary', 'noteReady', 'noteFailure']) : file;
  });
  const change = previous.notes.changeReady
    ? copyNoteFields(snapshot.change, previous.change, ['title', 'summary', 'why', 'highlights', 'risks'])
    : { ...snapshot.change };
  return {
    ...snapshot,
    files,
    change,
    notes: { ...previous.notes, totalFiles: snapshot.notes.totalFiles },
    usage: previous.usage,
  };
}
