import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  cliOptions,
  helpText,
  parseCliArgs,
} from '../scripts/cli-args.mjs';
import {
  enabledCodingAgents,
} from '../scripts/coding-agents.mjs';

const [
  docs,
  agentNotes,
  development,
  index,
  packageText,
  product,
  data,
  readme,
] = await Promise.all([
  readFile(new URL('../docs/content/cli.mdx', import.meta.url), 'utf8'),
  readFile(new URL('../docs/content/agent-notes.mdx', import.meta.url), 'utf8'),
  readFile(new URL('../docs/content/development.mdx', import.meta.url), 'utf8'),
  readFile(new URL('../docs/content/index.mdx', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('../PRODUCT.md', import.meta.url), 'utf8'),
  readFile(new URL('../docs/content/data.mdx', import.meta.url), 'utf8'),
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
]);

test('lists each accepted option in public help and the CLI reference', () => {
  const acceptedOptions = Object.keys(cliOptions);
  assert.ok(acceptedOptions.length > 15);
  for (const option of acceptedOptions) {
    const pattern = new RegExp(
      option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
    assert.match(docs, pattern);
    assert.match(helpText, pattern);
  }

  for (const match of helpText.matchAll(/--[a-z][a-z-]*/g)) {
    assert.match(docs, new RegExp(match[0]));
  }
});

test('documents provider inputs and limits', () => {
  for (const name of [
    'CODEX_BIN',
    'CLAUDE_BIN',
    'COPILOT_BIN',
    'CURSOR_BIN',
    'OPENCODE_BIN',
  ]) {
    assert.match(docs, new RegExp(name));
  }
  assert.match(docs, /Only Codex and OpenCode accept `--reasoning`/);
  assert.match(agentNotes, /only Codex and\s+OpenCode accept `--reasoning`/);
  assert.doesNotMatch(agentNotes, /--agent claude[\s\S]{0,100}--reasoning/);
});

test('documents checkout access and provider limits', () => {
  for (const document of [docs, agentNotes, development]) {
    assert.match(document, /--no-checkout-access/);
    assert.match(document, /snapshot-only/);
    assert.match(document, /checkout-read-only/);
  }
  const notes = agentNotes.replace(/\s+/g, ' ');
  assert.match(notes, /ignored files, Git history, and symlink targets/);
  assert.match(notes, /Copilot and OpenCode.*no proven native read-only mode/i);
  assert.match(notes, /approval.*user/i);
  assert.match(notes, /Diffsplain itself does not edit the review target/i);
  assert.match(notes, /Agents run under your user permissions/i);
});

test('documents ordered agent-context exclusions', () => {
  const cli = docs.replace(/\s+/g, ' ');
  const notes = agentNotes.replace(/\s+/g, ' ');
  const snapshot = data.replace(/\s+/g, ' ');
  assert.match(helpText, /--exclude PATTERN/);
  assert.match(readme, /--exclude PATTERN/);
  assert.match(cli, /gitignore-style rules in the order you pass them/i);
  assert.match(cli, /!private\/keep\.txt/);
  assert.match(cli, /current path.*renamed file/i);
  assert.match(cli, /--force.*does not override/i);
  assert.match(cli, /not a privacy boundary/i);
  assert.match(cli, /does not change checkout access/i);
  assert.match(notes, /automatic agent input/i);
  assert.match(notes, /hides a cached note/i);
  assert.match(notes, /all files.*excluded/i);
  assert.match(snapshot, /agentExcluded/);
  assert.match(snapshot, /full patch/i);
});

test('documents the picker order and Cursor CLI', () => {
  const providerNames = enabledCodingAgents.map(
    (agent) => (agent === 'opencode'
      ? 'OpenCode'
      : agent[0].toUpperCase() + agent.slice(1)),
  );
  const providerOrder =
    `${providerNames.slice(0, -1).join(', ')}, then ${providerNames.at(-1)}`;
  for (const document of [product, index, agentNotes, development]) {
    const text = document.replace(/\s+/g, ' ');
    assert.match(text, new RegExp(providerOrder));
    assert.match(text, /Cursor.{0,50}2026\.08\.11 or newer/i);
    assert.match(text, /Cursor.{0,160}(?:user's home|signed-in Cursor CLI)/i);
    assert.match(text, /Cursor.{0,160}contacts.{0,50}(?:own )?service/i);
  }

  const notes = agentNotes.replace(/\s+/g, ' ');
  for (const document of [docs, agentNotes]) {
    const text = document.replace(/\s+/g, ' ');
    assert.match(text, /interactive terminal/i);
    assert.match(
      text,
      /does not choose an agent for you|pass `--agent NAME` or (use )?`--no-agent`/i,
    );
  }
  assert.doesNotMatch(helpText, /Automatic agent selection/);
  assert.match(notes, /non-interactive Ask mode/i);
  assert.match(notes, /--trust/i);
  assert.match(notes, /--workspace/i);
  assert.match(notes, /does not replace `HOME`/i);
});

test('derives documented numeric defaults and bounds from the parser', () => {
  const batchSize = cliOptions['--batch-size'];
  const jobs = cliOptions['--jobs'];
  const port = cliOptions['--port'];
  assert.match(
    docs,
    new RegExp(
      `--batch-size\` defaults to \`${batchSize.default}\`[\\s\\S]*` +
      `\`${batchSize.min}\` through \`${batchSize.max}\``,
    ),
  );
  assert.match(
    docs,
    new RegExp(
      `--jobs\` defaults\\s+to \`${jobs.default}\` and accepts ` +
      `\`${jobs.min}\` through \`${jobs.max}\``,
    ),
  );
  assert.match(
    docs,
    new RegExp(
      `--port\` accepts \`${port.min}\` through \`${port.max}\``,
    ),
  );
  assert.equal(parseCliArgs([]).port, port.default);
  for (const [name, record] of [
    ['--batch-size', batchSize],
    ['--jobs', jobs],
    ['--port', port],
  ]) {
    assert.doesNotThrow(() =>
      parseCliArgs([name, String(record.min)]));
    assert.doesNotThrow(() =>
      parseCliArgs([name, String(record.max)]));
    assert.throws(() =>
      parseCliArgs([name, String(record.max + 1)]));
  }
});

test('pins first-run lifecycle facts in the docs check', () => {
  assert.match(docs, /npx diffsplain doctor/);
  assert.match(docs, /browser cannot open[\s\S]*open that URL yourself/);
  assert.match(docs, /Ctrl/);
  assert.match(docs, /Normal shutdown removes temporary page and agent\s+input files/);
  assert.match(docs, /Saved notes remain in the user cache/);
  assert.match(
    docs,
    /Fetched Git objects remain\s+in the installed package's `\.cache\/git` folder/,
  );

  const packageJson = JSON.parse(packageText);
  assert.match(packageJson.scripts['docs:check'], /tests\/cli-docs\.test\.mjs/);
});
