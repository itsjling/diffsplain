const titleCodePointLimit = 160;
const proseCodePointLimit = 1_200;
const detailItemLimit = 4;
const riskItemLimit = 3;
const listItemCodePointLimit = 500;

function textSchema(maxLength) {
  return { type: 'string', minLength: 1, maxLength };
}

function listSchema(maxItems) {
  return {
    type: 'array',
    maxItems,
    items: textSchema(listItemCodePointLimit),
  };
}

const title = textSchema(titleCodePointLimit);
const prose = textSchema(proseCodePointLimit);
const details = listSchema(detailItemLimit);
const risks = listSchema(riskItemLimit);
const fileNote = {
  type: 'object',
  properties: {
    title,
    what: prose,
    why: prose,
    details,
    risks,
  },
  required: ['title', 'what', 'why', 'details', 'risks'],
  additionalProperties: false,
};

export function outputSchema(paths, { includeChange = true } = {}) {
  const properties = {};
  if (includeChange) {
    properties.change = {
      type: 'object',
      properties: {
        title,
        summary: prose,
        why: prose,
        highlights: details,
        risks,
      },
      required: ['title', 'summary', 'why', 'highlights', 'risks'],
      additionalProperties: false,
    };
  }
  if (paths.length) {
    properties.files = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', enum: paths },
          ...fileNote.properties,
        },
        required: ['path', ...fileNote.required],
        additionalProperties: false,
      },
    };
  }
  return {
    type: 'object',
    properties,
    required: [
      ...(includeChange ? ['change'] : []),
      ...(paths.length ? ['files'] : []),
    ],
    additionalProperties: false,
  };
}

function normalizedText(value, field, limit) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (Array.from(text).length > limit) {
    throw new Error(`${field} must be at most ${limit} Unicode code points`);
  }
  return text;
}

// fallow-ignore-next-line complexity
function normalizedList(value, field, maxItems) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be a list of strings`);
  }
  if (value.length > maxItems) {
    throw new Error(`${field} must contain at most ${maxItems} items`);
  }
  const list = value.map((item) => item.trim()).filter(Boolean);
  for (const item of list) {
    if (Array.from(item).length > listItemCodePointLimit) {
      throw new Error(
        `${field} items must be at most ${listItemCodePointLimit} Unicode code points`,
      );
    }
  }
  return list;
}

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter((field) => !actual.includes(field));
    const extra = actual.filter((field) => !expected.includes(field));
    const detail = [
      missing.length ? `missing: ${missing.join(', ')}` : '',
      extra.length ? `extra: ${extra.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    throw new Error(`${label} has ${detail}`);
  }
}

function isObject(value) {
  return Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function responseObject(value) {
  if (!isObject(value)) {
    throw new Error('Agent response must be an object');
  }
  return value;
}

function unsupportedResponseFields(value) {
  return Object.keys(value).filter(
    (field) => !['change', 'files'].includes(field),
  );
}

export function normalizeChangeResponse(value) {
  const response = responseObject(value);
  if (unsupportedResponseFields(response).length) {
    throw new Error('Agent response has unsupported fields');
  }
  exactFields(
    response.change,
    ['title', 'summary', 'why', 'highlights', 'risks'],
    'Change note',
  );
  return {
    title: normalizedText(response.change.title, 'change.title', titleCodePointLimit),
    summary: normalizedText(response.change.summary, 'change.summary', proseCodePointLimit),
    why: normalizedText(response.change.why, 'change.why', proseCodePointLimit),
    highlights: normalizedList(
      response.change.highlights,
      'change.highlights', detailItemLimit,
    ),
    risks: normalizedList(response.change.risks, 'change.risks', riskItemLimit),
  };
}

function arrayFileEntry(note) {
  if (!isObject(note)) {
    return { error: 'Agent response has a malformed file note' };
  }
  const path = typeof note.path === 'string' ? note.path.trim() : '';
  return path
    ? { entry: { path, note, arrayForm: true } }
    : { error: 'Agent response has a file note without a path' };
}

function arrayFileEntries(notes) {
  const result = { entries: [], errors: [] };
  for (const note of notes) {
    const item = arrayFileEntry(note);
    if (item.entry) result.entries.push(item.entry);
    if (item.error) result.errors.push(item.error);
  }
  return result;
}

function fileResponseEntries(value) {
  const response = responseObject(value);
  const errors = unsupportedResponseFields(response).map(
    (field) => `Agent response has unsupported field: ${field}`,
  );
  if (Array.isArray(response.files)) {
    const arrayResult = arrayFileEntries(response.files);
    return {
      entries: arrayResult.entries,
      errors: [...errors, ...arrayResult.errors],
    };
  }
  if (!isObject(response.files)) {
    throw new Error('Agent response has no file notes object');
  }
  return {
    entries: Object.entries(response.files).map(([path, note]) => ({
      path,
      note,
      arrayForm: false,
    })),
    errors,
  };
}

function normalizeFileNote(note, path, arrayForm) {
  exactFields(
    note,
    [
      ...(arrayForm ? ['path'] : []),
      'title',
      'what',
      'why',
      'details',
      'risks',
    ],
    path,
  );
  return {
    title: normalizedText(note.title, `${path}.title`, titleCodePointLimit),
    what: normalizedText(note.what, `${path}.what`, proseCodePointLimit),
    why: normalizedText(note.why, `${path}.why`, proseCodePointLimit),
    details: normalizedList(note.details, `${path}.details`, detailItemLimit),
    risks: normalizedList(note.risks, `${path}.risks`, riskItemLimit),
  };
}

function indexFileEntries(entries, expected) {
  const byPath = new Map();
  const failedFiles = [];
  for (const entry of entries) {
    if (!expected.has(entry.path)) {
      failedFiles.push({
        path: entry.path,
        reason: 'Agent output included a file outside this batch.',
      });
      continue;
    }
    const values = byPath.get(entry.path) || [];
    byPath.set(entry.path, [...values, entry]);
  }
  return { byPath, failedFiles };
}

function normalizeFileEntry(path, values) {
  if (values.length !== 1) {
    return {
      failure: {
        path,
        reason: values.length
          ? 'Agent output repeated this file.'
          : 'Agent output omitted this file.',
      },
    };
  }
  try {
    return {
      note: normalizeFileNote(
        values[0].note,
        path,
        values[0].arrayForm,
      ),
    };
  } catch (error) {
    return {
      failure: {
        path,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function normalizeFileResponse(value, paths) {
  const expected = new Set(paths);
  const files = {};
  const { entries, errors } = fileResponseEntries(value);
  const indexed = indexFileEntries(entries, expected);
  for (const path of paths) {
    const result = normalizeFileEntry(
      path,
      indexed.byPath.get(path) || [],
    );
    if (result.note) files[path] = result.note;
    if (result.failure) indexed.failedFiles.push(result.failure);
  }
  return { files, failedFiles: indexed.failedFiles, errors };
}

