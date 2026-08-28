import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
} from 'node:path';

export const codingAgentCapabilities = {
  codex: { binary: 'codex', model: true, reasoning: true },
  claude: { binary: 'claude', model: true, reasoning: false },
  copilot: { binary: 'copilot', model: true, reasoning: false },
  cursor: { binary: 'cursor-agent', model: true, reasoning: false },
  opencode: { binary: 'opencode', model: true, reasoning: true },
};

export const codingAgents = Object.keys(codingAgentCapabilities);

export function agentSupportsReasoning(agent) {
  return codingAgentCapabilities[agent]?.reasoning === true;
}

export function assertReasoningSupported(agent, reasoning) {
  if (reasoning && !agentSupportsReasoning(agent)) {
    throw new Error(
      `--reasoning is supported only by codex and opencode; ${agent} does not support it.`,
    );
  }
}

const summaryEnvironmentNames = [
  'CODEX_HOME',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'SSL_CERT_FILE',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
];

export function summaryAgentEnvironment(env = process.env) {
  return Object.fromEntries(
    summaryEnvironmentNames
      .filter((name) => typeof env[name] === 'string')
      .map((name) => [name, env[name]]),
  );
}

const minimumCursorVersion = [2026, 8, 11];
const cursorRequirementSummary =
  'Cursor needs version 2026.08.11 or newer with Ask mode, --sandbox, --trust, and --workspace.';

export const enabledCodingAgents = codingAgents;

function firstLine(value) {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
}

function cursorVersionParts(version) {
  const match = version?.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-|$)/);
  return match?.slice(1).map(Number);
}

function versionAtLeast(current, minimum) {
  for (const [index, part] of current.entries()) {
    if (part !== minimum[index]) return part > minimum[index];
  }
  return true;
}

function cursorCompatibilityError(detail) {
  return `Cursor Agent is incompatible: ${detail} ${cursorRequirementSummary} Upgrade Cursor Agent.`;
}

export function inspectCursorCompatibility(
  command,
  {
    env = process.env,
    timeout = 5_000,
  } = {},
) {
  const run = (args) => spawnSync(command, args, {
    encoding: 'utf8',
    env,
    timeout,
    windowsHide: true,
  });
  const versionResult = run(['--version']);
  const version = firstLine(
    `${versionResult.stdout || ''}\n${versionResult.stderr || ''}`,
  );
  if (versionResult.error || versionResult.status !== 0 || !version) {
    return {
      compatible: false,
      version,
      reason: cursorCompatibilityError('The version check failed.'),
    };
  }
  const parts = cursorVersionParts(version);
  if (!parts || !versionAtLeast(parts, minimumCursorVersion)) {
    return {
      compatible: false,
      version,
      reason: cursorCompatibilityError(
        `Found ${version}; version 2026.08.11 or newer is required.`,
      ),
    };
  }
  const helpResult = run(['--help']);
  const help = `${helpResult.stdout || ''}\n${helpResult.stderr || ''}`;
  if (helpResult.error || helpResult.status !== 0) {
    return {
      compatible: false,
      version,
      reason: cursorCompatibilityError('The CLI help check failed.'),
    };
  }
  const requiredHelp = [
    ['--mode <mode>', 'Ask mode'],
    ['"ask"', 'Ask mode'],
    ['--sandbox <mode>', 'sandbox control'],
    ['"enabled"', 'sandbox control'],
    ['--workspace <path-or-name>', 'workspace selection'],
    ['--output-format <format>', 'structured output'],
    ['--model <model>', 'model selection'],
    ['--trust', 'workspace trust control'],
  ];
  const missing = requiredHelp
    .filter(([text]) => !help.includes(text))
    .map(([, label]) => label);
  if (missing.length) {
    return {
      compatible: false,
      version,
      reason: cursorCompatibilityError(
        `The CLI lacks ${[...new Set(missing)].join(', ')}.`,
      ),
    };
  }
  return { compatible: true, version };
}

