#!/usr/bin/env node

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  todoDemoChange,
  todoDemoFiles,
} from "../site/todo-demo.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedAt = "2026-07-29T06:30:00.000Z";
const fingerprint = createHash("sha256")
  .update(JSON.stringify({ change: todoDemoChange, files: todoDemoFiles }))
  .digest("hex");

const snapshot = {
  version: fingerprint.slice(0, 12),
  generatedAt,
  repo: {
    name: "todo-list-demo",
    root: "/demo/todo-list",
    base: "main",
    head: "feature/todo-filters",
    branch: "feature/todo-filters",
    baseBranch: "main",
    target: {
      kind: "pull-request",
    },
  },
  change: todoDemoChange,
  notes: {
    reviewFingerprint: fingerprint,
    generatedFor: fingerprint,
    fresh: true,
    complete: true,
    status: "complete",
    completedFiles: todoDemoFiles.length,
    totalFiles: todoDemoFiles.length,
    agent: "codex",
    model: "gpt-5.6-sol",
  },
  files: todoDemoFiles,
};

const summaries = {
  change: todoDemoChange,
  files: Object.fromEntries(
    todoDemoFiles.map((file) => [file.path, file.summary]),
  ),
};

await Promise.all([
  writeFile(
    resolve(root, "public/demo-diff-data.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  ),
  writeFile(
    resolve(root, "data/todo-demo-summaries.json"),
    `${JSON.stringify(summaries, null, 2)}\n`,
  ),
]);

console.log(`Wrote todo demo with ${todoDemoFiles.length} files`);
