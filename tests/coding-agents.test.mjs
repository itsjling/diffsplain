import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  agentCommand,
  agentSupportsReasoning,
  codingAgentAvailability,
  codingAgentCapabilities,
  codingAgentBinary,
  findCommand,
  inspectCursorCompatibility,
  parseAgentResponse,
  parseCursorStreamResponse,
  selectCodingAgent,
  summaryAgentEnvironment,
} from '../scripts/coding-agents.mjs';

test('declares reasoning support for each coding agent', () => {
  const expected = {
    codex: true,
    claude: false,
    copilot: false,
    cursor: false,
    opencode: true,
  };

  assert.deepEqual(
    Object.fromEntries(
      Object.keys(codingAgentCapabilities).map((agent) => [
        agent,
        agentSupportsReasoning(agent),
      ]),
    ),
    expected,
  );
  assert.ok(
    Object.values(codingAgentCapabilities).every(
      (capability) => capability.model,
    ),
  );
});

test('discovers executable providers on the configured path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-provider-'));
  const executable = join(directory, 'summary-agent');
  const plainFile = join(directory, 'plain-file');
  try {
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
    await writeFile(plainFile, 'not executable\n');
    const options = {
      env: { PATH: directory },
      platform: 'linux',
    };
    assert.equal(await findCommand('summary-agent', options), executable);
    assert.equal(await findCommand('plain-file', options), undefined);
    assert.equal(await findCommand('missing-agent', options), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function terminalInput(value = '') {
  const input = new PassThrough();
  input.isTTY = true;
  input.end(value);
  return input;
}

function terminalOutput() {
  const output = new PassThrough();
  output.isTTY = true;
  let text = '';
  output.on('data', (chunk) => {
    text += chunk;
  });
  return { output, text: () => text };
}

test('lists usable agents and uses the selected terminal choice', async () => {
  const checked = [];
  const input = terminalInput('2\n');
  const terminal = terminalOutput();
  const selected = await selectCodingAgent(undefined, {
    available: async (agent) => {
      checked.push(agent);
      return agent === 'claude' || agent === 'cursor';
    },
    input,
    output: terminal.output,
  });

  assert.equal(selected, 'cursor');
  assert.deepEqual(checked, ['codex', 'claude', 'copilot', 'cursor', 'opencode']);
  assert.match(terminal.text(), /1\. claude/);
  assert.match(terminal.text(), /2\. cursor/);
  assert.doesNotMatch(terminal.text(), /codex|copilot|opencode/);
});

test('fails before discovery without an interactive terminal', async () => {
  const checked = [];
  await assert.rejects(
    selectCodingAgent(undefined, {
      available: async (agent) => {
        checked.push(agent);
        return false;
      },
      input: new PassThrough(),
      output: new PassThrough(),
    }),
    (error) => {
      assert.match(error.message, /interactive terminal/i);
      assert.match(error.message, /--agent.*--no-agent/i);
      return true;
    },
  );
  assert.deepEqual(checked, []);
});

test('fails cleanly when terminal input ends before a choice', async () => {
  const terminal = terminalOutput();
  await assert.rejects(
    selectCodingAgent(undefined, {
      available: async () => true,
      input: terminalInput(),
      output: terminal.output,
    }),
    /selection.*cancelled.*--agent.*--no-agent/i,
  );
});

test('treats Ctrl+C as a cancelled terminal choice', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const terminal = terminalOutput();
  const selection = selectCodingAgent(undefined, {
    available: async () => true,
    input,
    output: terminal.output,
  });
  await new Promise((resolve) => setImmediate(resolve));
  input.end('\u0003');

  await assert.rejects(
    selection,
    /selection.*cancelled.*--agent.*--no-agent/i,
  );
});

test('fails when no coding agent is usable', async () => {
  const terminal = terminalOutput();
  await assert.rejects(
    selectCodingAgent(undefined, {
      available: async () => false,
      input: terminalInput(),
      output: terminal.output,
    }),
    (error) => {
      assert.match(error.message, /no coding agent is available/i);
      assert.match(error.message, /--agent.*--no-agent/i);
      return true;
    },
  );
});

test('fails when the requested coding agent is unavailable', async () => {
  await assert.rejects(
    selectCodingAgent('claude', { available: async () => false }),
    /claude.*not available/i,
  );
});

test('validates an explicit agent without opening a picker', async () => {
  const checked = [];
  const output = new PassThrough();
  const selected = await selectCodingAgent('claude', {
    available: async (agent) => {
      checked.push(agent);
      return true;
    },
    input: new PassThrough(),
    output,
  });

  assert.equal(selected, 'claude');
  assert.deepEqual(checked, ['claude']);
  assert.equal(output.read(), null);
});

test('suggests every supported agent for an unknown name', async () => {
  await assert.rejects(
    selectCodingAgent('gemini'),
    (error) => {
      assert.match(error.message, /Choose codex, claude, copilot, cursor, opencode/);
      return true;
    },
  );
});

test('gates Cursor on its version and required flags', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diffsplain-cursor-'));
  const cursor = join(directory, 'cursor-agent');
  try {
    await writeFile(
      cursor,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo 2026.08.11-e8db854; exit 0; fi
if [ "$1" = "--help" ]; then echo '--mode <mode> "ask" --sandbox <mode> "enabled" --workspace <path-or-name> --output-format <format> --model <model> --trust'; exit 0; fi
exit 1
`,
    );
    await chmod(cursor, 0o755);
    assert.equal(inspectCursorCompatibility(cursor).compatible, true);
    assert.equal(
      (await codingAgentAvailability('cursor', { binary: cursor })).available,
      true,
    );

    await writeFile(
      cursor,
      '#!/bin/sh\necho 2025.11.25-d5b3271\n',
    );
    await chmod(cursor, 0o755);
    const old = inspectCursorCompatibility(cursor);
    assert.equal(old.compatible, false);
    assert.match(old.reason, /2026\.08\.11 or newer/);
    assert.equal(
      (await codingAgentAvailability('cursor', { binary: cursor })).available,
      false,
    );
    await assert.rejects(
      selectCodingAgent('cursor', {
        available: async () => ({
          available: false,
          reason: old.reason,
        }),
      }),
      /Upgrade Cursor Agent/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('builds non-interactive commands for each coding agent', () => {
  const common = {
    binary: '/agent',
    model: 'test-model',
    reasoning: 'low',
    prompt: 'Write JSON.',
    schema: { type: 'object' },
    schemaPath: '/tmp/schema.json',
    inputPath: '/tmp/input.json',
    workingDirectory: '/work',
    env: {},
  };

  const codex = agentCommand({ ...common, agent: 'codex' });
  assert.deepEqual(codex.args.slice(0, 2), ['exec', '--ephemeral']);
  assert.ok(codex.args.includes('--output-schema'));
  assert.ok(codex.args.includes('--skip-git-repo-check'));
  assert.ok(codex.args.includes('--ignore-user-config'));
  assert.ok(codex.args.includes('--ignore-rules'));
  assert.ok(!codex.args.includes('agents.enabled=false'));
  assert.ok(codex.args.includes('mcp_servers={}'));
  assert.ok(codex.args.includes('plugins={}'));
  assert.ok(codex.args.includes('sandbox_workspace_write.network_access=false'));
  assert.ok(codex.args.includes('web_search="disabled"'));
  assert.equal(codex.cwd, '/tmp');
  assert.equal(codex.input, 'stdin');

  const claude = agentCommand({ ...common, agent: 'claude' });
  assert.ok(claude.args.includes('--json-schema'));
  assert.ok(claude.args.includes('--no-session-persistence'));
  assert.equal(claude.cwd, '/tmp');
  assert.equal(claude.input, 'stdin');

  const copilot = agentCommand({ ...common, agent: 'copilot' });
  assert.ok(copilot.args.includes('--silent'));
  assert.ok(copilot.args.includes('--no-ask-user'));
  assert.match(copilot.args.at(-1), /@\/tmp\/input\.json/);
  assert.equal(copilot.cwd, '/tmp');

  const cursor = agentCommand({
    ...common,
    agent: 'cursor',
    env: {
      HOME: '/Users/reviewer',
      PATH: '/usr/bin',
      XDG_CONFIG_HOME: '/custom/config',
      APPDATA: '/custom/appdata',
    },
  });
  assert.ok(cursor.args.includes('--print'));
  assert.deepEqual(
    cursor.args.slice(cursor.args.indexOf('--mode'), cursor.args.indexOf('--mode') + 2),
    ['--mode', 'ask'],
  );
  assert.deepEqual(
    cursor.args.slice(cursor.args.indexOf('--sandbox'), cursor.args.indexOf('--sandbox') + 2),
    ['--sandbox', 'enabled'],
  );
  assert.deepEqual(
    cursor.args.slice(cursor.args.indexOf('--output-format'), cursor.args.indexOf('--output-format') + 2),
    ['--output-format', 'stream-json'],
  );
  assert.deepEqual(
    cursor.args.slice(
      cursor.args.indexOf('--workspace'),
      cursor.args.indexOf('--workspace') + 2,
    ),
    ['--workspace', '/tmp'],
  );
  assert.ok(cursor.args.includes('--trust'));
  for (const unsafe of ['--force', '--yolo', '--approve-mcps', '--auto-review']) {
    assert.ok(!cursor.args.includes(unsafe));
  }
  assert.equal(cursor.cwd, '/tmp');
  assert.equal(cursor.input, 'stdin');
  assert.match(cursor.args.at(-1), /Read the snapshot JSON from input\.json/);
  assert.equal(cursor.env.HOME, '/Users/reviewer');
  assert.equal(cursor.env.PATH, '/usr/bin');
  assert.equal(cursor.env.XDG_CONFIG_HOME, '/custom/config');
  assert.equal(cursor.env.APPDATA, '/custom/appdata');
  assert.equal(cursor.env.CURSOR_CONFIG_DIR, undefined);
  assert.equal(cursor.env.AGENT_CLI_CREDENTIAL_STORE, undefined);

  const opencode = agentCommand({ ...common, agent: 'opencode' });
  assert.deepEqual(opencode.args.slice(0, 4), [
    'run',
    '--pure',
    '--format',
    'json',
  ]);
  assert.ok(!opencode.args.includes('--file'));
  assert.ok(opencode.args.includes('--variant'));
  assert.deepEqual(
    opencode.args.slice(
      opencode.args.indexOf('--agent'),
      opencode.args.indexOf('--agent') + 2,
    ),
    ['--agent', 'build'],
  );
  assert.deepEqual(
    opencode.args.slice(
      opencode.args.indexOf('--dir'),
      opencode.args.indexOf('--dir') + 2,
    ),
    ['--dir', '/tmp'],
  );
  assert.equal(opencode.cwd, '/tmp');
  assert.equal(opencode.input, 'stdin');
  assert.equal(opencode.env.OPENCODE_DB, ':memory:');
  assert.equal(
    opencode.env.OPENCODE_CONFIG_CONTENT,
    '{"permission":{"*":"deny"},"agent":{"build":{"permission":{"*":"deny"}}}}',
  );
});

test('passes only runtime variables to product summary agents', () => {
  assert.deepEqual(
    summaryAgentEnvironment({
      API_TOKEN: 'do-not-pass',
      HOME: '/home/reviewer',
      HTTPS_PROXY: 'http://proxy.example.test:8080',
      NODE_EXTRA_CA_CERTS: '/etc/company-ca.pem',
      NO_PROXY: 'localhost,127.0.0.1',
      PATH: '/usr/bin',
      SSL_CERT_FILE: '/etc/ssl/cert.pem',
      TMPDIR: '/tmp',
    }),
    {
      HOME: '/home/reviewer',
      HTTPS_PROXY: 'http://proxy.example.test:8080',
      NODE_EXTRA_CA_CERTS: '/etc/company-ca.pem',
      NO_PROXY: 'localhost,127.0.0.1',
      PATH: '/usr/bin',
      SSL_CERT_FILE: '/etc/ssl/cert.pem',
      TMPDIR: '/tmp',
    },
  );
});

test('reads structured output from each coding agent', () => {
  const response = { change: { title: 'A note' } };
  assert.deepEqual(
    parseAgentResponse('codex', JSON.stringify(response)),
    response,
  );
  assert.deepEqual(
    parseAgentResponse(
      'cursor',
      `${JSON.stringify({ type: 'tool_call', subtype: 'started' })}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(response) })}\n`,
    ),
    response,
  );
  const deniedStream = parseCursorStreamResponse(
    `${JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      tool_call: {
        shellToolCall: {
          result: { permissionDenied: { error: 'denied' } },
        },
      },
    })}\n${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify(response),
    })}\n`,
  );
  assert.deepEqual(deniedStream.response, response);
  assert.equal(deniedStream.events.length, 2);
  assert.deepEqual(
    parseCursorStreamResponse(
      `${JSON.stringify({ type: 'system', subtype: 'init' })}\n${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: `I'll attempt each listed probe once.${JSON.stringify(response)}`,
      })}\n`,
    ).response,
    response,
  );
  assert.deepEqual(
    parseAgentResponse(
      'cursor',
      `${JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        tool_call: {
          readToolCall: {
            args: { path: '/tmp/input.json' },
            result: { success: { content: '{}' } },
          },
        },
      })}\n${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: JSON.stringify(response),
      })}\n`,
    ),
    response,
  );
  assert.deepEqual(
    parseAgentResponse(
      'claude',
      JSON.stringify({ structured_output: response }),
    ),
    response,
  );
  assert.deepEqual(
    parseAgentResponse('copilot', `\`\`\`json\n${JSON.stringify(response)}\n\`\`\``),
    response,
  );
  assert.deepEqual(
    parseAgentResponse(
      'cursor',
      JSON.stringify({
        type: 'result',
        result: `\`\`\`json\n${JSON.stringify(response)}\n\`\`\``,
      }),
    ),
    response,
  );
  assert.deepEqual(
    parseAgentResponse(
      'opencode',
      `${JSON.stringify({
        type: 'text',
        part: { text: JSON.stringify(response) },
      })}\n`,
    ),
    response,
  );
  assert.throws(
    () =>
      parseAgentResponse(
        'opencode',
        `${JSON.stringify({ type: 'step_finish' })}\n`,
      ),
    /OpenCode did not return summary JSON/,
  );
});

test('uses the Cursor Agent binary name and allows an override', () => {
  assert.equal(codingAgentBinary('cursor', { env: {} }), 'cursor-agent');
  assert.equal(
    codingAgentBinary('cursor', {
      env: { CURSOR_BIN: '/custom/cursor-agent' },
    }),
    '/custom/cursor-agent',
  );
});