async function executable(path) {
  try {
    await access(
      path,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function commandExtensions(platform, env) {
  return platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
}

async function findOnPath(command, env, platform) {
  const extensions =
    commandExtensions(platform, env);
  const directories = (env.PATH || '').split(delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      if (await executable(join(directory, `${command}${extension}`))) {
        return join(directory, `${command}${extension}`);
      }
    }
  }
  return undefined;
}

export async function findCommand(
  command,
  {
    env = process.env,
    platform = process.platform,
  } = {},
) {
  const direct =
    isAbsolute(command) ||
    command.includes('/') ||
    command.includes('\\');
  if (direct) return (await executable(command)) ? command : undefined;
  return findOnPath(command, env, platform);
}

export async function commandAvailable(command, options) {
  return Boolean(await findCommand(command, options));
}

export async function codingAgentAvailability(
  agent,
  {
    binary = codingAgentBinary(agent),
    env = process.env,
    platform = process.platform,
  } = {},
) {
  const path = await findCommand(binary, { env, platform });
  if (!path) return { available: false, installed: false };
  if (agent !== 'cursor') {
    return { available: true, installed: true, path };
  }
  const inspection = inspectCursorCompatibility(path, { env });
  return {
    available: inspection.compatible,
    installed: true,
    path,
    version: inspection.version,
    reason: inspection.reason,
  };
}

function availableResult(result) {
  return typeof result === 'object' ? result.available : result;
}

function unavailableAgentError(requested, result) {
  if (typeof result === 'object' && result.reason) {
    return new Error(result.reason);
  }
  return new Error(`Coding agent "${requested}" is not available.`);
}

function noAvailableAgentError(cursorReason) {
  return new Error(
    `No coding agent is available. Install one of: ${enabledCodingAgents.join(', ')}. Pass --agent NAME to choose an agent or --no-agent for a plain review.${cursorReason ? ` ${cursorReason}` : ''}`,
  );
}

function selectionCancelledError() {
  return new Error(
    'Agent selection was cancelled. Pass --agent NAME to choose an agent or --no-agent for a plain review.',
  );
}

function nonInteractiveSelectionError() {
  return new Error(
    'An interactive terminal is required to choose a coding agent. Pass --agent NAME to choose an agent or --no-agent for a plain review.',
  );
}

async function selectRequestedCodingAgent(requested, available) {
  if (!codingAgents.includes(requested)) {
    throw new Error(
      `Unsupported agent "${requested}". Choose ${enabledCodingAgents.join(', ')}.`,
    );
  }
  const result = await available(requested);
  if (!availableResult(result)) {
    throw unavailableAgentError(requested, result);
  }
  return requested;
}

async function usableCodingAgents(available) {
  const usable = [];
  let cursorReason;
  for (const agent of enabledCodingAgents) {
    const result = await available(agent);
    if (availableResult(result)) {
      usable.push(agent);
    } else if (agent === 'cursor' && typeof result === 'object') {
      cursorReason = result.reason;
    }
  }
  return { usable, cursorReason };
}

function selectFromTerminal(agents, { input, output }) {
  output.write('Choose a coding agent:\n');
  for (const [index, agent] of agents.entries()) {
    output.write(`${index + 1}. ${agent}\n`);
  }
  output.write('Enter a number, or press Ctrl+C to cancel: ');

  return new Promise((resolve, reject) => {
    const picker = createInterface({ input, output, terminal: true });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      picker.close();
      callback(value);
    };
    const promptAgain = () => {
      output.write(`Choose a number from 1 to ${agents.length}, or press Ctrl+C to cancel: `);
    };
    picker.on('SIGINT', () => {
      finish(reject, selectionCancelledError());
    });
    picker.on('close', () => {
      finish(reject, selectionCancelledError());
    });
    picker.on('line', (line) => {
      const selected = Number(line.trim());
      if (
        !Number.isInteger(selected) ||
        selected < 1 ||
        selected > agents.length
      ) {
        promptAgain();
        return;
      }
      finish(resolve, agents[selected - 1]);
    });
  });
}

export async function selectCodingAgent(
  requested,
  {
    available = commandAvailable,
    input = process.stdin,
    output = process.stderr,
  } = {},
) {
  if (requested) {
    return selectRequestedCodingAgent(requested, available);
  }

  if (!input?.isTTY || !output?.isTTY) {
    throw nonInteractiveSelectionError();
  }
  const { usable, cursorReason } = await usableCodingAgents(available);
  if (!usable.length) throw noAvailableAgentError(cursorReason);
  return selectFromTerminal(usable, { input, output });
}

// fallow-ignore-next-line complexity -- each supported agent has one override rule.
export function codingAgentBinary(
  agent,
  {
    codexBin,
    env = process.env,
  } = {},
) {
  if (agent === 'codex') return codexBin || env.CODEX_BIN || agent;
  if (agent === 'cursor') {
    return env.CURSOR_BIN || codingAgentCapabilities.cursor.binary;
  }
  return (
    env[`${agent.toUpperCase()}_BIN`] ||
    codingAgentCapabilities[agent]?.binary ||
    agent
  );
}

function extractJsonValue(text) {
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const opening = text[start];
  const closing = opening === '{' ? '}' : ']';
  const end = text.lastIndexOf(closing);
  if (end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function parseJsonText(text, agent) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const extracted = extractJsonValue(candidate);
    if (extracted !== undefined) return extracted;
    throw new Error(`${agent} did not return valid summary JSON`);
  }
}

function parseClaudeResponse(stdout) {
  const envelope = parseJsonText(stdout, 'Claude');
  if (envelope?.structured_output) return envelope.structured_output;
  if (typeof envelope?.result === 'string') {
    return parseJsonText(envelope.result, 'Claude');
  }
  return envelope;
}

function parseEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function parseOpenCodeResponse(stdout) {
  const parts = stdout
    .split('\n')
    .filter(Boolean)
    .map(parseEvent)
    .filter((event) => event?.type === 'text' && event.part?.text)
    .map((event) => event.part.text);
  if (!parts.length) throw new Error('OpenCode did not return summary JSON');
  return parseJsonText(parts.join(''), 'OpenCode');
}

export function parseCursorStreamResponse(stdout) {
  const trimmed = stdout.trim();
  const lines = trimmed.split('\n').filter(Boolean);
  const events = lines.map(parseEvent);
  if (!lines.length || !events.every(Boolean)) {
    throw new Error('Cursor did not return a valid event stream');
  }
  const envelope = [...events]
    .reverse()
    .find((event) => event.type === 'result');
  if (!envelope || envelope.subtype !== 'success' || envelope.is_error) {
    throw new Error('Cursor did not return a successful result');
  }
  if (typeof envelope.result !== 'string') {
    throw new Error('Cursor did not return summary JSON');
  }
  return {
    events,
    response: parseJsonText(envelope.result, 'Cursor'),
  };
}

function parseCursorResponse(stdout) {
  const trimmed = stdout.trim();
  const lines = trimmed.split('\n').filter(Boolean);
  if (lines.length > 1) {
    return parseCursorStreamResponse(trimmed).response;
  }
  const envelope = parseJsonText(trimmed, 'Cursor');
  if (typeof envelope?.result === 'string') {
    return parseJsonText(envelope.result, 'Cursor');
  }
  return envelope;
}

export function parseAgentResponse(agent, stdout) {
  if (agent === 'claude') return parseClaudeResponse(stdout);
  if (agent === 'opencode') return parseOpenCodeResponse(stdout);
  if (agent === 'cursor') return parseCursorResponse(stdout);
  const label = agent === 'copilot' ? 'Copilot' : 'Codex';
  return parseJsonText(stdout, label);
}

function codexCommand({
  binary,
  model,
  reasoning,
  prompt,
  schemaPath,
  summaryDirectory,
  summaryEnv,
}) {
  const args = [
    'exec',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--ignore-user-config',
    '--ignore-rules',
    '--color',
    'never',
    '--skip-git-repo-check',
    '-C',
    summaryDirectory,
    '--output-schema',
    schemaPath,
    '--config',
    'mcp_servers={}',
    '--config',
    'plugins={}',
    '--config',
    'shell_environment_policy.inherit="none"',
    '--config',
    'sandbox_workspace_write.network_access=false',
    '--config',
    'web_search="disabled"',
  ];
  if (model) args.push('--model', model);
  if (reasoning) {
    args.push(
      '--config',
      `model_reasoning_effort=${JSON.stringify(reasoning)}`,
    );
  }
  args.push(prompt);
  return {
    command: binary,
    args,
    input: 'stdin',
    cwd: summaryDirectory,
    env: summaryEnv,
  };
}

function claudeCommand({
  binary,
  model,
  prompt,
  schema,
  summaryDirectory,
  summaryEnv,
}) {
  const args = [
    '--print',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--tools',
    '',
    '--no-session-persistence',
  ];
  if (model) args.push('--model', model);
  args.push(prompt);
  return {
    command: binary,
    args,
    input: 'stdin',
    cwd: summaryDirectory,
    env: summaryEnv,
  };
}

function copilotCommand({
  binary,
  inputPath,
  model,
  prompt,
  schema,
  summaryDirectory,
  summaryEnv,
}) {
  const schemaText = JSON.stringify(schema);
  const args = [
    '--silent',
    '--no-ask-user',
    '--no-color',
    '--no-custom-instructions',
    '--no-remote',
    '--no-remote-export',
    `--add-dir=${dirname(inputPath)}`,
  ];
  if (model) args.push('--model', model);
  args.push(
    '--prompt',
    `${prompt}\n\nRead the snapshot from @${inputPath}. Return JSON that matches this schema:\n${schemaText}`,
  );
  return {
    command: binary,
    args,
    input: 'none',
    cwd: summaryDirectory,
    env: summaryEnv,
  };
}

function openCodeCommand({
  binary,
  model,
  reasoning,
  prompt,
  schema,
  summaryDirectory,
  summaryEnv,
}) {
  const args = [
    'run',
    '--pure',
    '--format',
    'json',
    '--dir',
    summaryDirectory,
    '--agent',
    'build',
  ];
  if (model) args.push('--model', model);
  if (reasoning) args.push('--variant', reasoning);
  args.push(
    `${prompt}\n\nThe snapshot JSON follows this prompt on standard input. Return JSON that matches this schema:\n${JSON.stringify(schema)}`,
  );
  return {
    command: binary,
    args,
    input: 'stdin',
    cwd: summaryDirectory,
    env: {
      ...summaryEnv,
      OPENCODE_DB: ':memory:',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { '*': 'deny' },
        agent: {
          build: {
            permission: { '*': 'deny' },
          },
        },
      }),
    },
  };
}

