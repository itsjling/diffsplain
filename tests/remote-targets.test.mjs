import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/build-diff-data.mjs", import.meta.url).pathname;
const unavailableSymlinkCodes = new Set(["EACCES", "EPERM"]);

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function run(repo, args, options = {}) {
  return execFileSync(
    process.execPath,
    [script, "--repo", repo, ...args],
    { encoding: "utf8", stdio: "pipe", ...options },
  );
}

async function proxyRemote(fixture, remoteUrl) {
  const bin = join(fixture.root, "git-proxy");
  const proxy = join(bin, "git");
  await mkdir(bin);
  await writeFile(
    proxy,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2).map((arg) =>
  arg === ${JSON.stringify(remoteUrl)}
    ? ${JSON.stringify(fixture.remote)}
    : arg
);
const result = spawnSync("git", args, {
  env: { ...process.env, PATH: process.env.DIFFSPLAIN_REAL_PATH },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
  );
  await chmod(proxy, 0o755);
  return {
    ...process.env,
    DIFFSPLAIN_REAL_PATH: process.env.PATH,
    PATH: `${bin}:${process.env.PATH}`,
  };
}

async function makeRemoteRepo() {
  const root = await mkdtemp(join(tmpdir(), "diffsplain-remote-"));
  await mkdir(join(root, "example"));
  const remote = join(root, "example", "diffsplain.git");
  const repo = join(root, "checkout");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["clone", "-q", remote, repo]);
  git(repo, "config", "user.email", "diffsplain@example.test");
  git(repo, "config", "user.name", "Diffsplain");
  git(repo, "config", "commit.gpgsign", "false");

  await writeFile(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-qm", "base");
  git(repo, "branch", "-M", "main");
  git(repo, "push", "-qu", "origin", "main");
  execFileSync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const baseOid = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "-qc", "feature");
  await writeFile(join(repo, "feature.txt"), "feature work\n");
  git(repo, "add", "feature.txt");
  git(repo, "commit", "-qm", "feature");
  const featureOid = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "-qu", "origin", "feature");

  git(repo, "switch", "-q", "main");
  await writeFile(join(repo, "main.txt"), "main work\n");
  git(repo, "add", "main.txt");
  git(repo, "commit", "-qm", "main");
  git(repo, "push", "-q", "origin", "main");
  const mainOid = git(repo, "rev-parse", "HEAD");
  git(repo, "branch", "-D", "feature");

  return { root, remote, repo, baseOid, featureOid, mainOid };
}

function checkoutState(repo) {
  const fetchHead = join(repo, ".git", "FETCH_HEAD");
  return {
    head: git(repo, "rev-parse", "HEAD"),
    branch: git(repo, "branch", "--show-current"),
    status: git(repo, "status", "--porcelain=v1"),
    index: git(repo, "ls-files", "--stage"),
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
    fetchHead: existsSync(fetchHead) ? readFileSync(fetchHead, "utf8") : null,
  };
}

