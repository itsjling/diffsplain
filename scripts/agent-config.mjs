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

export function agentConfigPath({
  env = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
} = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  if (platform === 'win32') {
    const base = env.APPDATA || (env.USERPROFILE
      ? paths.join(env.USERPROFILE, 'AppData', 'Roaming')
      : paths.join(homeDirectory, 'AppData', 'Roaming'));
    return paths.join(base, 'diffsplain', 'config.json');
  }

  if (env.XDG_CONFIG_HOME) {
    return paths.join(env.XDG_CONFIG_HOME, 'diffsplain', 'config.json');
  }

  if (platform === 'darwin') {
    return paths.join(
      homeDirectory,
      'Library',
      'Application Support',
      'diffsplain',
      'config.json',
    );
  }

  return paths.join(homeDirectory, '.config', 'diffsplain', 'config.json');
}

function readConfigRecord(file) {
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(
      `Could not read Diffsplain agent configuration at "${file}": ${error.message}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw configError(file, 'the file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configError(file, 'the top-level value must be a JSON object.');
  }
  if (
    Object.hasOwn(parsed, 'agent') &&
    typeof parsed.agent !== 'string'
  ) {
    throw configError(file, '"agent" must be a string.');
  }
  return parsed;
}

export function readConfiguredAgent({
  file = agentConfigPath(),
} = {}) {
  return readConfigRecord(file)?.agent;
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
    if (existsSync(file)) {
      renameSync(file, backup);
      movedExisting = true;
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (movedExisting && !existsSync(file)) {
      try {
        renameSync(backup, file);
      } catch (restoreError) {
        error.cause = restoreError;
      }
    }
    throw error;
  }
  if (movedExisting) {
    try {
      rmSync(backup, { force: true });
    } catch {
      return;
    }
  }
}

export function applyAgentConfigOperation(
  operation,
  { file = agentConfigPath() } = {},
) {
  const current = readConfigRecord(file);
  if (operation.kind === 'show') {
    return { kind: 'show', agent: current?.agent };
  }

  if (operation.kind === 'set') {
    replaceConfigFile(file, { ...(current || {}), agent: operation.agent });
    return { kind: 'set', agent: operation.agent };
  }

  if (operation.kind === 'unset') {
    if (!current || !Object.hasOwn(current, 'agent')) {
      return { kind: 'unset' };
    }
    const next = { ...current };
    delete next.agent;
    replaceConfigFile(file, next);
    return { kind: 'unset' };
  }

  throw new Error(`Unknown agent configuration operation: ${operation.kind}`);
}
