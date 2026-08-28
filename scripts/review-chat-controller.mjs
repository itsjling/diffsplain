import { readFileSync } from 'node:fs';
import {
  ReviewChatError,
  chatInputLimit,
  chatSnapshotPath,
  clone,
  commandInput,
  currentPaths,
  inputBytes,
  makeInput,
  newThread,
  providerExecution,
  publicError,
  reviewChatPreservedMessageCount,
  reviewEvidence,
  snapshotFingerprint,
  stateThread,
  threadKey,
  validateReviewChatAnswer,
} from './review-chat-context.mjs';

const noChange = () => {};
const snapshotOnly = { mode: 'snapshot-only' };
function snapshotRead(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { error: new Error('The current review snapshot is not available.') };
  }
}

function completeSnapshot(value) {
  return Array.isArray(value?.files) && Boolean(snapshotFingerprint(value));
}

function currentSnapshot(path) {
  const result = snapshotRead(path);
  if (result.error) throw result.error;
  if (!completeSnapshot(result.value)) {
    throw new Error('The current review snapshot is incomplete.');
  }
  return result.value;
}

function snapshotState(path, run) {
  try {
    return snapshotFingerprint(currentSnapshot(path)) === run.fingerprint
      ? 'current'
      : 'changed';
  } catch {
    return 'unavailable';
  }
}

function staleCurrentThreads(threads, currentThreads) {
  return [...currentThreads.values()].some((id) => threads.get(id)?.stale);
}

