import assert from "node:assert/strict";
import { join, relative } from "node:path";
import test from "node:test";
import {
  defaultCacheRoot,
  summaryPath,
} from "../scripts/summary-path.mjs";

const cacheRoot = "/tmp/diffsplain-cache";
const callerDirectory = "/tmp";
const repo = "/tmp/repo";

function path(options = {}) {
  return summaryPath({
    cacheRoot,
    callerDirectory,
    repo,
    ...options,
  });
}

test("keeps every implicit target in a target-specific cache file", () => {
  const worktree = path();
  const checkout = path({ checkout: true, remote: "origin" });
  const baseWorktree = path({ base: "main" });
  const range = path({ base: "main", head: "feature" });
  const branch = path({ branch: "feature", remote: "origin" });
  const pullRequest = path({ pr: "198", remote: "origin" });

  for (const [kind, value] of Object.entries({
    worktree,
    checkout,
    "base-worktree": baseWorktree,
    range,
    branch,
    pr: pullRequest,
  })) {
    assert.match(
      value,
      new RegExp(`/diffsplain-cache/summaries/${kind}-[a-f0-9]{24}\\.json$`),
    );
    assert.ok(relative(repo, value).startsWith(".."), `${kind} path is outside the repo`);
  }

  assert.equal(
    pullRequest,
    path({
      pr: "https://github.com/example/project/pull/198",
      remote: "origin",
    }),
  );
  assert.notEqual(worktree, checkout);
  assert.notEqual(checkout, range);
  assert.notEqual(baseWorktree, range);
  assert.notEqual(range, branch);
  assert.notEqual(branch, pullRequest);
});

test("keeps target identities separate across and within repos", () => {
  const otherWorktree = summaryPath({
    cacheRoot,
    callerDirectory,
    repo: "/tmp/other-repo",
  });

  assert.notEqual(path(), otherWorktree);
  assert.notEqual(path(), path({ branch: "feature", remote: "origin" }));
});

test("resolves explicit note files from the caller directory", () => {
  assert.equal(
    path({ explicit: "chosen.json" }),
    join(callerDirectory, "chosen.json"),
  );
});

test("keeps remote and range note file identities stable", () => {
  const pullRequest = path({ pr: "198", remote: "origin" });
  assert.equal(
    pullRequest,
    path({
      pr: "https://github.com/example/project/pull/198",
      remote: "origin",
    }),
  );
  assert.match(
    pullRequest,
    /\/diffsplain-cache\/summaries\/pr-[a-f0-9]{24}\.json$/,
  );

  const branch = path({ branch: "feature", remote: "origin" });
  const otherBranch = path({ branch: "other", remote: "origin" });
  const checkout = path({ checkout: true, remote: "origin" });
  const range = path({ base: "main", head: "feature" });
  assert.notEqual(branch, otherBranch);
  assert.notEqual(branch, range);
  assert.notEqual(checkout, range);
  assert.match(
    branch,
    /\/diffsplain-cache\/summaries\/branch-[a-f0-9]{24}\.json$/,
  );
  assert.match(
    checkout,
    /\/diffsplain-cache\/summaries\/checkout-[a-f0-9]{24}\.json$/,
  );
  assert.match(
    range,
    /\/diffsplain-cache\/summaries\/range-[a-f0-9]{24}\.json$/,
  );
});

test("uses the user cache instead of the package install path", () => {
  assert.equal(
    defaultCacheRoot({
      env: { XDG_CACHE_HOME: "/tmp/user-cache" },
      platform: "linux",
      homeDirectory: "/home/reviewer",
    }),
    "/tmp/user-cache/diffsplain",
  );
  assert.equal(
    defaultCacheRoot({
      env: {},
      platform: "darwin",
      homeDirectory: "/Users/reviewer",
    }),
    "/Users/reviewer/Library/Caches/diffsplain",
  );
  assert.equal(
    defaultCacheRoot({
      env: {},
      platform: "linux",
      homeDirectory: "/home/reviewer",
    }),
    "/home/reviewer/.cache/diffsplain",
  );
});
