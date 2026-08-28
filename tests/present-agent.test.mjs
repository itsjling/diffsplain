import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { summaryPath } from "../scripts/summary-path.mjs";

const script = new URL("../scripts/present.mjs", import.meta.url).pathname;

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function waitFor(read, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error("Timed out waiting for presenter output");
}

function waitForOutput(child, pattern, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for presenter output: ${output}`));
    }, timeout);
    const onOutput = (chunk) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Presenter stopped before it was ready (${code ?? signal}): ${output}`,
        ),
      );
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Presenter did not stop after SIGTERM"));
    }, 15_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", reject);
  });
  child.kill("SIGTERM");
  return closed;
}

function agentCallCount(value) {
  return (value.match(/codex-after-feed/g) || []).length;
}

async function stopIfRunning(child) {
  if (child?.exitCode === null && child.signalCode === null) {
    await stop(child);
  }
}

test("starts the note agent after the watch snapshot and stops cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "diffsplain-present-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const output = join(root, "diff-data.json");
  const events = join(root, "events.log");
  const response = join(root, "response.json");
  const cacheBase = join(root, "cache");
  const summaries = summaryPath({
    cacheRoot: join(cacheBase, "diffsplain"),
    callerDirectory: root,
    repo,
  });
  let presenter;

  try {
    await writeFile(response, JSON.stringify({
      change: {
        title: "Change text",
        summary: "Updates one file.",
        why: "Exercises the presenter agent path.",
        highlights: [],
        risks: [],
      },
      files: [{
        path: "changed.txt",
        title: "Update text",
        what: "Replaces the old line.",
        why: "Changes the fixture value.",
        details: [],
        risks: [],
      }],
    }));
    await writeFile(events, "");
    await mkdir(repo);
    await mkdir(bin);

    git(repo, "init", "-q");
    git(repo, "config", "user.email", "diffsplain@example.test");
    git(repo, "config", "user.name", "Diffsplain");
    git(repo, "config", "commit.gpgsign", "false");
    await writeFile(join(repo, "changed.txt"), "before\n");
    git(repo, "add", "changed.txt");
    git(repo, "commit", "-qm", "base");
    await writeFile(join(repo, "changed.txt"), "after\n");

    await writeFile(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        `if [ -f ${JSON.stringify(output)} ]; then\n` +
        `  printf 'codex-after-feed\\n' >> ${JSON.stringify(events)}\n` +
        "else\n" +
        `  printf 'codex-before-feed\\n' >> ${JSON.stringify(events)}\n` +
        "fi\n" +
        `cat ${JSON.stringify(response)}\n`,
    );
    await writeFile(
      join(bin, "npm"),
      "#!/bin/sh\n" +
        "printf 'npm-started\\n' >> \"$PRESENTER_EVENTS\"\n" +
        "trap 'exit 0' TERM INT\n" +
        "while :; do sleep 1; done\n",
    );
    await writeFile(join(bin, "browser"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "codex"), 0o755);
    await chmod(join(bin, "npm"), 0o755);
    await chmod(join(bin, "browser"), 0o755);

    presenter = spawn(
      process.execPath,
      [
        script,
        "--repo",
        repo,
        "--worktree",
        "--agent",
        "codex",
        "--output",
        output,
        "--port",
        "0",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          BROWSER: join(bin, "browser"),
          PATH: `${bin}:${process.env.PATH}`,
          PRESENTER_EVENTS: events,
          PRESENTER_OUTPUT: output,
          PRESENTER_RESPONSE: response,
          XDG_CACHE_HOME: cacheBase,
        },
        stdio: "pipe",
      },
    );

    const note = await waitFor(async () => {
      const value = JSON.parse(await readFile(summaries, "utf8"));
      return value.files?.["changed.txt"] ? value : undefined;
    });
    assert.equal(note.files["changed.txt"].title, "Update text");

    const eventLog = await readFile(events, "utf8");
    assert.match(eventLog, /codex-after-feed/);
    assert.doesNotMatch(eventLog, /codex-before-feed/);

    const snapshot = await waitFor(async () => {
      const value = JSON.parse(await readFile(output, "utf8"));
      return value.files?.[0]?.summary?.title === "Update text" &&
        value.notes?.complete
        ? value
        : undefined;
    });
    assert.equal(snapshot.files[0].summary.title, "Update text");

    const result = await stop(presenter);
    presenter = undefined;
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);

    const firstRunLog = await readFile(events, "utf8");
    const firstRunCalls = agentCallCount(firstRunLog);
    assert.equal(firstRunCalls, 2);
    presenter = spawn(
      process.execPath,
      [
        script,
        "--repo",
        repo,
        "--worktree",
        "--agent",
        "codex",
        "--model",
        "changed-model",
        "--output",
        output,
        "--port",
        "0",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          BROWSER: join(bin, "browser"),
          PATH: `${bin}:${process.env.PATH}`,
          PRESENTER_EVENTS: events,
          PRESENTER_OUTPUT: output,
          PRESENTER_RESPONSE: response,
          XDG_CACHE_HOME: cacheBase,
        },
        stdio: "pipe",
      },
    );
    const restartLog = await waitFor(async () => {
      const value = await readFile(events, "utf8");
      return agentCallCount(value) === firstRunCalls + 2
        ? value
        : undefined;
    });
    assert.equal(agentCallCount(restartLog), firstRunCalls + 2);
    const changedModelSnapshot = await waitFor(async () => {
      const value = JSON.parse(await readFile(output, "utf8"));
      const noteState = [
        value.notes.complete,
        value.notes.fresh,
        value.notes.model,
      ].join(":");
      return noteState === "true:true:changed-model" ? value : undefined;
    });
    assert.equal(changedModelSnapshot.notes.agent, "codex");

    const restartResult = await stop(presenter);
    presenter = undefined;
    assert.equal(restartResult.code, 0);
    assert.equal(restartResult.signal, null);

    presenter = spawn(
      process.execPath,
      [
        script,
        "--repo",
        repo,
        "--worktree",
        "--agent",
        "codex",
        "--model",
        "changed-model",
        "--output",
        output,
        "--port",
        "0",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          BROWSER: join(bin, "browser"),
          PATH: `${bin}:${process.env.PATH}`,
          PRESENTER_EVENTS: events,
          PRESENTER_OUTPUT: output,
          PRESENTER_RESPONSE: response,
          XDG_CACHE_HOME: cacheBase,
        },
        stdio: "pipe",
      },
    );
    await waitForOutput(presenter, /^Reusing current agent notes\.$/m);
    const reuseLog = await readFile(events, "utf8");
    assert.equal(agentCallCount(reuseLog), firstRunCalls + 2);

    const reuseResult = await stop(presenter);
    presenter = undefined;
    assert.equal(reuseResult.code, 0);
    assert.equal(reuseResult.signal, null);
  } finally {
    await stopIfRunning(presenter);
    await rm(root, { recursive: true, force: true });
  }
});
