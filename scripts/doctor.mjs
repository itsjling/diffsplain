import { spawnSync } from 'node:child_process';
import {
  codingAgentBinary,
  codingAgents,
  findCommand,
  inspectCursorCompatibility,
} from './coding-agents.mjs';

const agentLabels = {
  codex: 'Codex',
  claude: 'Claude',
  copilot: 'Copilot',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};
const minimumNodeVersion = [22, 13, 0];

function firstLine(value) {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
}

function commandResult(command, args, env) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    env,
    timeout: 5_000,
    windowsHide: true,
  });
}

function commandVersion(command, env) {
  const result = commandResult(command, ['--version'], env);
  if (result.error || result.status !== 0) return undefined;
  return firstLine(`${result.stdout || ''}\n${result.stderr || ''}`);
}

function commandSucceeds(command, args, env) {
  const result = commandResult(command, args, env);
  return !result.error && result.status === 0;
}

function parseNodeVersion(version) {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return match.slice(1).map(Number);
}

function supportsNodeVersion(version) {
  const current = parseNodeVersion(version);
  if (!current) return false;
  for (const [index, part] of current.entries()) {
    if (part !== minimumNodeVersion[index]) {
      return part > minimumNodeVersion[index];
    }
  }
  return true;
}

async function inspectDependency(label, command, { env, platform }) {
  const path = await findCommand(command, { env, platform });
  if (!path) {
    return { label, command, installed: false, compatible: 'not-checked' };
  }
  const version = commandVersion(path, env);
  return {
    label,
    command,
    installed: true,
    path,
    version,
    compatible: version ? 'not-verified' : 'unknown',
  };
}

async function inspectAgent(agent, { env, platform }) {
  const label = agentLabels[agent];
  const command = codingAgentBinary(agent, { env });
  if (agent !== 'cursor') {
    return inspectDependency(label, command, { env, platform });
  }
  const path = await findCommand(command, { env, platform });
  if (!path) {
    return { label, command, installed: false, compatible: 'not-checked' };
  }
  const inspection = inspectCursorCompatibility(path, { env });
  return {
    label,
    command,
    installed: true,
    path,
    version: inspection.version,
    compatible: inspection.compatible ? 'yes' : 'no',
    ...(inspection.reason ? { boundaryError: inspection.reason } : {}),
  };
}

function dependencyLine(dependency) {
  const label = dependency.label.padEnd(9);
  if (dependency.disabled) {
    return `  ! ${label} disabled (${dependency.disabled})`;
  }
  if (!dependency.installed) {
    return `  ✗ ${label} not found (${dependency.command})`;
  }
  if (dependency.boundaryError) {
    return `  ! ${label} ${dependency.version || 'version unavailable'} (${dependency.path}; ${dependency.boundaryError})`;
  }
  const mark = dependency.version ? '✓' : '!';
  return `  ${mark} ${label} ${dependency.version || 'version unavailable'} (${dependency.path})`;
}

function stateLine(name, value) {
  return `    ${name.padEnd(14)} ${value}`;
}