function waitFor(read, timeout = 8_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const poll = async () => {
      try {
        const value = await read();
        if (value) return resolve(value);
      } catch {}
      if (Date.now() >= deadline) {
        reject(new Error("Timed out waiting for watched diff data"));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function stop(child) {
  return new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
    child.kill("SIGTERM");
  });
}

function addPublicRemote(fixture) {
  const url = "https://github.com/example/project.git";
  git(fixture.repo, "remote", "add", "upstream", url);
  git(fixture.repo, "config", `url.file://${fixture.remote}.insteadOf`, url);
  return url;
}

function namedBranchArgs(cache, output) {
  return [
    "--remote",
    "upstream",
    "--branch",
    "upstream/feature",
    "--base",
    "upstream/main",
    "--cache-dir",
    cache,
    "--output",
    output,
  ];
}

async function publishFeatureUpdate(fixture, path, content) {
  const publisher = join(fixture.root, `publisher-${path.replaceAll("/", "-")}`);
  execFileSync("git", ["clone", "-q", fixture.remote, publisher]);
  git(publisher, "config", "user.email", "diffsplain@example.test");
  git(publisher, "config", "user.name", "Diffsplain");
  git(publisher, "config", "commit.gpgsign", "false");
  git(publisher, "switch", "-q", "feature");
  await writeFile(join(publisher, path), content);
  git(publisher, "add", path);
  git(publisher, "commit", "-qm", "refresh feature");
  const head = git(publisher, "rev-parse", "HEAD");
  git(publisher, "push", "-q", "origin", "feature");
  return head;
}

function startWatcher(repo, args, options = {}) {
  const child = spawn(
    process.execPath,
    [script, "--repo", repo, ...args],
    {
      env: {
        ...process.env,
        ...options.env,
        DIFFSPLAIN_WATCH_INTERVAL_MS: "25",
        DIFFSPLAIN_REMOTE_REFRESH_INTERVAL_MS: "100",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  return { child, logs: () => chunks.join("") };
}

async function waitForSnapshot(output, watched, accept) {
  try {
    return await waitFor(async () => {
      const payload = JSON.parse(await readFile(output, "utf8"));
      return accept(payload) ? payload : undefined;
    });
  } catch (error) {
    throw new Error(`${error.message}: ${watched.logs()}`);
  }
}

async function stopIfRunning(watched) {
  if (watched?.child.exitCode === null) await stop(watched.child);
}

async function createDirectorySymlink(target, link) {
  try {
    await symlink(target, link, "dir");
    return undefined;
  } catch (error) {
    if (unavailableSymlinkCodes.has(error.code)) return error.code;
    throw error;
  }
}

test("builds a remote branch range without changing the checkout", async () => {
  const fixture = await makeRemoteRepo();
  const output = join(fixture.root, "branch.json");
  const cache = join(fixture.root, "cache");
  const before = checkoutState(fixture.repo);

  try {
    run(fixture.repo, [
      "--branch",
      "feature",
      "--cache-dir",
      cache,
      "--output",
      output,
    ]);
    const payload = JSON.parse(await readFile(output, "utf8"));

    assert.deepEqual(payload.files.map((file) => file.path), ["feature.txt"]);
    assert.equal(payload.repo.base, fixture.baseOid);
    assert.equal(payload.repo.head, fixture.featureOid);
    assert.equal(payload.repo.branch, "feature");
    assert.equal(payload.repo.remote, "origin");
    assert.equal(payload.repo.baseBranch, "main");
    assert.deepEqual(checkoutState(fixture.repo), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("uses a named remote for remote-only refs and keeps source links current", async () => {
  const fixture = await makeRemoteRepo();
  const output = join(fixture.root, "upstream.json");
  const cache = join(fixture.root, "cache");

  try {
    addPublicRemote(fixture);
    git(
      fixture.repo,
      "remote",
      "set-url",
      "--add",
      "upstream",
      "https://github.com/wrong/project.git",
    );
    git(fixture.repo, "update-ref", "-d", "refs/remotes/origin/feature");
    const before = checkoutState(fixture.repo);

    run(fixture.repo, namedBranchArgs(cache, output));
    const first = JSON.parse(await readFile(output, "utf8"));
    assert.equal(first.repo.remote, "upstream");
    assert.equal(first.repo.target.base.ref, "main");
    assert.equal(first.repo.target.head.ref, "feature");
    assert.equal(
      first.files[0].sourceUrl,
      `https://github.com/example/project/blob/${fixture.featureOid}/feature.txt`,
    );
    assert.deepEqual(checkoutState(fixture.repo), before);

    const refreshedHead = await publishFeatureUpdate(
      fixture,
      "feature.txt",
      "refreshed feature work\n",
    );
    run(fixture.repo, namedBranchArgs(cache, output));
    const refreshed = JSON.parse(await readFile(output, "utf8"));
    assert.equal(refreshed.repo.head, refreshedHead);
    assert.equal(
      refreshed.files[0].sourceUrl,
      `https://github.com/example/project/blob/${refreshedHead}/feature.txt`,
    );
    assert.deepEqual(checkoutState(fixture.repo), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("builds the current checkout against the default branch", async () => {
  const fixture = await makeRemoteRepo();
  const output = join(fixture.root, "checkout.json");

  try {
    git(fixture.repo, "switch", "-qc", "local-feature");
    await writeFile(join(fixture.repo, "committed.txt"), "committed work\n");
    git(fixture.repo, "add", "committed.txt");
    git(fixture.repo, "commit", "-qm", "local feature");
    await writeFile(join(fixture.repo, "working.txt"), "working tree work\n");

    run(fixture.repo, ["--checkout", "--output", output]);
    const payload = JSON.parse(await readFile(output, "utf8"));

    assert.deepEqual(
      payload.files.map((file) => file.path),
      ["committed.txt", "working.txt"],
    );
    assert.equal(payload.repo.branch, "local-feature");
    assert.equal(payload.repo.baseBranch, "main");
    assert.equal(payload.repo.target.kind, "checkout");
    assert.equal(payload.repo.target.base.oid, fixture.mainOid);
    assert.equal(
      payload.change.title,
      "Changes on local-feature since main",
    );
    assert.equal(
      payload.change.summary,
      "Shows changes in the current checkout since it split from main, including any uncommitted work.",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("names worktree-only checkout changes without comparing a branch to itself", async () => {
  const fixture = await makeRemoteRepo();
  const output = join(fixture.root, "checkout-worktree.json");

  try {
    await writeFile(join(fixture.repo, "working.txt"), "working tree work\n");
    const githubRemote = "https://github.com/example/diffsplain.git";
    const env = await proxyRemote(fixture, githubRemote);
    git(
      fixture.repo,
      "remote",
      "set-url",
      "origin",
      githubRemote,
    );

    run(fixture.repo, ["--checkout", "--output", output], { env });
    const payload = JSON.parse(await readFile(output, "utf8"));

    assert.equal(payload.repo.base, payload.repo.head);
    assert.equal(payload.repo.branch, "main");
    assert.equal(payload.change.title, "Uncommitted changes on main");
    assert.equal(
      payload.change.summary,
      "Shows staged, unstaged, and untracked changes in the current checkout.",
    );
    assert.ok(
      payload.files.every((file) => file.comparisonUrl === undefined),
      "uncommitted work must not link to a commit-only comparison",
    );

    git(fixture.repo, "add", "working.txt");
    git(fixture.repo, "commit", "-qm", "local main work");

    run(fixture.repo, ["--checkout", "--output", output], { env });
    const committed = JSON.parse(await readFile(output, "utf8"));

    assert.notEqual(committed.repo.base, committed.repo.head);
    assert.equal(committed.change.title, "Local changes on main");
    assert.ok(
      committed.files.every((file) => file.comparisonUrl === undefined),
      "local-only commits must not link to a remote comparison",
    );

    git(fixture.repo, "remote", "set-url", "origin", fixture.remote);
    git(fixture.repo, "push", "-q", "origin", "HEAD:refs/heads/local-main");
    git(fixture.repo, "remote", "set-url", "origin", githubRemote);
    run(fixture.repo, ["--checkout", "--output", output], { env });
    const pushed = JSON.parse(await readFile(output, "utf8"));

    assert.match(
      pushed.files[0].comparisonUrl,
      /^https:\/\/github\.com\/example\/diffsplain\/compare\//,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("builds a remote repo target without a local checkout", async () => {
  const fixture = await makeRemoteRepo();
  const output = join(fixture.root, "remote-only.json");
  const cache = join(fixture.root, "remote-only-cache");

  try {
    execFileSync(
      process.execPath,
      [
        script,
        "--repo",
        fixture.root,
        "--remote",
        fixture.remote,
        "--branch",
        "feature",
        "--cache-dir",
        cache,
        "--output",
        output,
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
    const payload = JSON.parse(await readFile(output, "utf8"));

    assert.deepEqual(payload.files.map((file) => file.path), ["feature.txt"]);
    assert.equal(payload.repo.root, fixture.remote);
    assert.equal(payload.repo.baseBranch, "main");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("renders uncommon range entries with the right content and GitHub links", async () => {
  const fixture = await makeRemoteRepo();
  const output = join(fixture.root, "uncommon-range.json");

  try {
    await writeFile(join(fixture.repo, "deleted.txt"), "remove me\n");
    await writeFile(join(fixture.repo, "moved-from.txt"), "move me\n");
    await writeFile(join(fixture.repo, "changed.bin"), Buffer.from([0, 1]));
    await writeFile(
      join(fixture.repo, "long.txt"),
      Array.from({ length: 240 }, (_, index) => `before ${index}\n`).join(""),
    );
    git(fixture.repo, "add", ".");
    git(fixture.repo, "commit", "-qm", "uncommon base");
    const base = git(fixture.repo, "rev-parse", "HEAD");

    await writeFile(join(fixture.repo, "changed.bin"), Buffer.from([0, 2]));
    await writeFile(join(fixture.repo, "added.bin"), Buffer.from([0, 4]));
    await rm(join(fixture.repo, "deleted.txt"));
    git(fixture.repo, "mv", "moved-from.txt", "moved-to.txt");
    await writeFile(
      join(fixture.repo, "long.txt"),
      Array.from({ length: 240 }, (_, index) => `after ${index}\n`).join(""),
    );
    git(fixture.repo, "add", ".");
    git(fixture.repo, "commit", "-qm", "uncommon changes");
    const head = git(fixture.repo, "rev-parse", "HEAD");
    const githubRemote = "https://github.com/example/diffsplain.git";
    const env = await proxyRemote(fixture, githubRemote);
    git(fixture.repo, "remote", "set-url", "origin", githubRemote);
    const beforeLocalOnly = checkoutState(fixture.repo);

    run(
      fixture.repo,
      ["--base", base, "--head", head, "--output", output],
      { env },
    );
    const localOnly = JSON.parse(await readFile(output, "utf8"));

    assert.ok(
      localOnly.files.every((file) => file.comparisonUrl === undefined),
      "local-only ranges must not link to a remote comparison",
    );
    assert.deepEqual(checkoutState(fixture.repo), beforeLocalOnly);

    git(fixture.repo, "remote", "set-url", "origin", fixture.remote);
    git(fixture.repo, "push", "-q", "origin", "HEAD:refs/heads/uncommon");
    git(fixture.repo, "remote", "set-url", "origin", githubRemote);
    const before = checkoutState(fixture.repo);

    run(
      fixture.repo,
      ["--base", base, "--head", head, "--output", output],
      { env },
    );
    const payload = JSON.parse(await readFile(output, "utf8"));
    const files = Object.fromEntries(payload.files.map((file) => [file.path, file]));
    const source = (ref, path) =>
      `https://github.com/example/diffsplain/blob/${ref}/${path}`;
    const comparison = `https://github.com/example/diffsplain/compare/${base}...${head}`;

    assert.deepEqual(
      payload.files.map((file) => file.path),
      ["added.bin", "changed.bin", "deleted.txt", "long.txt", "moved-to.txt"],
    );
    assert.equal(files["added.bin"].status, "binary");
    assert.equal(files["added.bin"].isBinary, true);
    assert.equal(files["added.bin"].patch, "");
    assert.equal(files["added.bin"].sourceUrl, source(head, "added.bin"));
    assert.equal(files["added.bin"].comparisonUrl, comparison);
    assert.equal(files["changed.bin"].status, "binary");
    assert.equal(files["changed.bin"].isBinary, true);
    assert.equal(files["changed.bin"].patch, "");
    assert.equal(files["changed.bin"].sourceUrl, source(head, "changed.bin"));
    assert.equal(files["changed.bin"].comparisonUrl, comparison);
    assert.equal(files["deleted.txt"].status, "deleted");
    assert.equal(files["deleted.txt"].isBinary, false);
    assert.match(files["deleted.txt"].patch, /-remove me/);
    assert.equal(files["deleted.txt"].sourceUrl, source(base, "deleted.txt"));
    assert.equal(files["deleted.txt"].comparisonUrl, comparison);
    assert.equal(files["moved-to.txt"].status, "renamed");
    assert.equal(files["moved-to.txt"].oldPath, "moved-from.txt");
    assert.match(files["moved-to.txt"].patch, /similarity index 100%/);
    assert.equal(files["moved-to.txt"].sourceUrl, source(head, "moved-to.txt"));
    assert.equal(files["moved-to.txt"].comparisonUrl, comparison);
    assert.equal(files["long.txt"].status, "modified");
    assert.equal(files["long.txt"].isBinary, false);
    assert.equal(files["long.txt"].isTruncated, true);
    assert.ok(files["long.txt"].snippet.split("\n").length <= 180);
    assert.match(files["long.txt"].snippet, /^@@ /m);
    assert.equal(files["long.txt"].sourceUrl, source(head, "long.txt"));
    assert.equal(files["long.txt"].comparisonUrl, comparison);
    assert.deepEqual(checkoutState(fixture.repo), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("keeps links out of worktree entries and leaves the checkout untouched", async () => {
  const fixture = await makeRemoteRepo();
  const output = join(fixture.root, "uncommon-worktree.json");

  try {
    await writeFile(join(fixture.repo, "worktree.bin"), Buffer.from([0, 1]));
    const before = checkoutState(fixture.repo);

    run(fixture.repo, ["--worktree", "--output", output]);
    const payload = JSON.parse(await readFile(output, "utf8"));
    const [file] = payload.files;

    assert.equal(file.path, "worktree.bin");
    assert.equal(file.status, "binary");
    assert.equal(file.isBinary, true);
    assert.equal(file.patch, "");
    assert.equal(file.sourceUrl, undefined);
    assert.equal(file.comparisonUrl, undefined);
    assert.deepEqual(checkoutState(fixture.repo), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("uses gh credentials for GitHub HTTPS owner/name remotes", async () => {
  const fixture = await makeRemoteRepo();
  const bin = join(fixture.root, "bin");
  const recorded = join(fixture.root, "git-args.jsonl");
  const output = join(fixture.root, "pr.json");
  const cache = join(fixture.root, "cache");
  const remoteUrl = "https://github.com/example/project.git";
  const fileRemote = `file://${fixture.remote}`;

  try {
    await mkdir(bin);
    await writeFile(
      join(bin, "gh"),
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({
        number: 35,
        title: "Remote feature",
        url: "https://github.com/example/project/pull/35",
        state: "OPEN",
        updatedAt: "2026-01-01T00:00:00Z",
        isCrossRepository: false,
        baseRefName: "main",
        baseRefOid: fixture.mainOid,
        headRefName: "feature",
        headRefOid: fixture.featureOid,
      })}'\n`,
    );
    await chmod(join(bin, "gh"), 0o755);
    await writeFile(
      join(bin, "git"),
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(recorded)}, JSON.stringify({
  args,
  prompt: process.env.GIT_TERMINAL_PROMPT,
}) + "\\n");
const rewritten = args.map((arg) =>
  arg === ${JSON.stringify(remoteUrl)} ? ${JSON.stringify(fileRemote)} : arg
);
const result = spawnSync("git", rewritten, {
  env: { ...process.env, PATH: process.env.DIFFSPLAIN_REAL_PATH },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
    );
    await chmod(join(bin, "git"), 0o755);
    execFileSync("git", [
      "--git-dir",
      fixture.remote,
      "update-ref",
      "refs/pull/35/head",
      fixture.featureOid,
    ]);

    run(
      fixture.repo,
      [
        "--pr",
        "35",
        "--remote",
        remoteUrl,
        "--cache-dir",
        cache,
        "--output",
        output,
      ],
      {
        env: {
          ...process.env,
          DIFFSPLAIN_REAL_PATH: process.env.PATH,
          PATH: `${bin}:${process.env.PATH}`,
        },
      },
    );

    const calls = (await readFile(recorded, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const fetch = calls.find((call) => call.args.includes("fetch"));
    assert.ok(fetch, "expected a git fetch of the GitHub HTTPS remote");
    assert.ok(fetch.args.includes(remoteUrl));
    assert.deepEqual(
      fetch.args.slice(
        fetch.args.indexOf("-c"),
        fetch.args.indexOf("-c") + 2,
      ),
      ["-c", "credential.helper=!gh auth git-credential"],
    );
    assert.ok(!fetch.args.includes("credential.helper="));
    assert.equal(fetch.prompt, "0");
    const payload = JSON.parse(await readFile(output, "utf8"));
    assert.equal(payload.change.number, 35);
    assert.deepEqual(payload.files.map((file) => file.path), ["feature.txt"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("does not send gh credentials over GitHub HTTP remotes", async () => {
  const fixture = await makeRemoteRepo();
  const bin = join(fixture.root, "bin");
  const recorded = join(fixture.root, "git-args.jsonl");
  const output = join(fixture.root, "pr.json");
  const cache = join(fixture.root, "cache");
  const remoteUrl = "http://github.com/example/project.git";
  const fileRemote = `file://${fixture.remote}`;

  try {
    await mkdir(bin);
    await writeFile(
      join(bin, "gh"),
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({
        number: 35,
        title: "Remote feature",
        url: "https://github.com/example/project/pull/35",
        state: "OPEN",
        updatedAt: "2026-01-01T00:00:00Z",
        isCrossRepository: false,
        baseRefName: "main",
        baseRefOid: fixture.mainOid,
        headRefName: "feature",
        headRefOid: fixture.featureOid,
      })}'\n`,
    );
    await chmod(join(bin, "gh"), 0o755);
    await writeFile(
      join(bin, "git"),
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(recorded)}, JSON.stringify({ args }) + "\\n");
const rewritten = args.map((arg) =>
  arg === ${JSON.stringify(remoteUrl)} ? ${JSON.stringify(fileRemote)} : arg
);
const result = spawnSync("git", rewritten, {
  env: { ...process.env, PATH: process.env.DIFFSPLAIN_REAL_PATH },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
    );
    await chmod(join(bin, "git"), 0o755);
    execFileSync("git", [
      "--git-dir",
      fixture.remote,
      "update-ref",
      "refs/pull/35/head",
      fixture.featureOid,
    ]);

    run(
      fixture.repo,
      [
        "--pr",
        "35",
        "--remote",
        remoteUrl,
        "--cache-dir",
        cache,
        "--output",
        output,
      ],
      {
        env: {
          ...process.env,
          DIFFSPLAIN_REAL_PATH: process.env.PATH,
          PATH: `${bin}:${process.env.PATH}`,
        },
      },
    );

    const calls = (await readFile(recorded, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const fetch = calls.find((call) => call.args.includes("fetch"));
    assert.ok(fetch, "expected a git fetch of the GitHub HTTP remote");
    assert.ok(fetch.args.includes(remoteUrl));
    assert.ok(!fetch.args.includes("credential.helper=!gh auth git-credential"));
    assert.ok(!fetch.args.includes("credential.helper="));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("builds a pull request range through gh without changing the checkout", async () => {
  const fixture = await makeRemoteRepo();
  const bin = join(fixture.root, "bin");
  const gh = join(bin, "gh");
  const ghCall = join(fixture.root, "gh-call.json");
  const output = join(fixture.root, "pr.json");
  const cache = join(fixture.root, "cache");
  const before = checkoutState(fixture.repo);
  const pullRequest = {
    number: 7,
    title: "Remote feature",
    url: "https://github.com/example/project/pull/7",
    baseRefName: "main",
    baseRefOid: fixture.mainOid,
    headRefName: "feature",
    headRefOid: fixture.featureOid,
  };

  try {
    const remoteUrl = "https://github.com/example/diffsplain.git";
    git(fixture.repo, "remote", "set-url", "origin", remoteUrl);
    git(fixture.repo, "config", `url.file://${fixture.remote}.insteadOf`, remoteUrl);
    await mkdir(bin);
    await writeFile(
      gh,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(ghCall)}, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
}));
process.stdout.write(${JSON.stringify(`${JSON.stringify(pullRequest)}\n`)});
`,
    );
    await chmod(gh, 0o755);
    execFileSync("git", ["--git-dir", fixture.remote, "update-ref", "refs/pull/7/head", fixture.featureOid]);

    run(
      fixture.repo,
      ["--pr", "7", "--cache-dir", cache, "--output", output],
      {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    const payload = JSON.parse(await readFile(output, "utf8"));
    const invocation = JSON.parse(await readFile(ghCall, "utf8"));

    assert.equal(await realpath(invocation.cwd), await realpath(fixture.repo));
    assert.deepEqual(invocation.args.slice(0, 3), ["pr", "view", "7"]);
    assert.deepEqual(invocation.args.slice(-2), ["--repo", "example/diffsplain"]);
    assert.deepEqual(payload.files.map((file) => file.path), ["feature.txt"]);
    assert.equal(payload.repo.base, fixture.baseOid);
    assert.equal(payload.repo.head, fixture.featureOid);
    assert.equal(payload.repo.remote, "origin");
    assert.equal(payload.change.number, 7);
    assert.equal(payload.change.title, "Remote feature");
    assert.equal(payload.change.url, "https://github.com/example/project/pull/7");
    assert.deepEqual(checkoutState(fixture.repo), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("stops remote and pull-request lookups without replacing complete data", async () => {
  const fixture = await makeRemoteRepo();
  const output = join(fixture.root, "complete.json");
  const cache = join(fixture.root, "cache");
  const original = '{"complete":true}\n';
  const bin = join(fixture.root, "bin");
  const gh = join(bin, "gh");

  try {
    await writeFile(output, original);
    const missingBranch = spawnSync(
      process.execPath,
      [
        script,
        "--repo",
        fixture.repo,
        "--branch",
        "missing",
        "--cache-dir",
        cache,
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(missingBranch.status, 0);
    assert.match(missingBranch.stderr, /Could not fetch the remote target/i);
    assert.equal(await readFile(output, "utf8"), original);

    await mkdir(bin);
    await writeFile(gh, "#!/bin/sh\necho unavailable >&2\nexit 1\n");
    await chmod(gh, 0o755);
    const missingPullRequest = spawnSync(
      process.execPath,
      [
        script,
        "--repo",
        fixture.repo,
        "--pr",
        "7",
        "--cache-dir",
        cache,
        "--output",
        output,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    assert.notEqual(missingPullRequest.status, 0);
    assert.match(
      missingPullRequest.stderr,
      /Could not read pull request 7 with gh.*unavailable/i,
    );
    assert.equal(await readFile(output, "utf8"), original);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("watches local changes without changing the selected target", async () => {
  const fixture = await makeRemoteRepo();
  const localOutput = join(fixture.root, "local-watch.json");
  const firstContent = "local update\n";
  const secondContent = "fresh update\n";
  let watched;

  try {
    assert.equal(Buffer.byteLength(firstContent), Buffer.byteLength(secondContent));
    watched = startWatcher(
      fixture.repo,
      [
        "--checkout",
        "--watch",
        "--output",
        localOutput,
      ],
    );
    await waitForSnapshot(
      localOutput,
      watched,
      (payload) => payload.repo.target.kind === "checkout",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(join(fixture.repo, "watched.txt"), firstContent);
    const local = await waitForSnapshot(
      localOutput,
      watched,
      (payload) => payload.files.some((file) => file.path === "watched.txt"),
    );
    assert.equal(local.repo.target.kind, "checkout");

    await writeFile(join(fixture.repo, "watched.txt"), secondContent);
    const refreshed = await waitForSnapshot(
      localOutput,
      watched,
      (payload) =>
        payload.files
          .find((file) => file.path === "watched.txt")
          ?.patch.includes("fresh update"),
    );
    assert.equal(refreshed.repo.target.kind, "checkout");
  } finally {
    await stopIfRunning(watched);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("does not run text converters while watching local changes", async () => {
  const fixture = await makeRemoteRepo();
  const localOutput = join(fixture.root, "textconv-watch.json");
  const marker = join(fixture.root, "textconv-ran");
  let watched;

  try {
    await writeFile(join(fixture.repo, ".gitattributes"), "converted.txt diff=marker\n");
    await writeFile(join(fixture.repo, "converted.txt"), "before\n");
    git(fixture.repo, "add", ".gitattributes", "converted.txt");
    git(fixture.repo, "commit", "-qm", "add converted file");
    git(
      fixture.repo,
      "config",
      "diff.marker.textconv",
      `sh -c 'touch ${marker}; cat'`,
    );
    await writeFile(join(fixture.repo, "converted.txt"), "after\n");

    watched = startWatcher(fixture.repo, ["--checkout", "--watch", "--output", localOutput]);
    await waitForSnapshot(localOutput, watched, () => true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(existsSync(marker), false);
    assert.equal(watched.child.exitCode, null);
  } finally {
    await stopIfRunning(watched);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("watches same-size untracked rewrites with a fixed timestamp", async () => {
  const fixture = await makeRemoteRepo();
  const localOutput = join(fixture.root, "same-time-watch.json");
  const watchedPath = join(fixture.repo, "same-time.txt");
  const fixedTime = new Date("2020-01-02T03:04:05.000Z");
  const firstContent = "first value\n";
  const secondContent = "later value\n";
  let watched;

  try {
    assert.equal(Buffer.byteLength(firstContent), Buffer.byteLength(secondContent));
    await writeFile(watchedPath, firstContent);
    await utimes(watchedPath, fixedTime, fixedTime);
    watched = startWatcher(fixture.repo, ["--checkout", "--watch", "--output", localOutput]);
    await waitForSnapshot(
      localOutput,
      watched,
      (payload) => payload.files
        .find((file) => file.path === "same-time.txt")
        ?.patch.includes("first value"),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    await writeFile(watchedPath, secondContent);
    await utimes(watchedPath, fixedTime, fixedTime);
    const refreshed = await waitForSnapshot(
      localOutput,
      watched,
      (payload) => payload.files
        .find((file) => file.path === "same-time.txt")
        ?.patch.includes("later value"),
    );
    assert.equal(refreshed.repo.target.kind, "checkout");
  } finally {
    await stopIfRunning(watched);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("watches untracked symlinks without reading their targets", async (t) => {
  const fixture = await makeRemoteRepo();
  const localOutput = join(fixture.root, "symlink-watch.json");
  const outside = join(fixture.root, "outside");
  const link = join(fixture.repo, "outside-link");
  let watched;

  try {
    await mkdir(outside);
    const unavailable = await createDirectorySymlink(outside, link);
    if (unavailable) {
      t.skip(`symlink creation is unavailable: ${unavailable}`);
      return;
    }
    watched = startWatcher(fixture.repo, ["--checkout", "--watch", "--output", localOutput]);
    const snapshot = await waitForSnapshot(
      localOutput,
      watched,
      (payload) => payload.files.some((file) => file.path === "outside-link"),
    );
    assert.equal(snapshot.files.find((file) => file.path === "outside-link")?.status, "added");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(watched.child.exitCode, null);
  } finally {
    await stopIfRunning(watched);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exits cleanly when a fingerprint path disappears during polling", async () => {
  const fixture = await makeRemoteRepo();
  const localOutput = join(fixture.root, "fingerprint-race-watch.json");
  const bin = join(fixture.root, "git-proxy");
  const proxy = join(bin, "git");
  const marker = join(fixture.root, "delete-on-ls-files");
  const raced = join(fixture.repo, "raced.txt");
  let watched;

  try {
    await writeFile(raced, "race\n");
    await mkdir(bin);
    await writeFile(
      proxy,
      `#!/usr/bin/env node
const { existsSync, unlinkSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const result = spawnSync(process.env.DIFFSPLAIN_REAL_GIT, args, { encoding: "utf8" });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
if (args.includes("ls-files") && existsSync(process.env.DIFFSPLAIN_RACE_MARKER)) {
  unlinkSync(process.env.DIFFSPLAIN_RACE_PATH);
}
process.exit(result.status ?? 1);
`,
    );
    await chmod(proxy, 0o755);
    watched = startWatcher(
      fixture.repo,
      ["--checkout", "--watch", "--output", localOutput],
      {
        env: {
          DIFFSPLAIN_RACE_MARKER: marker,
          DIFFSPLAIN_RACE_PATH: raced,
          DIFFSPLAIN_REAL_GIT: process.env.PATH.split(":").map((path) => join(path, "git")).find(existsSync),
          PATH: `${bin}:${process.env.PATH}`,
        },
      },
    );
    await waitForSnapshot(localOutput, watched, () => true);
    await writeFile(marker, "delete the next fingerprint path\n");
    await waitFor(() => watched.child.exitCode !== null);
    assert.equal(watched.child.exitCode, 1);
    assert.match(watched.logs(), /ENOENT: no such file or directory, lstat/);
    assert.equal((watched.logs().match(/ENOENT: no such file or directory, lstat/g) || []).length, 1);
    assert.doesNotMatch(watched.logs(), /\n\s*at /);
  } finally {
    await stopIfRunning(watched);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("periodically refreshes remote targets without changing the checkout", async () => {
  const fixture = await makeRemoteRepo();
  const remoteOutput = join(fixture.root, "remote-watch.json");
  const cache = join(fixture.root, "cache");
  let watched;

  try {
    const before = checkoutState(fixture.repo);
    watched = startWatcher(
      fixture.repo,
      [
        "--branch",
        "feature",
        "--cache-dir",
        cache,
        "--watch",
        "--output",
        remoteOutput,
      ],
    );
    const initial = await waitForSnapshot(
      remoteOutput,
      watched,
      (payload) => Boolean(payload.repo.head),
    );
    const refreshedHead = await publishFeatureUpdate(
      fixture,
      "watched-remote.txt",
      "remote update\n",
    );
    const refreshed = await waitForSnapshot(
      remoteOutput,
      watched,
      (payload) => payload.repo.head === refreshedHead,
    );
    assert.notEqual(initial.repo.head, refreshed.repo.head);
    assert.equal(refreshed.repo.target.kind, "branch");
    assert.deepEqual(checkoutState(fixture.repo), before);
  } finally {
    await stopIfRunning(watched);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects conflicting remote target flags", async () => {
  const fixture = await makeRemoteRepo();

  try {
    const result = spawnSync(
      process.execPath,
      [script, "--repo", fixture.repo, "--branch", "feature", "--pr", "7"],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--branch.*--pr|--pr.*--branch/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
