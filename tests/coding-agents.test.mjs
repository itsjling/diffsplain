import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  agentCommand,
  agentReadOnlyWarning,
  agentSupportsFast,
  agentSupportsReasoning,
  assertFastCompatible,
  codingAgentAvailability,
  codingAgentCapabilities,
  codingAgentBinary,
  findCommand,
  inspectCursorCompatibility,
  inspectFastCompatibility,
  parseAgentResponse,
  parseAgentUsage,
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

test('declares Fast mode support only for Codex and Claude', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(codingAgentCapabilities).map((agent) => [
        agent,
        agentSupportsFast(agent),
      ]),
    ),
    {
      codex: true,
      claude: true,
      copilot: false,
      cursor: false,
      opencode: false,
    },
  );
});

test('checks provider versions before enabling Fast mode', () => {
  const runVersion = (version) => () => ({
    status: 0,
    stdout: `${version}\n`,
    stderr: '',
  });

  assert.equal(
    inspectFastCompatibility('codex', '/codex', {
      run: runVersion('codex-cli 0.108.0'),
    }).compatible,
    true,
  );
  assert.match(
    inspectFastCompatibility('codex', '/codex', {
      run: runVersion('codex-cli 0.107.0'),
    }).reason,
    /Codex CLI 0\.108\.0 or newer.*found codex-cli 0\.107\.0/i,
  );
  assert.equal(
    inspectFastCompatibility('claude', '/claude', {
      run: runVersion('2.1.36 (Claude Code)'),
    }).compatible,
    true,
  );
  assert.match(
    inspectFastCompatibility('claude', '/claude', {
      run: runVersion('2.1.35 (Claude Code)'),
    }).reason,
    /Claude Code 2\.1\.36 or newer.*found 2\.1\.35/i,
  );
  assert.throws(
    () => assertFastCompatible('copilot', '/copilot', true),
    /--fast is supported only by codex and claude.*copilot/i,
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
    configuredAgent: () => undefined,
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
      configuredAgent: () => undefined,
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
      configuredAgent: () => undefined,
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
    configuredAgent: () => undefined,
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
      configuredAgent: () => undefined,
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
    configuredAgent: () => {
      throw new Error('must not read configuration');
    },
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

test('uses a configured agent without discovery or a terminal', async () => {
  const checked = [];
  const selected = await selectCodingAgent(undefined, {
    configuredAgent: () => 'opencode',
    available: async (agent) => {
      checked.push(agent);
      return true;
    },
    input: new PassThrough(),
    output: new PassThrough(),
  });

  assert.equal(selected, 'opencode');
  assert.deepEqual(checked, ['opencode']);
});

test('does not fall back from unsupported or unavailable configured agents', async () => {
  const unsupportedChecks = [];
  await assert.rejects(
    selectCodingAgent(undefined, {
      configuredAgent: () => 'gemini',
      available: async (agent) => {
        unsupportedChecks.push(agent);
        return true;
      },
    }),
    /configured coding agent "gemini" is unsupported/i,
  );
  assert.deepEqual(unsupportedChecks, []);

  const unavailableChecks = [];
  await assert.rejects(
    selectCodingAgent(undefined, {
      configuredAgent: () => 'claude',
      available: async (agent) => {
        unavailableChecks.push(agent);
        return false;
      },
    }),
    /configured coding agent "claude" is not available/i,
  );
  assert.deepEqual(unavailableChecks, ['claude']);
});

test('surfaces damaged configuration before discovery', async () => {
  const checked = [];
  await assert.rejects(
    selectCodingAgent(undefined, {
      configuredAgent: () => {
        throw new Error('Diffsplain agent configuration is damaged');
      },
      available: async (agent) => {
        checked.push(agent);
        return true;
      },
    }),
    /configuration is damaged/i,
  );
  assert.deepEqual(checked, []);
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

test('builds exact snapshot-only plans for each coding agent', () => {
  const environment = {
    HOME: '/Users/reviewer',
    PATH: '/usr/bin',
    XDG_CONFIG_HOME: '/custom/config',
    APPDATA: '/custom/appdata',
    PRIVATE_AGENT_TOKEN: 'must-not-pass',
  };
  const common = {
    binary: '/agent',
    model: 'test-model',
    reasoning: 'low',
    prompt: 'Write JSON.',
    schema: { type: 'object' },
    schemaPath: '/tmp/schema.json',
    inputPath: '/tmp/input.json',
    accessMode: { mode: 'snapshot-only', reason: 'target-mismatch' },
    env: environment,
  };
  const snapshotEnvironment = { HOME: '/Users/reviewer', PATH: '/usr/bin' };

  assert.deepEqual(agentCommand({ ...common, agent: 'codex' }), {
    command: '/agent',
    args: [
      'exec', '--ephemeral', '--json', '--sandbox', 'read-only',
      '--ignore-user-config', '--ignore-rules', '--color', 'never',
      '--skip-git-repo-check', '-C', '/tmp', '--output-schema',
      '/tmp/schema.json', '--config', 'mcp_servers={}', '--config',
      'plugins={}', '--config', 'shell_environment_policy.inherit="none"',
      '--config', 'sandbox_workspace_write.network_access=false', '--config',
      'web_search="disabled"', '--model', 'test-model', '--config',
      'model_reasoning_effort="low"', 'Write JSON.',
    ],
    input: 'stdin',
    cwd: '/tmp',
    env: snapshotEnvironment,
  });
  assert.deepEqual(agentCommand({ ...common, agent: 'claude' }), {
    command: '/agent',
    args: [
      '--print', '--output-format', 'json', '--json-schema',
      '{"type":"object"}', '--tools', '', '--no-session-persistence',
      '--model', 'test-model', 'Write JSON.',
    ],
    input: 'stdin',
    cwd: '/tmp',
    env: snapshotEnvironment,
  });
  assert.deepEqual(agentCommand({ ...common, agent: 'copilot' }), {
    command: '/agent',
    args: [
      '--silent', '--no-ask-user', '--no-color', '--no-custom-instructions',
      '--no-remote', '--no-remote-export', '--add-dir=/tmp', '--model',
      'test-model', '--prompt',
      'Write JSON.\n\nRead the snapshot from @/tmp/input.json. Return JSON that matches this schema:\n{"type":"object"}',
    ],
    input: 'none',
    cwd: '/tmp',
    env: snapshotEnvironment,
  });
  assert.deepEqual(agentCommand({ ...common, agent: 'cursor' }), {
    command: '/agent',
    args: [
      '--print', '--output-format', 'stream-json', '--mode', 'ask',
      '--sandbox', 'enabled', '--trust', '--workspace', '/tmp', '--model',
      'test-model',
      'Write JSON.\n\nThe snapshot JSON follows this prompt on standard input. Return JSON that matches this schema:\n{"type":"object"}',
    ],
    input: 'stdin',
    cwd: '/tmp',
    env: {
      ...snapshotEnvironment,
      XDG_CONFIG_HOME: '/custom/config',
      APPDATA: '/custom/appdata',
    },
  });
  assert.deepEqual(agentCommand({ ...common, agent: 'opencode' }), {
    command: '/agent',
    args: [
      'run', '--pure', '--format', 'json', '--dir', '/tmp', '--agent',
      'build', '--model', 'test-model', '--variant', 'low',
      'Write JSON.\n\nThe snapshot JSON follows this prompt on standard input. Return JSON that matches this schema:\n{"type":"object"}',
    ],
    input: 'stdin',
    cwd: '/tmp',
    env: {
      ...snapshotEnvironment,
      OPENCODE_DB: ':memory:',
      OPENCODE_CONFIG_CONTENT:
        '{"permission":{"*":"deny"},"agent":{"build":{"permission":{"*":"deny"}}}}',
    },
  });
});

test('builds checkout-read-only provider plans with the real repo and normal environment', () => {
  const environment = {
    HOME: '/Users/reviewer',
    PATH: '/usr/bin',
    PRIVATE_AGENT_TOKEN: 'available-to-the-user-agent',
  };
  const common = {
    binary: '/agent',
    model: 'test-model',
    reasoning: 'low',
    prompt: 'Write JSON.',
    schema: { type: 'object' },
    schemaPath: '/tmp/diffsplain-agent/schema.json',
    inputPath: '/tmp/diffsplain-agent/input.json',
    accessMode: { mode: 'checkout-read-only', root: '/work/repo' },
    env: environment,
  };

  const codex = agentCommand({ ...common, agent: 'codex' });
  assert.deepEqual(codex, {
    command: '/agent',
    args: [
      'exec',
      '--ephemeral',
      '--json',
      '--sandbox',
      'read-only',
      '--color',
      'never',
      '-C',
      '/work/repo',
      '--output-schema',
      '/tmp/diffsplain-agent/schema.json',
      '--model',
      'test-model',
      '--config',
      'model_reasoning_effort="low"',
      'Write JSON.',
    ],
    input: 'stdin',
    cwd: '/work/repo',
    env: environment,
  });

  const claude = agentCommand({ ...common, agent: 'claude' });
  assert.deepEqual(claude, {
    command: '/agent',
    args: [
      '--print',
      '--output-format',
      'json',
      '--json-schema',
      '{"type":"object"}',
      '--permission-mode',
      'plan',
      '--no-session-persistence',
      '--model',
      'test-model',
      'Write JSON.',
    ],
    input: 'stdin',
    cwd: '/work/repo',
    env: environment,
  });

  const copilot = agentCommand({ ...common, agent: 'copilot' });
  assert.deepEqual(copilot, {
    command: '/agent',
    args: [
      '--silent', '--no-color', '--no-remote', '--no-remote-export',
      '--add-dir=/tmp/diffsplain-agent', '--model', 'test-model', '--prompt',
      'Write JSON.\n\nRead the snapshot from @/tmp/diffsplain-agent/input.json. Return JSON that matches this schema:\n{"type":"object"}',
    ],
    input: 'none',
    cwd: '/work/repo',
    env: environment,
  });

  const cursor = agentCommand({ ...common, agent: 'cursor' });
  assert.deepEqual(cursor, {
    command: '/agent',
    args: [
      '--print', '--output-format', 'stream-json', '--mode', 'ask',
      '--sandbox', 'enabled', '--trust', '--workspace', '/work/repo',
      '--model', 'test-model',
      'Write JSON.\n\nThe snapshot JSON follows this prompt on standard input. Return JSON that matches this schema:\n{"type":"object"}',
    ],
    input: 'stdin',
    cwd: '/work/repo',
    env: environment,
  });

  const opencode = agentCommand({ ...common, agent: 'opencode' });
  assert.deepEqual(opencode, {
    command: '/agent',
    args: [
      'run', '--format', 'json', '--dir', '/work/repo', '--agent', 'build',
      '--model', 'test-model', '--variant', 'low',
      'Write JSON.\n\nThe snapshot JSON follows this prompt on standard input. Return JSON that matches this schema:\n{"type":"object"}',
    ],
    input: 'stdin',
    cwd: '/work/repo',
    env: environment,
  });
  for (const plan of [codex, claude, copilot, cursor, opencode]) {
    for (const flag of [
      '--approve-for-me',
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-skip-permissions',
      '--force',
      '--approve-mcps',
      '--auto',
    ]) {
      assert.ok(!plan.args.includes(flag), `${plan.command} includes ${flag}`);
    }
  }
});

test('adds native Fast mode settings to supported provider calls', () => {
  const common = {
    binary: '/agent',
    prompt: 'Write JSON.',
    schema: { type: 'object' },
    schemaPath: '/tmp/schema.json',
    inputPath: '/tmp/input.json',
    accessMode: { mode: 'checkout-read-only', root: '/work/repo' },
    fast: true,
  };
  const codex = agentCommand({ ...common, agent: 'codex' });
  const claude = agentCommand({ ...common, agent: 'claude' });

  assert.deepEqual(
    codex.args.filter((argument, index) =>
      argument === '--config' || codex.args[index - 1] === '--config'),
    [
      '--config',
      'service_tier="fast"',
      '--config',
      'features.fast_mode=true',
    ],
  );
  assert.deepEqual(
    claude.args.slice(
      claude.args.indexOf('--settings'),
      claude.args.indexOf('--settings') + 2,
    ),
    ['--settings', '{"fastMode":true}'],
  );
});

test('keeps snapshot-only provider plans in the temporary input directory', () => {
  const environment = {
    HOME: '/Users/reviewer',
    PATH: '/usr/bin',
    PRIVATE_AGENT_TOKEN: 'must-not-pass',
  };
  const plan = agentCommand({
    agent: 'codex',
    binary: '/agent',
    prompt: 'Write JSON.',
    schema: { type: 'object' },
    schemaPath: '/tmp/diffsplain-agent/schema.json',
    inputPath: '/tmp/diffsplain-agent/input.json',
    accessMode: { mode: 'snapshot-only', reason: 'target-mismatch' },
    env: environment,
  });

  assert.equal(plan.cwd, '/tmp/diffsplain-agent');
  assert.equal(
    plan.args[plan.args.indexOf('-C') + 1],
    '/tmp/diffsplain-agent',
  );
  assert.deepEqual(plan.env, {
    HOME: '/Users/reviewer',
    PATH: '/usr/bin',
  });
});

test('warns only for checkout providers without a proven native read-only mode', () => {
  const checkout = { mode: 'checkout-read-only', root: '/work/repo' };
  const snapshot = { mode: 'snapshot-only', reason: 'target-mismatch' };
  assert.match(agentReadOnlyWarning('copilot', checkout), /Copilot.*read-only/i);
  assert.match(agentReadOnlyWarning('opencode', checkout), /OpenCode.*read-only/i);
  assert.equal(agentReadOnlyWarning('codex', checkout), undefined);
  assert.equal(agentReadOnlyWarning('copilot', snapshot), undefined);
  assert.equal(agentReadOnlyWarning('opencode', snapshot), undefined);
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

test('reads documented provider usage without guessing missing fields', () => {
  const response = { change: { title: 'A note' } };
  const codex = [
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(response) } },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cached_input_tokens: 80,
        cache_write_input_tokens: 10,
      },
    },
  ].map(JSON.stringify).join('\n');
  assert.deepEqual(parseAgentResponse('codex', codex), response);
  assert.deepEqual(parseAgentUsage('codex', codex), {
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 80,
    cacheWriteTokens: 10,
  });

  assert.deepEqual(parseAgentUsage('claude', JSON.stringify({
    structured_output: response,
    usage: {
      input_tokens: 25,
      output_tokens: 9,
      cache_read_input_tokens: 14,
      cache_creation_input_tokens: 3,
    },
  })), {
    inputTokens: 25,
    outputTokens: 9,
    cacheReadTokens: 14,
    cacheWriteTokens: 3,
  });

  const openCode = [
    { type: 'text', part: { text: JSON.stringify(response) } },
    {
      type: 'step_finish',
      part: {
        tokens: {
          input: 40,
          output: 11,
          cache: { read: 17, write: 2 },
        },
      },
    },
  ].map(JSON.stringify).join('\n');
  assert.deepEqual(parseAgentUsage('opencode', openCode), {
    inputTokens: 40,
    outputTokens: 11,
    cacheReadTokens: 17,
    cacheWriteTokens: 2,
  });
  assert.equal(parseAgentUsage('cursor', '{}'), undefined);
  assert.equal(parseAgentUsage('copilot', '{}'), undefined);
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