function capabilityLines(name, capability) {
  return [
    `  ${name}`,
    stateLine(
      'installed',
      typeof capability.installed === 'boolean'
        ? yesNo(capability.installed)
        : capability.installed,
    ),
    stateLine('compatible', capability.compatible),
    stateLine('authenticated', capability.authenticated),
    stateLine('smoke test', capability.smokeTest),
  ];
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function localSmokeTest(dependency, deep, env) {
  if (!deep) return 'not-run';
  if (!dependency.installed) return 'not-run';
  return commandSucceeds(dependency.path, ['--help'], env)
    ? 'passed (local command only)'
    : 'failed (local command only)';
}

function providerCapability(agent, deep, env) {
  return {
    installed: agent.installed,
    compatible: agent.compatible,
    authenticated: 'not-checked',
    smokeTest: localSmokeTest(agent, deep, env),
  };
}

async function inspectDependencies(env, platform) {
  const [git, gh, ...agents] = await Promise.all([
    inspectDependency('Git', 'git', { env, platform }),
    inspectDependency('gh', 'gh', { env, platform }),
    ...codingAgents.map((agent) => inspectAgent(agent, { env, platform })),
  ]);
  return { git, gh, agents };
}

function coreInstalled(git, nodePath) {
  return git.installed && Boolean(nodePath);
}

function coreReady(git, nodeSupported) {
  return git.installed && Boolean(git.version) && nodeSupported;
}

function coreReviewCapability(git, nodeSupported, nodePath, deep, env) {
  const ready = coreReady(git, nodeSupported);
  return {
    installed: coreInstalled(git, nodePath),
    compatible: yesNo(ready),
    authenticated: 'not-required',
    smokeTest: localSmokeTest(git, deep, env),
    ready,
  };
}

function agentNoteCapabilities(agents, deep, env) {
  return Object.fromEntries(
    codingAgents.map((agent, index) => [
      agent,
      providerCapability(agents[index], deep, env),
    ]),
  );
}

function authenticationState(gh, env) {
  if (!gh.installed) return 'not-checked';
  return commandSucceeds(gh.path, ['auth', 'status', '--active'], env)
    ? 'passed'
    : 'failed';
}

function pullRequestCapability(gh, deep, env) {
  return {
    installed: gh.installed,
    compatible: gh.compatible,
    authenticated: authenticationState(gh, env),
    smokeTest: localSmokeTest(gh, deep, env),
  };
}

function machineReport({
  deep,
  platform,
  architecture,
  nodeVersion,
  nodePath,
  nodeSupported,
  git,
  gh,
  agents,
  capabilities,
}) {
  return {
    schemaVersion: 1,
    deep,
    platform: { name: platform, architecture },
    dependencies: {
      node: {
        installed: true,
        version: nodeVersion,
        path: nodePath,
        compatible: nodeSupported ? 'yes' : 'no',
      },
      git,
      gh,
      agents: Object.fromEntries(
        codingAgents.map((agent, index) => [agent, agents[index]]),
      ),
    },
    capabilities,
    ready: capabilities.coreReview.ready,
  };
}

function installedCountLabel(installedAgents) {
  return installedAgents.length
    ? `${installedAgents.length} installed`
    : 'none installed';
}

function agentCapabilityLines(agent, capabilities) {
  return capabilityLines(
    `Agent notes: ${agentLabels[agent]}`,
    capabilities.agentNotes[agent],
  );
}

function appendDoctorNotes(lines, installedAgents, deep) {
  if (!installedAgents.length) {
    lines.push('  No agent is required for a plain local review; use --no-agent.');
  }
  if (!deep) {
    lines.push(
      '  Smoke tests were not run. Use doctor --deep for local command checks.',
    );
  }
}

function reportText({
  deep,
  platform,
  architecture,
  nodeVersion,
  nodePath,
  git,
  gh,
  agents,
  capabilities,
}) {
  const installedAgents = agents.filter((agent) => agent.installed);
  const lines = [
    'Diffsplain doctor',
    '',
    'Dependencies',
    dependencyLine({
      label: 'Node',
      command: 'node',
      installed: true,
      path: nodePath,
      version: nodeVersion,
    }),
    dependencyLine(git),
    dependencyLine(gh),
    '',
    `Coding agents (${installedCountLabel(installedAgents)})`,
    ...agents.map(dependencyLine),
    '',
    'Capabilities',
    ...capabilityLines('Plain local review', {
      ...capabilities.coreReview,
      installed: yesNo(capabilities.coreReview.installed),
    }),
    ...codingAgents.flatMap((agent) =>
      agentCapabilityLines(agent, capabilities),
    ),
    ...capabilityLines('Pull request lookup', {
      ...capabilities.pullRequestLookup,
      installed: yesNo(capabilities.pullRequestLookup.installed),
    }),
    `  Platform: ${platform} ${architecture}`,
  ];
  appendDoctorNotes(lines, installedAgents, deep);
  return lines.join('\n');
}

export async function doctorReport({
  env = process.env,
  platform = process.platform,
  architecture = process.arch,
  nodeVersion = process.version,
  nodePath = process.execPath,
  deep = false,
} = {}) {
  const { git, gh, agents } = await inspectDependencies(env, platform);
  const nodeSupported = supportsNodeVersion(nodeVersion);
  const capabilities = {
    coreReview: coreReviewCapability(git, nodeSupported, nodePath, deep, env),
    agentNotes: agentNoteCapabilities(agents, deep, env),
    pullRequestLookup: pullRequestCapability(gh, deep, env),
  };
  const reportOptions = {
    deep,
    platform,
    architecture,
    nodeVersion,
    nodePath,
    nodeSupported,
    git,
    gh,
    agents,
    capabilities,
  };
  const json = machineReport(reportOptions);
  return {
    text: reportText(reportOptions),
    json,
    ready: json.ready,
  };
}