function stateThreads(threads, currentThreads) {
  return [...threads.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((thread) => stateThread(thread, currentThreads.get(thread.key) === thread.id));
}

function runState(run) {
  return run.kind === 'compact'
    ? { status: 'blocked', needsCompaction: true }
    : { status: 'failed' };
}

function cancelledState(run) {
  return run.kind === 'compact'
    ? { status: 'blocked', needsCompaction: true }
    : { status: 'cancelled' };
}

function matchingRun(thread, run) {
  return thread.run === run && thread.activeRunId === run.id;
}

function matchingFingerprint(thread, run, fingerprint) {
  return thread.fingerprint === fingerprint && run.fingerprint === fingerprint;
}

function validatedAnswer(value, paths) {
  try {
    return { answer: validateReviewChatAnswer(value, paths) };
  } catch (error) {
    return { error };
  }
}

function executionResult(provider, input) {
  try {
    return { execution: providerExecution(provider, input) };
  } catch (error) {
    return { error };
  }
}

function historyWithoutQuestion(messages, question) {
  const last = messages.at(-1);
  if (last?.role !== 'user' || last.text !== question) return messages;
  return messages.slice(0, -1);
}

function appendQuestion(thread, question, addQuestion) {
  if (addQuestion) thread.messages.push({ role: 'user', text: question });
  return historyWithoutQuestion(thread.messages, question);
}

function compactionParts(messages) {
  return {
    older: messages.slice(0, -reviewChatPreservedMessageCount),
    preserved: messages.slice(-reviewChatPreservedMessageCount),
  };
}

function canCompact(parts, question, limit) {
  return parts.older.length > 0 && inputBytes(parts.preserved, question) <= limit;
}

function threadCanRetry(thread) {
  return Boolean(thread.pendingQuestion) && !thread.needsCompaction;
}

function retryStatus(thread) {
  return ['failed', 'cancelled'].includes(thread.status);
}

export class ReviewChatController {
  constructor(options = {}) {
    this.snapshotPath = chatSnapshotPath(options);
    this.provider = options.provider;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : noChange;
    this.inputLimitBytes = chatInputLimit(options);
    this.accessMode = options.accessMode || snapshotOnly;
    this.threads = new Map();
    this.currentThreads = new Map();
    this.snapshot = undefined;
    this.fingerprint = undefined;
    this.snapshotError = undefined;
    this.runNumber = 0;
    this.threadNumber = 0;
    this.closed = false;
    this.commandHandlers = {
      new: this.newCommand.bind(this),
      ask: this.askCommand.bind(this),
      cancel: this.cancelCommand.bind(this),
      retry: this.retryCommand.bind(this),
      'retry-compaction': this.retryCompactionCommand.bind(this),
    };
    this.refresh({ notify: false });
  }

  api() {
    return {
      getState: this.getState.bind(this),
      command: this.command.bind(this),
      refresh: this.refresh.bind(this),
      close: this.close.bind(this),
    };
  }

  getState() {
    return clone({
      available: Boolean(this.provider) && !this.closed,
      fingerprint: this.fingerprint || null,
      snapshotReady: Boolean(this.snapshot),
      ...(this.snapshotError ? { error: this.snapshotError } : {}),
      inputLimitBytes: this.inputLimitBytes,
      stale: staleCurrentThreads(this.threads, this.currentThreads),
      threads: stateThreads(this.threads, this.currentThreads),
    });
  }

  notify() {
    try {
      this.onChange(this.getState());
    } catch {
      // A client notification cannot stop review work.
    }
  }

  assertProvider() {
    if (this.closed) throw new ReviewChatError('Review chat is closed.', 409);
    if (!this.provider) {
      throw new ReviewChatError('Chat needs a selected coding agent.', 409);
    }
  }

  assertAvailable() {
    this.assertProvider();
    if (this.snapshotError) throw new ReviewChatError(this.snapshotError, 409);
    if (!this.snapshot || !this.fingerprint) {
      throw new ReviewChatError('The current review is not ready.', 409);
    }
  }

  checkFile(command) {
    if (command.scope !== 'file') return;
    if (!currentPaths(this.snapshot).has(command.path)) {
      throw new ReviewChatError('That file is not in the current review.');
    }
  }

  currentThread(command) {
    return this.threads.get(this.currentThreads.get(threadKey(command)));
  }

  discardThread(thread) {
    if (!thread) return;
    this.threads.delete(thread.id);
    if (this.currentThreads.get(thread.key) === thread.id) {
      this.currentThreads.delete(thread.key);
    }
  }

  getThread(command) {
    const thread = this.currentThread(command);
    if (!thread) throw new ReviewChatError('Start a new chat thread first.', 409);
    if (thread.stale || thread.fingerprint !== this.fingerprint) {
      throw new ReviewChatError('This chat thread is stale. Start a new thread.', 409);
    }
    return thread;
  }

  currentRun(thread, run) {
    return !this.closed &&
      !thread.stale &&
      matchingRun(thread, run) &&
      matchingFingerprint(thread, run, this.fingerprint);
  }

  clearRun(thread) {
    thread.run = undefined;
    thread.activeRunId = undefined;
  }

  markFailure(thread, run, error) {
    this.clearRun(thread);
    thread.error = publicError(error);
    Object.assign(thread, runState(run));
  }

  markUnavailableRun(thread, run) {
    this.markFailure(thread, run, new Error('The current review snapshot is not available.'));
    this.refresh({ notify: false });
    this.notify();
  }

  fenceSnapshot(thread, run, state) {
    if (state === 'current') return false;
    if (state === 'changed') {
      this.refresh();
      return true;
    }
    this.markUnavailableRun(thread, run);
    return true;
  }

  fenceChangedReview(thread, run) {
    if (!this.currentRun(thread, run)) return true;
    return this.fenceSnapshot(thread, run, snapshotState(this.snapshotPath, run));
  }

  finishFailure(thread, run, error) {
    if (this.fenceChangedReview(thread, run)) return;
    this.markFailure(thread, run, error);
    this.notify();
  }

  completeAnswer(thread, answer) {
    this.clearRun(thread);
    thread.messages.push({ role: 'assistant', answer });
    thread.pendingQuestion = undefined;
    thread.needsCompaction = false;
    thread.status = 'ready';
    thread.error = undefined;
    this.notify();
  }

  completeCompaction(thread, run, answer) {
    const messages = [{ role: 'compacted', answer }, ...run.preserved];
    if (inputBytes(messages, thread.pendingQuestion) > this.inputLimitBytes) {
      this.finishFailure(
        thread,
        run,
        new Error('The compacted chat history still exceeds the input limit.'),
      );
      return;
    }
    this.clearRun(thread);
    thread.messages = messages;
    thread.needsCompaction = false;
    this.startAnswer(thread, thread.pendingQuestion);
  }

  completeRun(thread, run, answer) {
    if (run.kind === 'compact') {
      this.completeCompaction(thread, run, answer);
      return;
    }
    this.completeAnswer(thread, answer);
  }

  acceptAnswer(thread, run, result) {
    if (result.error) {
      this.finishFailure(thread, run, result.error);
      return;
    }
    this.completeRun(thread, run, result.answer);
  }

  finishSuccess(thread, run, value) {
    if (this.fenceChangedReview(thread, run)) return;
    this.acceptAnswer(thread, run, validatedAnswer(value, run.paths));
  }

  startRun(thread, run, input) {
    thread.run = run;
    thread.activeRunId = run.id;
    thread.status = run.kind === 'compact' ? 'compacting' : 'running';
    thread.error = undefined;
    this.notify();
    const result = executionResult(this.provider, input);
    if (result.error) {
      this.finishFailure(thread, run, result.error);
      return;
    }
    run.cancel = result.execution.cancel;
    result.execution.promise.then(
      (value) => this.finishSuccess(thread, run, value),
      (error) => this.finishFailure(thread, run, error),
    );
  }

  answerRun(thread, evidence) {
    return {
      id: ++this.runNumber,
      kind: 'answer',
      fingerprint: this.fingerprint,
      paths: new Set(evidence.paths),
      cancel: noChange,
    };
  }

  startAnswer(thread, question, options = {}) {
    const history = appendQuestion(thread, question, options.addQuestion !== false);
    const evidence = reviewEvidence(this.snapshot, thread);
    const run = this.answerRun(thread, evidence);
    this.startRun(thread, run, makeInput({
      kind: 'answer',
      context: evidence.context,
      messages: history,
      question,
      paths: evidence.paths,
      accessMode: this.accessMode,
    }));
  }

  blockForInputLimit(thread) {
    thread.status = 'blocked';
    thread.needsCompaction = false;
    thread.error = 'The newest chat messages exceed the input limit. Start a new thread.';
    this.notify();
    return false;
  }

  compactionRun(evidence, preserved) {
    return {
      id: ++this.runNumber,
      kind: 'compact',
      fingerprint: this.fingerprint,
      paths: new Set(evidence.paths),
      preserved,
      cancel: noChange,
    };
  }

  startCompaction(thread) {
    const parts = compactionParts(thread.messages);
    if (!canCompact(parts, thread.pendingQuestion, this.inputLimitBytes)) {
      return this.blockForInputLimit(thread);
    }
    const evidence = reviewEvidence(this.snapshot, thread);
    const run = this.compactionRun(evidence, parts.preserved);
    this.startRun(thread, run, makeInput({
      kind: 'compact',
      context: evidence.context,
      messages: parts.older,
      paths: evidence.paths,
      accessMode: this.accessMode,
    }));
    return true;
  }

  cancelProvider(run) {
    try {
      run.cancel();
    } catch {
      // A provider may already have released its child process.
    }
  }

  cancelRun(thread, { stale = false } = {}) {
    const run = thread.run;
    if (!run) return false;
    this.clearRun(thread);
    this.cancelProvider(run);
    if (!stale) Object.assign(thread, cancelledState(run));
    if (!stale) thread.error = undefined;
    return true;
  }

  staleThread(thread) {
    this.cancelRun(thread, { stale: true });
    thread.stale = true;
    thread.status = 'stale';
    thread.error = undefined;
  }

  staleCurrentThreads() {
    for (const id of this.currentThreads.values()) {
      const thread = this.threads.get(id);
      if (thread && !thread.stale) this.staleThread(thread);
    }
  }

  notifyRefresh(changed, recovered, shouldNotify) {
    if (shouldNotify && (changed || recovered)) this.notify();
  }

  acceptSnapshot(next, shouldNotify) {
    const nextFingerprint = snapshotFingerprint(next);
    const changed = Boolean(this.fingerprint && this.fingerprint !== nextFingerprint);
    const recovered = Boolean(this.snapshotError);
    this.snapshot = next;
    this.snapshotError = undefined;
    this.fingerprint = nextFingerprint;
    if (changed) this.staleCurrentThreads();
    this.notifyRefresh(changed, recovered, shouldNotify);
    return this.getState();
  }

  failedRefresh(error, shouldNotify) {
    this.snapshotError = publicError(error);
    if (shouldNotify) this.notify();
    return this.getState();
  }

  refresh(options = {}) {
    if (this.closed) return this.getState();
    const shouldNotify = options.notify !== false;
    try {
      return this.acceptSnapshot(currentSnapshot(this.snapshotPath), shouldNotify);
    } catch (error) {
      return this.failedRefresh(error, shouldNotify);
    }
  }

  result(accepted) {
    return { accepted, state: this.getState() };
  }

  prepareCommand(requested) {
    this.assertAvailable();
    this.checkFile(requested);
  }

  replaceThread(old, requested) {
    if (old) this.cancelRun(old);
    if (old && !old.stale) this.discardThread(old);
    const fresh = newThread(requested, this.fingerprint, `thread-${++this.threadNumber}`);
    this.threads.set(fresh.id, fresh);
    this.currentThreads.set(threadKey(requested), fresh.id);
  }

  newCommand(requested) {
    this.prepareCommand(requested);
    this.replaceThread(this.currentThread(requested), requested);
    this.notify();
    return this.result(false);
  }

  cancelCommand(requested) {
    this.assertProvider();
    const thread = this.getThread(requested);
    if (!this.cancelRun(thread)) {
      throw new ReviewChatError('This chat thread is not running.', 409);
    }
    this.notify();
    return this.result(false);
  }

  assertIdle(thread) {
    if (thread.run) throw new ReviewChatError('This chat thread is already running.', 409);
  }

  assertAskable(thread) {
    if (thread.needsCompaction) {
      throw new ReviewChatError('Retry compaction or start a new thread before asking again.', 409);
    }
    if (thread.status === 'blocked') {
      throw new ReviewChatError('Start a new thread before asking again.', 409);
    }
  }

  startQuestion(thread, question) {
    thread.pendingQuestion = question;
    if (inputBytes(thread.messages, question) > this.inputLimitBytes) {
      return this.startCompaction(thread);
    }
    this.startAnswer(thread, question);
    return true;
  }

  askCommand(requested) {
    this.prepareCommand(requested);
    const thread = this.getThread(requested);
    this.assertIdle(thread);
    this.assertAskable(thread);
    return this.result(this.startQuestion(thread, requested.question));
  }

  assertRetryable(thread) {
    if (!threadCanRetry(thread)) {
      throw new ReviewChatError('This chat thread has no answer to retry.', 409);
    }
    if (!retryStatus(thread)) {
      throw new ReviewChatError('This chat thread cannot be retried now.', 409);
    }
  }

  retryCommand(requested) {
    this.prepareCommand(requested);
    const thread = this.getThread(requested);
    this.assertIdle(thread);
    this.assertRetryable(thread);
    this.startAnswer(thread, thread.pendingQuestion, { addQuestion: false });
    return this.result(true);
  }

  retryCompactionCommand(requested) {
    this.prepareCommand(requested);
    const thread = this.getThread(requested);
    this.assertIdle(thread);
    if (!thread.pendingQuestion || !thread.needsCompaction) {
      throw new ReviewChatError('This chat thread has no compaction to retry.', 409);
    }
    return this.result(this.startCompaction(thread));
  }

  command(rawCommand) {
    const requested = commandInput(rawCommand);
    return this.commandHandlers[requested.type](requested);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const thread of this.threads.values()) this.cancelRun(thread);
    this.provider?.close?.();
    this.threads.clear();
    this.currentThreads.clear();
    this.snapshot = undefined;
    this.fingerprint = undefined;
    this.snapshotError = undefined;
  }
}
