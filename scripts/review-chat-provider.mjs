import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentCommand,
  parseAgentResponse,
} from './coding-agents.mjs';

const maximumProviderOutputBytes = 1024 * 1024;
const forcedChildKillDelayMs = 250;
const noChange = () => {};

function removeTemporary(path) {
  rmSync(path, { force: true, recursive: true });
}

function cancelledError() {
  return new Error('The chat request was cancelled.');
}

function spawnProcess(invocation) {
  try {
    return {
      child: spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    return { error };
  }
}

function childOutput(chunks) {
  return Buffer.concat(chunks).toString('utf8');
}

function childFailure(agent, status, signal, stdout, stderr) {
  const detail = stderr.trim() || stdout.trim();
  const suffix = detail ? `: ${detail.slice(-600)}` : '';
  return new Error(`${agent} exited with status ${status ?? signal}${suffix}`);
}

function aborted(signal) {
  return Boolean(signal?.aborted);
}

function successfulExit(status, signal) {
  return status === 0 && !signal;
}

function closeError(execution, status, signal) {
  if (aborted(execution.signal)) return cancelledError();
  if (successfulExit(status, signal)) return undefined;
  return childFailure(
    execution.agent,
    status,
    signal,
    childOutput(execution.stdout),
    childOutput(execution.stderr),
  );
}

function providerAgent(options) {
  const agent = options?.agent;
  if (!agent) throw new Error('Chat provider needs a coding agent');
  return agent;
}

function providerBinary(options, agent) {
  return options.binary || agent;
}

function providerEnvironment(options) {
  return options.env || process.env;
}

function providerOptions(options) {
  const agent = providerAgent(options);
  return {
    agent,
    binary: providerBinary(options, agent),
    model: options.model,
    reasoning: options.reasoning,
    accessMode: options.accessMode,
    env: providerEnvironment(options),
  };
}

function temporaryRequest() {
  const temporary = mkdtempSync(join(tmpdir(), 'diffsplain-review-chat-'));
  return {
    temporary,
    inputPath: join(temporary, 'input.json'),
    schemaPath: join(temporary, 'schema.json'),
  };
}

function writeRequest(paths, request) {
  writeFileSync(paths.inputPath, JSON.stringify(request));
  writeFileSync(paths.schemaPath, JSON.stringify(request.responseSchema));
}

function providerInvocation(options, request, paths) {
  return agentCommand({
    agent: options.agent,
    binary: options.binary,
    model: options.model,
    reasoning: options.reasoning,
    prompt: request.prompt,
    schema: request.responseSchema,
    schemaPath: paths.schemaPath,
    inputPath: paths.inputPath,
    accessMode: options.accessMode,
    env: options.env,
  });
}

function preparedProviderRequest(options, request) {
  const paths = temporaryRequest();
  try {
    writeRequest(paths, request);
    return { temporary: paths.temporary, invocation: providerInvocation(options, request, paths) };
  } catch (error) {
    removeTemporary(paths.temporary);
    throw error;
  }
}

class ChildExecution {
  constructor({ invocation, input, agent, signal, temporary }) {
    this.invocation = invocation;
    this.input = input;
    this.agent = agent;
    this.signal = signal;
    this.temporary = temporary;
    this.child = undefined;
    this.settled = false;
    this.forceKillTimer = undefined;
    this.stdout = [];
    this.stderr = [];
    this.outputBytes = 0;
    this.promise = new Promise((resolvePromise, rejectPromise) => {
      this.resolvePromise = resolvePromise;
      this.rejectPromise = rejectPromise;
    });
  }

  open() {
    const result = spawnProcess(this.invocation);
    if (result.error) this.reject(result.error);
    else this.openChild(result.child);
    return { promise: this.promise, cancel: this.cancel.bind(this) };
  }

  openChild(child) {
    this.child = child;
    this.listen();
    this.writeInput();
  }

  listen() {
    this.child.stdout.on('data', this.receiveStdout.bind(this));
    this.child.stderr.on('data', this.receiveStderr.bind(this));
    this.child.stdin.once('error', this.stdinError.bind(this));
    this.child.once('error', this.reject.bind(this));
    this.child.once('close', this.closeChild.bind(this));
    this.signal?.addEventListener('abort', this.terminate.bind(this), { once: true });
  }

  writeInput() {
    if (this.invocation.input === 'stdin') this.child.stdin.end(this.input);
    else this.child.stdin.end();
  }

  receiveStdout(chunk) {
    this.receiveOutput(this.stdout, chunk);
  }

  receiveStderr(chunk) {
    this.receiveOutput(this.stderr, chunk);
  }

  receiveOutput(chunks, chunk) {
    const nextBytes = this.outputBytes + chunk.length;
    if (nextBytes <= maximumProviderOutputBytes) {
      this.outputBytes = nextBytes;
      chunks.push(chunk);
      return;
    }
    this.terminate();
    this.reject(new Error(`${this.agent} returned too much chat output`));
  }

  stdinError(error) {
    if (error.code !== 'EPIPE') this.reject(error);
  }

  running() {
    return Boolean(this.child) && this.child.exitCode === null;
  }

  sendSignal(signal) {
    try {
      this.child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }

  killChild() {
    if (!this.running()) return;
    this.sendSignal('SIGKILL');
  }

  scheduleForceKill() {
    if (this.forceKillTimer) return;
    this.forceKillTimer = setTimeout(() => {
      this.forceKillTimer = undefined;
      this.killChild();
    }, forcedChildKillDelayMs);
    this.forceKillTimer.unref();
  }

  terminate() {
    if (!this.running()) return;
    if (!this.sendSignal('SIGTERM')) return;
    this.scheduleForceKill();
  }

  clearForceKill() {
    if (!this.forceKillTimer) return;
    clearTimeout(this.forceKillTimer);
    this.forceKillTimer = undefined;
  }

  settle(callback, value) {
    if (this.settled) return;
    this.settled = true;
    this.clearForceKill();
    removeTemporary(this.temporary);
    callback(value);
  }

  resolve(value) {
    this.settle(this.resolvePromise, value);
  }

  reject(error) {
    this.settle(this.rejectPromise, error);
  }

  parseOutput() {
    try {
      this.resolve(parseAgentResponse(this.agent, childOutput(this.stdout)));
    } catch (error) {
      this.reject(error);
    }
  }

  closeChild(status, signal) {
    this.clearForceKill();
    if (this.settled) return;
    const error = closeError(this, status, signal);
    if (error) {
      this.reject(error);
      return;
    }
    this.parseOutput();
  }

  cancel() {
    if (this.settled) return;
    this.terminate();
    this.reject(cancelledError());
  }
}

function providerChild(options) {
  return new ChildExecution(options).open();
}

function trackExecution(executions, execution) {
  executions.add(execution);
  execution.promise.finally(() => executions.delete(execution)).catch(noChange);
  return execution;
}

function runRequest(options, executions, request) {
  const prepared = preparedProviderRequest(options, request);
  const controller = new AbortController();
  const execution = providerChild({
    invocation: prepared.invocation,
    input: JSON.stringify(request),
    agent: options.agent,
    signal: controller.signal,
    temporary: prepared.temporary,
  });
  const tracked = trackExecution(executions, execution);
  return {
    promise: tracked.promise,
    cancel() {
      controller.abort();
      tracked.cancel();
    },
  };
}

function closeExecutions(executions) {
  for (const execution of executions) execution.cancel();
  executions.clear();
}

export function createCodingAgentChatProvider(options = {}) {
  const configured = providerOptions(options);
  const executions = new Set();
  return {
    run(request) {
      return runRequest(configured, executions, request);
    },
    close() {
      closeExecutions(executions);
    },
  };
}
