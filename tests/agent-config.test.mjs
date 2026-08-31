import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  agentConfigPath,
  applyAgentConfigOperation,
  readConfiguredAgent,
} from '../scripts/agent-config.mjs';

test('uses deterministic standard per-user paths on each platform', () => {
  assert.equal(
    agentConfigPath({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/state/config', HOME: '/home/reviewer' },
    }),
    '/state/config/diffsplain/config.json',
  );
  assert.equal(
    agentConfigPath({
      platform: 'linux',
      env: {},
      homeDirectory: '/home/reviewer',
    }),
    '/home/reviewer/.config/diffsplain/config.json',
  );
  assert.equal(
    agentConfigPath({
      platform: 'darwin',
      env: {},
      homeDirectory: '/Users/reviewer',
    }),
    '/Users/reviewer/Library/Application Support/diffsplain/config.json',
  );
  assert.equal(
    agentConfigPath({
      platform: 'darwin',
      env: { XDG_CONFIG_HOME: '/state/config' },
      homeDirectory: '/Users/reviewer',
    }),
    '/state/config/diffsplain/config.json',
  );
  assert.equal(
    agentConfigPath({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\reviewer\\AppData\\Roaming' },
    }),
    'C:\\Users\\reviewer\\AppData\\Roaming\\diffsplain\\config.json',
  );
  assert.equal(
    agentConfigPath({
      platform: 'win32',
      env: {},
      homeDirectory: 'C:\\Users\\reviewer',
    }),
    'C:\\Users\\reviewer\\AppData\\Roaming\\diffsplain\\config.json',
  );
});

test('sets, shows, replaces, and idempotently unsets the agent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-config-'));
  const file = join(directory, 'nested', 'config.json');
  try {
    assert.deepEqual(applyAgentConfigOperation({ kind: 'show' }, { file }), {
      kind: 'show',
      agent: undefined,
    });
    assert.deepEqual(
      applyAgentConfigOperation({ kind: 'set', agent: 'codex' }, { file }),
      { kind: 'set', agent: 'codex' },
    );
    assert.equal(readConfiguredAgent({ file }), 'codex');
    applyAgentConfigOperation({ kind: 'set', agent: 'claude' }, { file });
    assert.equal(readConfiguredAgent({ file }), 'claude');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'nested'))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(join(directory, 'nested')), ['config.json']);
    assert.deepEqual(
      applyAgentConfigOperation({ kind: 'unset' }, { file }),
      { kind: 'unset' },
    );
    assert.equal(readConfiguredAgent({ file }), undefined);
    assert.deepEqual(
      applyAgentConfigOperation({ kind: 'unset' }, { file }),
      { kind: 'unset' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves unrelated JSON keys when setting and unsetting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-config-'));
  const file = join(directory, 'config.json');
  try {
    await writeFile(file, JSON.stringify({ future: { enabled: true } }));
    applyAgentConfigOperation({ kind: 'set', agent: 'opencode' }, { file });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
      future: { enabled: true },
      agent: 'opencode',
    });
    applyAgentConfigOperation({ kind: 'unset' }, { file });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
      future: { enabled: true },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects corrupt config instead of replacing or ignoring it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-config-'));
  const file = join(directory, 'config.json');
  try {
    for (const contents of ['{', '[]', '{"agent":42}']) {
      await writeFile(file, contents);
      const damaged = new RegExp(
        `configuration at .*${file.split('/').at(-1)}.* is damaged`,
        'i',
      );
      assert.throws(
        () => readConfiguredAgent({ file }),
        damaged,
      );
      assert.throws(
        () => applyAgentConfigOperation(
          { kind: 'set', agent: 'codex' },
          { file },
        ),
        damaged,
      );
      assert.equal(await readFile(file, 'utf8'), contents);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
