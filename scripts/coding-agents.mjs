import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
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

export function cursorAuthPaths(
  home,
  {
    env = process.env,
    platform = process.platform,
  } = {},
) {
  if (platform === 'linux') {
    const configHome = env.XDG_CONFIG_HOME ||
      (env.HOME ? resolve(env.HOME, '.config') : undefined);
    return configHome
      ? {
          source: resolve(configHome, 'cursor', 'auth.json'),
          destination: resolve(home, '.config', 'cursor', 'auth.json'),
        }
      : undefined;
  }
  if (platform === 'win32') {
    const roaming = env.APPDATA ||
      (env.USERPROFILE
        ? resolve(env.USERPROFILE, 'AppData', 'Roaming')
        : undefined);
    return roaming
      ? {
          source: resolve(roaming, 'Cursor', 'auth.json'),
          destination: resolve(home, 'AppData', 'Roaming', 'Cursor', 'auth.json'),
        }
      : undefined;
  }
  return undefined;
}

const minimumCursorVersion = [2026, 8, 11];
const cursorBoundarySummary =
  'Cursor needs Ask mode, a read-only sandbox, isolated settings, denied tools, and the hostile boundary canary.';

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

function cursorBoundaryError(detail) {
  return `Cursor review boundary is incompatible: ${detail} ${cursorBoundarySummary} Upgrade Cursor Agent.`;
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
      reason: cursorBoundaryError('The version check failed.'),
    };
  }
  const parts = cursorVersionParts(version);
  if (!parts || !versionAtLeast(parts, minimumCursorVersion)) {
    return {
      compatible: false,
      version,
      reason: cursorBoundaryError(
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
      reason: cursorBoundaryError('The CLI help check failed.'),
    };
  }
  const requiredHelp = [
    ['--mode <mode>', 'Ask mode'],
    ['"ask"', 'Ask mode'],
    ['--sandbox <mode>', 'sandbox control'],
    ['"enabled"', 'sandbox control'],
    ['--workspace <path-or-name>', 'workspace isolation'],
    ['--output-format <format>', 'structured output'],
    ['--model <model>', 'model selection'],
  ];
  const missing = requiredHelp
    .filter(([text]) => !help.includes(text))
    .map(([, label]) => label);
  if (missing.length) {
    return {
      compatible: false,
      version,
      reason: cursorBoundaryError(
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
    skipSafetyChecks = false,
  } = {},
) {
  const path = await findCommand(binary, { env, platform });
  if (!path) return { available: false, installed: false };
  if (agent !== 'cursor') {
    return { available: true, installed: true, path };
  }
  if (skipSafetyChecks) {
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

// fallow-ignore-next-line complexity -- validation and discovery share one public selector.
export async function selectCodingAgent(
  requested,
  available = commandAvailable,
) {
  if (requested) {
    if (!codingAgents.includes(requested)) {
      throw new Error(
        `Unsupported agent "${requested}". Choose ${enabledCodingAgents.join(', ')}.`,
      );
    }
    const result = await available(requested);
    const availableResult = typeof result === 'object'
      ? result.available
      : result;
    if (!availableResult) {
      if (typeof result === 'object' && result.reason) {
        throw new Error(result.reason);
      }
      throw new Error(`Coding agent "${requested}" is not available.`);
    }
    return requested;
  }

  let cursorReason;
  for (const agent of enabledCodingAgents) {
    const result = await available(agent);
    const availableResult = typeof result === 'object'
      ? result.available
      : result;
    if (availableResult) return agent;
    if (agent === 'cursor' && typeof result === 'object') {
      cursorReason = result.reason;
    }
  }
  throw new Error(
    `No coding agent is available. Install one of: ${enabledCodingAgents.join(', ')}.${cursorReason ? ` ${cursorReason}` : ''}`,
  );
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

function parseJsonText(text, agent) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
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
    const parsed = parseCursorStreamResponse(trimmed);
    const toolCall = parsed.events.find((event) => event.type === 'tool_call');
    if (toolCall) {
      throw new Error('Cursor emitted an unexpected tool call');
    }
    return parsed.response;
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
    '--workspace',
    summaryDirectory,
  ];
  if (model) args.push('--model', model);
  args.push(
    `${prompt}\n\nThe snapshot JSON follows this prompt on standard input. Return JSON that matches this schema:\n${JSON.stringify(schema)}`,
  );
  const controlDirectory = join(dirname(summaryDirectory), 'cursor-control');
  const home = join(controlDirectory, 'home');
  const temporary = join(controlDirectory, 'tmp');
  const invocationName = basename(inputPath).replace(/[^A-Za-z0-9.-]/g, '-');
  return {
    command: binary,
    args,
    input: 'stdin',
    cwd: summaryDirectory,
    env: {
      ...summaryEnv,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(home, '.config'),
      CURSOR_CONFIG_DIR: join(controlDirectory, 'config'),
      CURSOR_DATA_DIR: join(controlDirectory, `data-${invocationName}`),
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
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