function cursorCommand({
  binary,
  inputPath,
  model,
  prompt,
  schema,
  summaryDirectory,
  summaryEnv,
  sourceEnv,
}) {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--mode',
    'ask',
    '--sandbox',
    'enabled',
    '--trust',
    '--workspace',
    summaryDirectory,
  ];
  if (model) args.push('--model', model);
  args.push(
    `${prompt}\n\nRead the snapshot JSON from ${basename(inputPath)} in this workspace. Return JSON that matches this schema:\n${JSON.stringify(schema)}`,
  );
  return {
    command: binary,
    args,
    input: 'stdin',
    cwd: summaryDirectory,
    env: {
      ...summaryEnv,
      ...(sourceEnv.XDG_CONFIG_HOME
        ? { XDG_CONFIG_HOME: sourceEnv.XDG_CONFIG_HOME }
        : {}),
      ...(sourceEnv.APPDATA ? { APPDATA: sourceEnv.APPDATA } : {}),
      ...(sourceEnv.CURSOR_API_KEY
        ? { CURSOR_API_KEY: sourceEnv.CURSOR_API_KEY }
        : {}),
      ...(sourceEnv.CURSOR_AUTH_TOKEN
        ? { CURSOR_AUTH_TOKEN: sourceEnv.CURSOR_AUTH_TOKEN }
        : {}),
    },
  };
}

export function agentCommand({
  agent,
  binary = agent,
  model,
  reasoning,
  prompt,
  schema,
  schemaPath,
  inputPath,
  env = process.env,
}) {
  const options = {
    binary,
    inputPath,
    model,
    prompt,
    reasoning,
    schema,
    schemaPath,
    summaryDirectory: dirname(inputPath),
    summaryEnv: summaryAgentEnvironment(env),
    sourceEnv: env,
  };
  if (agent === 'codex') return codexCommand(options);
  if (agent === 'claude') return claudeCommand(options);
  if (agent === 'copilot') return copilotCommand(options);
  if (agent === 'cursor') return cursorCommand(options);
  return openCodeCommand(options);
}
