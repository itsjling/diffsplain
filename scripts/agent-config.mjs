import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';

function configError(file, detail) {
  return new Error(
    `Diffsplain agent configuration at "${file}" is damaged: ${detail}`,
  );
}

function windowsConfigPath(paths, env, homeDirectory) {
  if (env.APPDATA) {
    return paths.join(env.APPDATA, 'diffsplain', 'config.json');
  }
  const profile = env.USERPROFILE || homeDirectory;
  return paths.join(
    profile,
    'AppData',
    'Roaming',
    'diffsplain',
    'config.json',
  );
}

function unixConfigPath(paths, env, homeDirectory, platform) {
  if (env.XDG_CONFIG_HOME) {
    return paths.join(env.XDG_CONFIG_HOME, 'diffsplain', 'config.json');
  }
  const base = platform === 'darwin'
    ? paths.join(homeDirectory, 'Library', 'Application Support')
    : paths.join(homeDirectory, '.config');
  return paths.join(base, 'diffsplain', 'config.json');
}

export function agentConfigPath({
  env = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
} = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  if (platform === 'win32') {
    return windowsConfigPath(paths, env, homeDirectory);
  }
  return unixConfigPath(paths, env, homeDirectory, platform);
}

function readConfigContents(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(
      `Could not read Diffsplain agent configuration at "${file}": ${error.message}`,
    );
  }
}

function parseConfigContents(file, contents) {
  try {
    return JSON.parse(contents);
  } catch {
    throw configError(file, 'the file is not valid JSON.');
  }
}

function assertConfigRecord(file, parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configError(file, 'the top-level value must be a JSON object.');
  }
}

function assertAgentValue(file, parsed) {
  if (!Object.hasOwn(parsed, 'agent')) return;
  if (typeof parsed.agent !== 'string') {
    throw configError(file, '"agent" must be a string.');
  }
}

function readConfigRecord(file) {
  const contents = readConfigContents(file);
  if (contents === undefined) return undefined;
  const parsed = parseConfigContents(file, contents);
  assertConfigRecord(file, parsed);
  assertAgentValue(file, parsed);
  return parsed;
}

export function readConfiguredAgent({
  file = agentConfigPath(),
} = {}) {
  return readConfigRecord(file)?.agent;
}

function discardFile(file) {
  try {
    rmSync(file, { force: true });
  } catch {
    return;
  }
}

function moveExistingConfig(file, backup) {
  if (!existsSync(file)) return false;
  renameSync(file, backup);
  return true;
}

function restoreConfigFile(file, backup, movedExisting, originalError) {
  if (!movedExisting) return;
  if (existsSync(file)) return;
  try {
    renameSync(backup, file);
  } catch (restoreError) {
    originalError.cause = restoreError;
  }
}

function replaceConfigFile(file, record) {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const suffix = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const temporary = `${file}.${suffix}.tmp`;
  const backup = `${file}.${suffix}.bak`;
  let movedExisting = false;

  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    movedExisting = moveExistingConfig(file, backup);
    renameSync(temporary, file);
  } catch (error) {
    discardFile(temporary);
    restoreConfigFile(file, backup, movedExisting, error);
    throw error;
  }
  discardFile(backup);
}

function showAgentConfig(_operation, current) {
  return { kind: 'show', agent: current?.agent };
}

function setAgentConfig(operation, current, file) {
  replaceConfigFile(file, { ...(current || {}), agent: operation.agent });
  return { kind: 'set', agent: operation.agent };
}

function unsetAgentConfig(_operation, current, file) {
  if (!current) return { kind: 'unset' };
  if (!Object.hasOwn(current, 'agent')) return { kind: 'unset' };
  const next = { ...current };
  delete next.agent;
  replaceConfigFile(file, next);
  return { kind: 'unset' };
}

const CONFIG_OPERATIONS = {
  set: setAgentConfig,
  show: showAgentConfig,
  unset: unsetAgentConfig,
};

export function applyAgentConfigOperation(
  operation,
  { file = agentConfigPath() } = {},
) {
  const current = readConfigRecord(file);
  const applyOperation = CONFIG_OPERATIONS[operation.kind];
  if (!applyOperation) {
    throw new Error(`Unknown agent configuration operation: ${operation.kind}`);
  }
  return applyOperation(operation, current, file);
}
