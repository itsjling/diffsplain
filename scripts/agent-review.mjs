import { createHash } from 'node:crypto';

function userRef(value) {
  return typeof value === 'string' && !/^[a-f0-9]{40,64}$/i.test(value)
    ? value
    : undefined;
}

function definedObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function optionalValue(value) {
  return value ? value : undefined;
}

function nestedValue(value, objectKey, valueKey) {
  return value[objectKey]?.[valueKey];
}

function agentHead(target) {
  const ref = userRef(nestedValue(target, 'head', 'ref'));
  return ref
    ? definedObject({
        ref,
        repository: optionalValue(nestedValue(target, 'head', 'repository')),
      })
    : undefined;
}

export function agentReviewContext({
  name,
  selector,
  target = {},
  branch,
  baseBranch,
}) {
  return definedObject({
    name,
    selector: optionalValue(selector),
    target: definedObject({
      kind: target.kind,
      branch: optionalValue(branch),
      baseBranch: optionalValue(baseBranch),
      remote: optionalValue(target.remote),
      repository: optionalValue(target.repository),
      pullRequest: optionalValue(nestedValue(target, 'pullRequest', 'number')),
      base: userRef(nestedValue(target, 'base', 'ref')),
      head: agentHead(target),
    }),
  });
}

export function agentReviewContextFromSnapshot(snapshot) {
  return agentReviewContext({
    name: snapshot.repo.name,
    selector: snapshot.repo.repository,
    target: snapshot.repo.target,
    branch: snapshot.repo.branch,
    baseBranch: snapshot.repo.baseBranch,
  });
}

export function agentReviewFile(file) {
  return {
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    isBinary: file.isBinary,
    patch: file.patch,
  };
}

export function createAgentReviewFingerprint({ context, files }) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        context,
        files: files.map(agentReviewFile),
      }),
    )
    .digest('hex');
}

export function agentReviewFingerprintFromSnapshot(snapshot) {
  return createAgentReviewFingerprint({
    context: agentReviewContextFromSnapshot(snapshot),
    files: snapshot.files.filter((file) => !file.agentExcluded),
  });
}
