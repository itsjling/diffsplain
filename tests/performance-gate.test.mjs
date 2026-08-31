import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL(
  "../benchmarks/performance-gate.mjs",
  import.meta.url,
).pathname;
const baselinePath = new URL(
  "../benchmarks/performance-baseline.json",
  import.meta.url,
).pathname;
const qualityFixturesPath = new URL(
  "../benchmarks/quality-fixtures.json",
  import.meta.url,
).pathname;

test("reports every deterministic performance and quality case", () => {
  const output = execFileSync(
    process.execPath,
    [script, "--dry-run"],
    { encoding: "utf8" },
  );
  const result = JSON.parse(output);

  for (const fixture of ["working", "heldout"]) {
    assert.deepEqual(
      Object.keys(result.measurements[fixture]),
      ["build", "summary", "present", "agent-start", "restart"],
    );
    assert.deepEqual(
      Object.keys(result.quality[fixture]),
      ["useful", "incomplete", "false", "duplicate", "empty"],
    );
    assert.equal(result.quality[fixture].useful.actualPass, true);
    assert.equal(result.quality[fixture].false.actualPass, false);
  }
  assert.match(
    result.measurements.working.present.stop,
    /not browser rendering/,
  );
  assert.equal(
    result.measurements.working["agent-start"].stop,
    "first coding-agent request",
  );
  assert.equal(result.provider, "deterministic-fake");
  assert.equal(result.sampleRules.warmupSamples, 1);
  assert.equal(result.sampleRules.measuredSamples, 5);
  assert.equal(result.passed, true);
});

test("runs one named performance case", () => {
  const output = execFileSync(
    process.execPath,
    [script, "--dry-run", "--case", "summary"],
    { encoding: "utf8" },
  );
  const result = JSON.parse(output);

  assert.deepEqual(Object.keys(result.measurements.working), ["summary"]);
  assert.deepEqual(Object.keys(result.measurements.heldout), ["summary"]);
});

test("runs the agent startup performance case", () => {
  const output = execFileSync(
    process.execPath,
    [script, "--dry-run", "--case", "agent-start"],
    { encoding: "utf8" },
  );
  const result = JSON.parse(output);

  assert.deepEqual(
    Object.keys(result.measurements.working),
    ["agent-start"],
  );
  assert.equal(
    result.measurements.working["agent-start"].thresholdMs,
    1_000,
  );
});

test("names the failed fixture, metric, and threshold", () => {
  const temporary = mkdtempSync(join(tmpdir(), "diffsplain-gate-"));
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  baseline.speedMs.working.build = 0;
  const path = join(temporary, "baseline.json");
  writeFileSync(path, JSON.stringify(baseline));

  try {
    const result = spawnSync(
      process.execPath,
      [script, "--dry-run", "--case", "build", "--baseline", path],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /working build medianMs 1 exceeded 0/,
    );
    const output = JSON.parse(result.stdout);
    assert.deepEqual(
      {
        target: output.failures[0].target,
        metric: output.failures[0].metric,
      },
      { target: "working", metric: "build" },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("scores notes produced by the benchmark pipeline", () => {
  const temporary = mkdtempSync(join(tmpdir(), "diffsplain-gate-"));
  const fixtures = JSON.parse(readFileSync(qualityFixturesPath, "utf8"));
  const generatedNotes = Object.fromEntries(
    ["working", "heldout"].map((fixture) => [
      fixture,
      fixtures[fixture].find((entry) => entry.name === "useful").note,
    ]),
  );
  generatedNotes.working = {
    title: "Updates the cache key.",
    what: "Updates the cache key.",
    why: "Updates the cache key.",
    details: [],
    risks: [],
  };
  const notesPath = join(temporary, "generated-notes.json");
  writeFileSync(notesPath, JSON.stringify(generatedNotes));

  try {
    const result = spawnSync(
      process.execPath,
      [script, "--dry-run", "--generated-notes", notesPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.quality.working.pipeline.actualPass, false);
    assert.equal(output.quality.heldout.pipeline.actualPass, true);
    assert.deepEqual(
      output.failures
        .filter((failure) => failure.rubric === "pipeline")
        .map((failure) => failure.target),
      ["working"],
    );

    delete generatedNotes.heldout;
    writeFileSync(notesPath, JSON.stringify(generatedNotes));
    const missing = spawnSync(
      process.execPath,
      [script, "--dry-run", "--generated-notes", notesPath],
      { encoding: "utf8" },
    );
    assert.equal(missing.status, 1);
    const missingOutput = JSON.parse(missing.stdout);
    assert.equal(missingOutput.quality.heldout.pipeline.actualPass, false);
    assert.ok(
      missingOutput.failures.some(
        (failure) =>
          failure.target === "heldout" &&
          failure.rubric === "pipeline",
      ),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
