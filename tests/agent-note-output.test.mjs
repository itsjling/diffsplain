import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeChangeResponse,
  normalizeFileResponse,
  outputSchema,
} from '../scripts/agent-note-output.mjs';

const fileNote = {
  title: 'Add text',
  what: 'Adds text.',
  why: 'Tests note limits.',
  details: [],
  risks: [],
};

const invalidFields = [
  ['title', 'x'.repeat(161), /title.*160/],
  ['title', '😀'.repeat(161), /title.*160/],
  ['what', 'x'.repeat(1201), /what.*1200/],
  ['why', 'x'.repeat(1201), /why.*1200/],
  ['details', Array(5).fill('detail'), /details.*4 items/],
  ['risks', Array(4).fill('risk'), /risks.*3 items/],
  ['details', ['x'.repeat(501)], /details items.*500/],
  ['risks', ['x'.repeat(501)], /risks items.*500/],
];

for (const [index, [field, value, error]] of invalidFields.entries()) {
  test(`rejects file note ${field} exceeding its limit (case ${index + 1})`, () => {
    const result = normalizeFileResponse({
      files: {
        'added.txt': { ...fileNote, [field]: value },
        'changed.txt': fileNote,
      },
    }, ['added.txt', 'changed.txt']);
    assert.deepEqual(result.files, { 'changed.txt': fileNote });
    assert.equal(result.failedFiles.length, 1);
    assert.equal(result.failedFiles[0].path, 'added.txt');
    assert.match(result.failedFiles[0].reason, error);
    assert.deepEqual(result.errors, []);
  });
}

const boundary = {
  title: '😀'.repeat(160),
  what: 'w'.repeat(1200),
  why: 'y'.repeat(1200),
  details: Array(4).fill('😀'.repeat(500)),
  risks: Array(3).fill('r'.repeat(500)),
};

test('accepts file note boundaries in object and array responses', () => {
  for (const files of [
    { 'added.txt': boundary },
    [{ path: 'added.txt', ...boundary }],
  ]) {
    assert.deepEqual(normalizeFileResponse({ files }, ['added.txt']), {
      files: { 'added.txt': boundary },
      failedFiles: [],
      errors: [],
    });
  }
});

function changeNote(note) {
  const { what, details, ...fields } = note;
  return { ...fields, summary: what, highlights: details };
}

for (const [index, [field, value, error]] of invalidFields.entries()) {
  test(`rejects change note ${field} exceeding its limit (case ${index + 1})`, () => {
    const change = changeNote({ ...fileNote, [field]: value });
    const changeError = new RegExp(error.source
      .replace('what', 'summary').replace('details', 'highlights'));
    assert.throws(() => normalizeChangeResponse({ change }), changeError);
  });
}

test('accepts change note boundaries', () => {
  const change = changeNote(boundary);
  assert.deepEqual(normalizeChangeResponse({ change }), change);
});

test('scopes output schemas to the requested notes and file paths', () => {
  const combined = outputSchema(['added.txt', 'changed.txt']);
  assert.deepEqual(combined.required, ['change', 'files']);
  assert.deepEqual(combined.properties.files.items.properties.path.enum, [
    'added.txt', 'changed.txt',
  ]);
  const files = outputSchema(['added.txt'], { includeChange: false });
  assert.deepEqual(files.required, ['files']);
  assert.ok(!Object.hasOwn(files.properties, 'change'));
  const change = outputSchema([]);
  assert.deepEqual(change.required, ['change']);
  assert.ok(!Object.hasOwn(change.properties, 'files'));
});
