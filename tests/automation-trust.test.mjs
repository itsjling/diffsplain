import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('..', import.meta.url);

test('the repo-owned hook manifest cannot run branch code', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('.codex/hooks.json', projectRoot), 'utf8'),
  );

  assert.deepEqual(manifest, { hooks: {} });
  assert.doesNotMatch(JSON.stringify(manifest), /command|\.agents/);
});

test('records vendored hook provenance and owns every trust boundary', async () => {
  const [lockText, codeowners] = await Promise.all([
    readFile(new URL('skills-lock.json', projectRoot), 'utf8'),
    readFile(new URL('.github/CODEOWNERS', projectRoot), 'utf8'),
  ]);
  const lock = JSON.parse(lockText);

  assert.deepEqual(lock.skills.impeccable, {
    source: 'pbakaus/impeccable',
    sourceType: 'github',
    version: '4.0.2',
    skillPath: 'skill/SKILL.md',
    computedHash:
      'd61672b057c247542e8a4884d68794e5b0cc1198446d23aae0321180c23f1521',
  });
  for (const path of [
    '/.codex/',
    '/.agents/',
    '/AGENTS.md',
    '/skills-lock.json',
    '/.github/workflows/automation-trust.yml',
    '/.github/workflows/release.yml',
    '/scripts/release-workflow.mjs',
  ]) {
    assert.match(
      codeowners,
      new RegExp(`^${path.replaceAll('.', '\\.')} @itsjling$`, 'm'),
    );
  }
});

test('uses a base-branch workflow as the automation review gate', async () => {
  const workflow = await readFile(
    new URL('.github/workflows/automation-trust.yml', projectRoot),
    'utf8',
  );

  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /github\.rest\.pulls\.listFiles/);
  assert.match(workflow, /file\.previous_filename/);
  assert.match(workflow, /context\.payload\.action === "synchronize"/);
  assert.match(workflow, /github\.rest\.issues\.removeLabel/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /automation-reviewed/);
  assert.match(workflow, /path === "\.github\/workflows\/release\.yml"/);
  assert.match(workflow, /path === "scripts\/release-workflow\.mjs"/);
  assert.match(workflow, /core\.setFailed/);
  assert.doesNotMatch(workflow, /actions\/checkout|pull_request\.head|exec/);
});
