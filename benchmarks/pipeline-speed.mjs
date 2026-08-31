#!/usr/bin/env node

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const selectedCase = option("--case", "all");
const fixtureKind = option("--fixture", "working");
const runs = Number(option("--runs", "5"));
const batchSize = Number(option("--batch-size", "4"));
const jobs = Number(option("--jobs", "3"));
const agentDelay = Number(option("--agent-delay", "120"));
const resultFile = option("--result-file");
const keepFixture = args.includes("--keep-fixture");
const snapshotReuse = args.includes("--snapshot-reuse");

if (!["all", "build", "summary", "present", "restart"].includes(selectedCase)) {
  throw new Error("--case must be all, build, summary, present, or restart");
}
if (!["working", "heldout"].includes(fixtureKind)) {
  throw new Error("--fixture must be working or heldout");
}
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error("--runs must be a positive integer");
}

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  });
}

function git(repo, ...gitArgs) {
  return run("git", ["-C", repo, ...gitArgs]);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function stats(values) {
  return {
    minMs: Math.round(Math.min(...values) * 10) / 10,
    medianMs: Math.round(percentile(values, 0.5) * 10) / 10,
    p95Ms: Math.round(percentile(values, 0.95) * 10) / 10,
    maxMs: Math.round(Math.max(...values) * 10) / 10,
    samplesMs: values.map((value) => Math.round(value * 10) / 10),
  };
}

function makeFixture(base) {
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "benchmark@example.test");
  git(repo, "config", "user.name", "Benchmark");
  git(repo, "config", "commit.gpgsign", "false");

  const fileCount = fixtureKind === "working" ? 60 : 11;
  const lineCount = fixtureKind === "working" ? 36 : 1_800;
  for (let index = 0; index < fileCount; index += 1) {
    const path = join(repo, `file-${String(index).padStart(3, "0")}.txt`);
    const lines = Array.from(
      { length: lineCount },
      (_, line) => `before ${index} ${line}`,
    );
    writeFileSync(path, `${lines.join("\n")}\n`);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");

  for (let index = 0; index < fileCount; index += 1) {
    const path = join(repo, `file-${String(index).padStart(3, "0")}.txt`);
    const lines = Array.from(
      { length: lineCount },
      (_, line) =>
        line % 3 === 0 ? `after ${index} ${line}` : `before ${index} ${line}`,
    );
    writeFileSync(path, `${lines.join("\n")}\n`);
  }
  if (fixtureKind === "heldout") {
    writeFileSync(
      join(repo, "new-file.txt"),
      `${"new heldout line\n".repeat(2_500)}`,
    );
    git(repo, "mv", "file-000.txt", "renamed-file.txt");
  }
  return repo;
}

function makeTools(base) {
  const bin = join(base, "bin");
  const calls = join(base, "agent-calls.jsonl");
  const gitCalls = join(base, "git-calls.log");
  const benchmarkNote = fixtureKind === "working"
    ? {
        title: "Scope cache keys by branch",
        summary: "Adds the branch name to each cache key.",
        why: "Keeps notes from one branch out of another branch.",
        highlights: ["Existing cache entries remain readable."],
        risks: [],
      }
    : {
        title: "Keep history across a rename",
        summary: "Links the old path to the rename target.",
        why: "Keeps file history visible after the path changes.",
        highlights: ["The new path owns later notes."],
        risks: [],
      };
  mkdirSync(bin);

  const fakeAgent = join(bin, "fake-codex.mjs");
  writeFileSync(
    fakeAgent,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const started = Date.now();
const inputText = readFileSync(0, "utf8");
const input = JSON.parse(inputText);
const delay = ${JSON.stringify(agentDelay)} + input.files.length * 4;
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
appendFileSync(
  ${JSON.stringify(calls)},
  JSON.stringify({
    started,
    ended: Date.now(),
    files: input.files.map((file) => file.path),
    inputBytes: Buffer.byteLength(inputText),
    args: process.argv.slice(2),
  }) + "\\n",
);
process.stdout.write(JSON.stringify({
  change: ${JSON.stringify(benchmarkNote)},
  files: input.files.map((file) => ({
    path: file.path,
    title: "Update " + file.path,
    what: "Updates benchmark content.",
    why: "Measures summary generation.",
    details: [],
    risks: [],
  })),
}));
`,
  );
  chmodSync(fakeAgent, 0o755);

  const browser = join(bin, "browser");
  writeFileSync(browser, "#!/bin/sh\nexit 0\n");
  chmodSync(browser, 0o755);

  const gitWrapper = join(bin, "git");
  writeFileSync(
    gitWrapper,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(gitCalls)}
exec /usr/bin/git "$@"
`,
  );
  chmodSync(gitWrapper, 0o755);

  return {
    fakeAgent,
    calls,
    gitCalls,
    env: {
      ...process.env,
      BROWSER: browser,
      PATH: `${bin}:${process.env.PATH}`,
    },
  };
}

function clear(file) {
  writeFileSync(file, "");
}

function lines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

function timed(command, commandArgs, options) {
  const started = performance.now();
  run(command, commandArgs, options);
  return performance.now() - started;
}

async function stopChild(child) {
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function waitForPresenter(commandArgs, env, targetLine) {
  const started = performance.now();
  const outputIndex = commandArgs.indexOf("--output");
  const watchedOutput =
    outputIndex === -1 ? undefined : commandArgs[outputIndex + 1];
  const child = spawn(process.execPath, commandArgs, {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  const events = {};
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    consume(chunk.toString());
  });
  child.stdout.on("data", (chunk) => consume(chunk.toString()));

  let resolveTarget;
  let rejectTarget;
  const target = new Promise((resolvePromise, rejectPromise) => {
    resolveTarget = resolvePromise;
    rejectTarget = rejectPromise;
  });
  const timeout = setTimeout(() => {
    rejectTarget(new Error(`Timed out waiting for ${targetLine}\n${stderr}`));
  }, 30_000);
  const outputPoll = setInterval(() => {
    if (
      watchedOutput &&
      events.snapshotMs === undefined &&
      existsSync(watchedOutput)
    ) {
      events.snapshotMs = performance.now() - started;
    }
  }, 5);

  function consume(text) {
    buffer += text;
    const complete = buffer.split("\n");
    buffer = complete.pop() || "";
    for (const line of complete) {
      const elapsed = performance.now() - started;
      if (line.startsWith("Diffsplain:")) events.serverMs ??= elapsed;
      if (
        line.startsWith("Wrote ") &&
        !line.includes("agent notes")
      ) {
        events.snapshotMs ??= elapsed;
      }
      if (line.startsWith("Asking ")) events.askingMs ??= elapsed;
      if (
        targetLine === "snapshot" &&
        events.snapshotMs !== undefined
      ) {
        resolveTarget(events);
      }
      if (
        targetLine === "asking" &&
        events.askingMs !== undefined
      ) {
        resolveTarget(events);
      }
    }
  }

  try {
    return await target;
  } finally {
    clearTimeout(timeout);
    clearInterval(outputPoll);
    await stopChild(child);
  }
}

function restartPresenter(repo, output, summaries, tools) {
  return spawn(
    process.execPath,
    [
      resolve(projectRoot, "scripts/present.mjs"),
      "--repo",
      repo,
      "--worktree",
      "--agent",
      "codex",
      "--codex-bin",
      tools.fakeAgent,
      "--summaries",
      summaries,
      "--output",
      output,
      "--port",
      "0",
    ],
    {
      cwd: projectRoot,
      env: tools.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function watchAgentRequests(child, onRequest) {
  let buffer = "";
  let stderr = "";
  const consume = (text) => {
    buffer += text;
    const complete = buffer.split("\n");
    buffer = complete.pop() || "";
    if (complete.some((line) => line.startsWith("Asking "))) onRequest();
  };
  child.stdout.on("data", (chunk) => consume(chunk.toString()));
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    consume(chunk.toString());
  });
  return () => stderr;
}

function snapshotHasMarker(output, marker) {
  if (!existsSync(output)) return false;
  const snapshot = JSON.parse(readFileSync(output, "utf8"));
  return Boolean(
    snapshot.notes?.complete &&
      snapshot.notes.generatedFor === snapshot.notes.reviewFingerprint &&
      snapshot.files?.some((file) => file.patch?.includes(marker)),
  );
}

async function measureRestart(repo, output, tools, runNumber) {
  const summaries = join(
    dirname(output),
    `restart-${runNumber}-summaries.json`,
  );
  const probe = join(repo, "restart-probe.txt");
  rmSync(summaries, { force: true });
  rmSync(probe, { force: true });
  clear(tools.calls);
  const child = restartPresenter(repo, output, summaries, tools);
  let editedAt;
  let editTimer;
  let marker;
  const started = performance.now();
  const edit = () => {
    if (editedAt !== undefined) return;
    editedAt = performance.now();
    marker = `restart marker ${runNumber} ${Date.now()}`;
    writeFileSync(probe, `${marker}\n`);
  };
  const stderr = watchAgentRequests(child, () => {
    if (editedAt === undefined && editTimer === undefined) {
      editTimer = setTimeout(edit, 250);
    }
  });

  try {
    const deadline = performance.now() + 25_000;
    while (performance.now() < deadline) {
      if (editedAt !== undefined && snapshotHasMarker(output, marker)) {
        return {
          elapsedMs: performance.now() - editedAt,
          totalMs: performance.now() - started,
          agentCalls: lines(tools.calls).length,
        };
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    throw new Error(`Timed out waiting for restarted notes\n${stderr()}`);
  } finally {
    clearTimeout(editTimer);
    await stopChild(child);
    rmSync(probe, { force: true });
  }
}

const temporary = mkdtempSync(join(tmpdir(), "diffsplain-speed-"));
const repo = makeFixture(temporary);
const tools = makeTools(temporary);
const output = join(temporary, "diff-data.json");
const summaries = join(temporary, "summaries.json");
const result = {
  fixture: fixtureKind,
  files: Number(git(repo, "status", "--short").trim().split("\n").length),
  runs,
  batchSize,
  jobs,
};

try {
  if (selectedCase === "all" || selectedCase === "build") {
    const samples = [];
    const callCounts = [];
    for (let index = 0; index < runs; index += 1) {
      clear(tools.gitCalls);
      samples.push(
        timed(
          process.execPath,
          [
            resolve(projectRoot, "scripts/build-diff-data.mjs"),
            "--repo",
            repo,
            "--worktree",
            "--output",
            output,
          ],
          { cwd: projectRoot, env: tools.env },
        ),
      );
      callCounts.push(lines(tools.gitCalls).length);
    }
    result.build = {
      ...stats(samples),
      medianGitCalls: percentile(callCounts, 0.5),
      gitCallSamples: callCounts,
    };
  }

  if (selectedCase === "all" || selectedCase === "summary") {
    if (snapshotReuse) {
      run(
        process.execPath,
        [
          resolve(projectRoot, "scripts/build-diff-data.mjs"),
          "--repo",
          repo,
          "--worktree",
          "--output",
          output,
        ],
        { cwd: projectRoot, env: tools.env },
      );
    }
    const samples = [];
    const callCounts = [];
    const inputBytes = [];
    for (let index = 0; index < runs; index += 1) {
      clear(tools.calls);
      clear(tools.gitCalls);
      const summaryArgs = [
        resolve(projectRoot, "scripts/generate-summaries.mjs"),
        "--repo",
        repo,
        "--worktree",
        "--agent",
        "codex",
        "--codex-bin",
        tools.fakeAgent,
        "--batch-size",
        String(batchSize),
        "--jobs",
        String(jobs),
        "--force",
        "--summaries",
        summaries,
        "--output",
        output,
      ];
      if (snapshotReuse) summaryArgs.push("--snapshot", output);
      samples.push(
        timed(
          process.execPath,
          summaryArgs,
          { cwd: projectRoot, env: tools.env },
        ),
      );
      const agentCalls = lines(tools.calls).map((line) => JSON.parse(line));
      callCounts.push(agentCalls.length);
      inputBytes.push(
        agentCalls.reduce((total, call) => total + call.inputBytes, 0),
      );
    }
    result.summary = {
      ...stats(samples),
      medianAgentCalls: percentile(callCounts, 0.5),
      agentCallSamples: callCounts,
      medianInputBytes: percentile(inputBytes, 0.5),
      inputByteSamples: inputBytes,
    };
    const generated = JSON.parse(readFileSync(summaries, "utf8")).change;
    result.generatedNote = {
      title: generated.title,
      what: generated.summary,
      why: generated.why,
      details: generated.highlights,
      risks: generated.risks,
    };
  }

  if (selectedCase === "all" || selectedCase === "present") {
    run("npm", ["run", "build"], {
      cwd: projectRoot,
      env: tools.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const snapshotSamples = [];
    const askingSamples = [];
    const fixedWaitSamples = [];
    for (let index = 0; index < runs; index += 1) {
      const liveOutput = join(temporary, `present-${index}.json`);
      const events = await waitForPresenter(
        [
          resolve(projectRoot, "scripts/present.mjs"),
          "--repo",
          repo,
          "--worktree",
          "--no-agent",
          "--output",
          liveOutput,
          "--port",
          "0",
        ],
        tools.env,
        "snapshot",
      );
      snapshotSamples.push(events.snapshotMs);

      const agentOutput = join(temporary, `agent-present-${index}.json`);
      const agentEvents = await waitForPresenter(
        [
          resolve(projectRoot, "scripts/present.mjs"),
          "--repo",
          repo,
          "--worktree",
          "--agent",
          "codex",
          "--codex-bin",
          tools.fakeAgent,
          "--force",
          "--output",
          agentOutput,
          "--port",
          "0",
        ],
        tools.env,
        "asking",
      );
      askingSamples.push(agentEvents.askingMs);
      fixedWaitSamples.push(
        agentEvents.askingMs - agentEvents.snapshotMs,
      );
    }
    result.present = {
      snapshot: stats(snapshotSamples),
      asking: stats(askingSamples),
      snapshotToAsking: stats(fixedWaitSamples),
    };
  }

  if (selectedCase === "all" || selectedCase === "restart") {
    run("npm", ["run", "build"], {
      cwd: projectRoot,
      env: tools.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const samples = [];
    const callCounts = [];
    for (let index = 0; index < runs; index += 1) {
      const liveOutput = join(temporary, `restart-${index}.json`);
      const measurement = await measureRestart(
        repo,
        liveOutput,
        tools,
        index,
      );
      samples.push(measurement.elapsedMs);
      callCounts.push(measurement.agentCalls);
    }
    result.restart = {
      ...stats(samples),
      medianAgentCalls: percentile(callCounts, 0.5),
      agentCallSamples: callCounts,
    };
  }

  const encodedResult = `${JSON.stringify(result, null, 2)}\n`;
  if (resultFile) writeFileSync(resolve(resultFile), encodedResult);
  process.stdout.write(encodedResult);
} finally {
  if (keepFixture) {
    appendFileSync(
      join(projectRoot, "benchmark-fixtures.log"),
      `${temporary}\n`,
    );
  } else {
    rmSync(temporary, { recursive: true, force: true });
  }
}
