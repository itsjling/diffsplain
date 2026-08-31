import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import AxeBuilder from "@axe-core/playwright";

import { runInBrowser, startViteServer } from "./browser-harness.mjs";

const access = "a".repeat(43);
let fixtureDirectory;
let output;
let server;

function file(path, { agentExcluded = false, oldPath } = {}) {
  return {
    path,
    ...(oldPath ? { oldPath } : {}),
    status: "modified",
    additions: 2,
    deletions: 1,
    isBinary: false,
    isTruncated: false,
    totalDiffLines: 8,
    patch: [
      `diff --git a/${path} b/${path}`,
      "index 0000000..1111111 100644",
      `--- a/${oldPath ?? path}`,
      `+++ b/${path}`,
      "@@ -1 +1,2 @@",
      "-before",
      "+after",
    ].join("\n"),
    snippet: "@@ -1 +1 @@\n-before\n+after",
    ...(agentExcluded ? { agentExcluded } : {}),
    summary: {
      title: `Note for ${path}`,
      what: "The fixture keeps the review pane usable while chat changes.",
      why: "The browser test uses a local, deterministic review.",
      details: ["The file has a stable path and patch."],
      risks: [],
    },
  };
}

function reviewSnapshot() {
  const files = [
    file("src/new-name.ts", { oldPath: "src/old-name.ts" }),
    file("src/other.ts"),
    file("secret.txt", { agentExcluded: true }),
  ];
  return {
    version: "chat-browser-fixture",
    generatedAt: "2026-08-28T00:00:00.000Z",
    repo: {
      name: "chat-browser-fixture",
      root: "/fixture/chat-browser-fixture",
      base: "main",
      head: "fixture-head",
      branch: "feature/chat",
      target: { kind: "worktree" },
    },
    change: {
      title: "Review chat browser fixture",
      summary: "A fixed review for browser chat coverage.",
      why: "The UI needs a stable review surface.",
      highlights: [],
      risks: [],
    },
    notes: {
      fresh: true,
      complete: true,
      status: "complete",
      completedFiles: files.length,
      totalFiles: files.length,
      agent: "codex",
      model: "gpt-5.6-sol",
    },
    files,
  };
}

function chatState({
  available = true,
  error,
  snapshotReady = true,
  threads = [],
} = {}) {
  return {
    available,
    fingerprint: snapshotReady ? "fixture-fingerprint" : null,
    ...(error ? { error } : {}),
    snapshotReady,
    inputLimitBytes: 96 * 1024,
    stale: threads.some((thread) => thread.status === "stale"),
    threads,
  };
}

function thread({
  current = true,
  id,
  messages = [],
  path,
  pendingQuestion,
  scope = "file",
  status = "ready",
  error,
  canRetry = false,
  canRetryCompaction = false,
}) {
  return {
    id,
    current,
    scope,
    ...(scope === "file" ? { path } : {}),
    status,
    messages,
    ...(pendingQuestion ? { pendingQuestion } : {}),
    ...(error ? { error } : {}),
    canRetry,
    canRetryCompaction,
  };
}

function targetMatches(threadValue, command) {
  return (
    threadValue.scope === command.scope &&
    (command.scope === "review" || threadValue.path === command.path)
  );
}

function axeFindings(results) {
  return results.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    targets: nodes.flatMap((node) => node.target),
  }));
}

async function writeSnapshot(value) {
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`);
}

async function emitReviewChatEvent(page, type, data = "{}") {
  await page.evaluate(
    (event) => window.reviewChatEvents.emit(event.type, event.data),
    { data, type },
  );
}

async function emitChat(page) {
  await emitReviewChatEvent(page, "chat");
}

async function selectChat(page) {
  await page.getByRole("button", { name: "Ask agent" }).click();
  await page.getByRole("heading", { name: "Ask the agent" }).waitFor();
}

async function selectedPath(page) {
  return page.locator(".current-path").textContent();
}

before(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "diffsplain-review-chat-browser-"));
  output = join(fixtureDirectory, "diff-data.json");
  await writeSnapshot(reviewSnapshot());
  server = await startViteServer({
    env: {
      DIFFSPLAIN_LIVE_OUTPUT: output,
      FORCE_COLOR: "1",
    },
  });
});

after(async () => {
  await server?.stop();
  if (fixtureDirectory && existsSync(fixtureDirectory)) {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
});

test("keeps chat threads, markdown, recovery, and review controls inside the summary pane", async () => {
  await runInBrowser(
    "review chat journey",
    { viewport: { width: 1280, height: 800 } },
    // fallow-ignore-next-line complexity -- This journey carries one review through every chat state.
    async (page) => {
      const commands = [];
      const requestedAccesses = [];
      let allowChatFetch = false;
      let failNextAskAfterAccept = false;
      let nextThread = 1;
      let state = chatState();

      await page.addInitScript((currentAccess) => {
        class ControlledEventSource extends EventTarget {
          static instances = [];

          constructor(url) {
            super();
            this.closed = false;
            this.url = String(url);
            ControlledEventSource.instances.push(this);
            queueMicrotask(() => {
              this.dispatchEvent(new MessageEvent("ready", { data: "{}" }));
              this.dispatchEvent(
                new MessageEvent("access", { data: currentAccess }),
              );
            });
          }

          close() {
            this.closed = true;
          }
        }

        window.EventSource = ControlledEventSource;
        window.reviewChatEvents = {
          emit(type, data = "{}") {
            const event =
              type === "error"
                ? new Event(type)
                : new MessageEvent(type, { data });
            ControlledEventSource.instances.at(-1)?.dispatchEvent(event);
          },
        };
      }, access);

      // fallow-ignore-next-line complexity -- This route fixture models every command against one shared thread state.
      await page.route("**/api/chat?*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        requestedAccesses.push(url.searchParams.get("access"));
        if (request.method() === "GET") {
          if (!allowChatFetch) {
            await route.fulfill({
              json: { error: "The chat server is starting." },
              status: 503,
            });
            return;
          }
          await route.fulfill({ json: state });
          return;
        }

        const command = JSON.parse(request.postData() ?? "{}");
        commands.push(command);
        let current = state.threads.find(
          (threadValue) => threadValue.current && targetMatches(threadValue, command),
        );

        if (command.type === "new") {
          for (const threadValue of state.threads) {
            if (threadValue.current && targetMatches(threadValue, command)) {
              threadValue.current = false;
              threadValue.status = "stale";
            }
          }
          current = thread({
            id: `thread-${nextThread++}`,
            path: command.path,
            scope: command.scope,
          });
          state.threads.push(current);
        } else if (current && command.type === "ask") {
          current.messages.push({ role: "user", text: command.question });
          current.pendingQuestion = command.question;
          current.status = "running";
        } else if (current && command.type === "cancel") {
          current.status = "cancelled";
          current.canRetry = true;
        } else if (current && command.type === "retry") {
          current.status = "running";
          current.canRetry = false;
        } else if (current && command.type === "retry-compaction") {
          current.status = "compacting";
          current.canRetryCompaction = false;
        }

        if (command.type === "ask" && failNextAskAfterAccept) {
          failNextAskAfterAccept = false;
          await route.fulfill({
            json: { error: "The command response was lost." },
            status: 504,
          });
          return;
        }

        await route.fulfill({
          json: state,
          status: command.type === "ask" ? 202 : 200,
        });
      });

      await page.goto(`${server.url}#access=${access}`);
      await page.getByRole("heading", { name: "Note for src/new-name.ts" }).waitFor();
      await page.getByRole("button", { name: "Agent note" }).click();
      await page.getByText("Written by GPT 5.6 Sol (Codex)").waitFor();

      await selectChat(page);
      await page.getByRole("heading", { name: "Chat could not connect." }).waitFor();
      allowChatFetch = true;
      await page.getByRole("button", { name: "Try again" }).click();
      await page.getByRole("textbox", { name: "Ask about this file" }).waitFor();
      const fileScope = page.getByRole("button", { name: "This file" });
      assert.equal(await fileScope.getAttribute("aria-pressed"), "true");
      const fileQuestion = page.getByRole("textbox", { name: "Ask about this file" });

      await fileQuestion.fill("This draft must stay with src/new-name.ts.");
      await page.getByRole("button", { name: "Next file" }).click();
      assert.equal(await selectedPath(page), "src/other.ts");
      const otherFileQuestion = page.getByRole("textbox", { name: "Ask about this file" });
      await otherFileQuestion.waitFor();
      assert.equal(await otherFileQuestion.inputValue(), "");

      await otherFileQuestion.fill("This draft must stay with this file scope.");
      await page.getByRole("button", { name: "Review" }).click();
      const unsentReviewQuestion = page.getByRole("textbox", { name: "Ask about this review" });
      await unsentReviewQuestion.waitFor();
      assert.equal(await unsentReviewQuestion.inputValue(), "");

      await page.getByRole("button", { name: "This file" }).click();
      await page.getByRole("button", { name: "Previous file" }).click();
      assert.equal(await selectedPath(page), "src/new-name.ts");
      await fileQuestion.waitFor();
      await fileQuestion.fill("What changed in this file?");
      await fileQuestion.press("Control+K");
      assert.equal(await page.getByRole("dialog", { name: "Choose a changed file" }).count(), 0);
      await fileQuestion.press("Control+Enter");
      await page.getByRole("heading", { name: "Writing an answer" }).waitFor();
      const pulse = page.locator(".chat-status-pulse");
      assert.equal(await pulse.getAttribute("aria-hidden"), "true");
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(
        await pulse.evaluate((element) => getComputedStyle(element).animationName),
        "none",
      );
      await page.emulateMedia({ reducedMotion: "no-preference" });
      assert.deepEqual(commands.slice(0, 2), [
        { type: "new", scope: "file", path: "src/new-name.ts" },
        {
          type: "ask",
          scope: "file",
          path: "src/new-name.ts",
          question: "What changed in this file?",
        },
      ]);

      state.threads.push(
        thread({
          id: "review-running-in-background",
          pendingQuestion: "Check the full review.",
          scope: "review",
          status: "running",
        }),
      );
      await emitChat(page);
      await page.getByRole("button", { name: "Agent note" }).click();
      await page.getByText("Still answering about this file.").waitFor();
      await page.getByText("Still answering about the review.").waitFor();
      assert.equal(await page.locator(".chat-background-notice").count(), 2);
      await selectChat(page);
      await page.getByText("Still answering about the review.").waitFor();
      assert.equal(await page.locator(".chat-background-notice").count(), 1);
      state.threads = state.threads.filter(
        (threadValue) => threadValue.id !== "review-running-in-background",
      );
      await emitChat(page);

      await emitReviewChatEvent(page, "error");
      await page.getByRole("heading", { name: "Writing an answer" }).waitFor();
      const fileThread = state.threads.find((threadValue) => threadValue.current);
      fileThread.status = "ready";
      fileThread.pendingQuestion = undefined;
      fileThread.messages.push({
        role: "assistant",
        answer: {
          markdown: [
            "## Finding",
            "",
            "- A **safe** [reference](https://example.test/guide) now renders.",
            "- `const ready = true` stays inline.",
            "",
            "> The evidence stays in the diff.",
            "",
            "```ts",
            "const ready = true;",
            "const source = '<script>safe source</script>';",
            "```",
            "",
            "Line one",
            "Line two",
            "",
            '<img src=x onerror="globalThis.chatMarkdownXss = true">',
            "<script>globalThis.chatMarkdownXss = true</script>",
            "[unsafe](javascript:globalThis.chatMarkdownXss = true)",
            "![not-an-image](data:image/svg+xml,unsafe)",
          ].join("\n"),
          citations: [{ path: "src/new-name.ts", startLine: 6, endLine: 7 }],
        },
      });
      await emitReviewChatEvent(page, "ready");
      await page.getByRole("heading", { name: "Finding" }).waitFor();
      await page
        .getByRole("heading", { name: "Writing an answer" })
        .waitFor({ state: "hidden" });
      await page.getByRole("link", { name: "reference" }).waitFor();
      assert.equal(await page.locator(".safe-markdown img").count(), 0);
      assert.equal(await page.locator("a[href^='javascript:'], a[href^='data:']").count(), 0);
      assert.equal(await page.evaluate(() => window.chatMarkdownXss), undefined);
      await page.getByText("src/new-name.ts:6–7").waitFor();
      await page.locator(".safe-markdown blockquote").waitFor();
      await page.locator(".safe-markdown pre").waitFor();
      assert.match(
        String(await page.locator(".safe-markdown pre").textContent()),
        /<script>safe source<\/script>/,
      );

      await fileQuestion.fill("Keep working while I review another file.");
      await fileQuestion.press("Control+Enter");
      await page.getByRole("heading", { name: "Writing an answer" }).waitFor();
      await page.getByRole("button", { name: "Next file" }).click();
      assert.equal(await selectedPath(page), "src/other.ts");
      await page.getByText("Still answering about src/new-name.ts.").waitFor();
      await page.locator(".chat-background-notice").getByRole("button", { name: "Cancel" }).click();
      assert.deepEqual(commands.at(-1), {
        type: "cancel",
        scope: "file",
        path: "src/new-name.ts",
      });

      await page.getByRole("button", { name: "Review" }).click();
      const reviewQuestion = page.getByRole("textbox", { name: "Ask about this review" });
      await reviewQuestion.fill("How do the changes fit together?");
      failNextAskAfterAccept = true;
      await reviewQuestion.press("Control+Enter");
      await page.getByRole("heading", { name: "Writing an answer" }).waitFor();
      await page.getByRole("heading", { name: "Chat could not update." }).waitFor();
      assert.deepEqual(commands.slice(-2), [
        { type: "new", scope: "review" },
        {
          type: "ask",
          scope: "review",
          question: "How do the changes fit together?",
        },
      ]);

      state = chatState({
        threads: [
          thread({
            canRetry: true,
            error: "The provider stopped.",
            id: "review-failed",
            messages: [{ role: "user", text: "Retry this answer." }],
            pendingQuestion: "Retry this answer.",
            scope: "review",
            status: "failed",
          }),
        ],
      });
      await page.getByRole("heading", { name: "The answer failed" }).waitFor();
      await page.getByText("The provider stopped.").waitFor();
      assert.equal(
        commands.filter(
          (command) =>
            command.type === "ask" &&
            command.question === "How do the changes fit together?",
        ).length,
        1,
      );
      await page.getByRole("button", { name: "Retry" }).click();
      await page.getByRole("heading", { name: "Writing an answer" }).waitFor();
      assert.deepEqual(commands.at(-1), { type: "retry", scope: "review" });

      state = chatState({
        threads: [
          thread({
            canRetryCompaction: true,
            error: "Older messages need compaction.",
            id: "review-blocked",
            messages: [{ role: "user", text: "Use more history." }],
            pendingQuestion: "Use more history.",
            scope: "review",
            status: "blocked",
          }),
        ],
      });
      await emitChat(page);
      await page.getByRole("button", { name: "Retry compaction" }).click();
      await page.getByRole("heading", { name: "Compacting prior history" }).waitFor();
      assert.deepEqual(commands.at(-1), { type: "retry-compaction", scope: "review" });

      state = chatState({
        threads: [
          thread({
            error: "The newest messages do not fit.",
            id: "review-needs-new-thread",
            messages: [{ role: "user", text: "Too much context." }],
            pendingQuestion: "Too much context.",
            scope: "review",
            status: "blocked",
          }),
        ],
      });
      await emitChat(page);
      await page.getByRole("button", { name: "Start new thread" }).click();
      assert.deepEqual(commands.at(-1), { type: "new", scope: "review" });

      await page.getByRole("button", { name: "This file" }).click();
      await page.getByRole("button", { name: "Previous file" }).click();
      assert.equal(await selectedPath(page), "src/new-name.ts");
      state = chatState({
        threads: [
          thread({
            current: false,
            id: "old-file-thread",
            messages: [{ role: "user", text: "What used to be here?" }],
            path: "src/old-name.ts",
            status: "stale",
          }),
        ],
      });
      await emitChat(page);
      await page.getByText("Stale history").waitFor();
      const startRenamedThread = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/chat" && response.ok(),
      );
      await page.getByRole("button", { name: "Start new thread" }).click();
      await startRenamedThread;
      assert.deepEqual(commands.at(-1), {
        type: "new",
        scope: "file",
        path: "src/new-name.ts",
      });

      await page.getByRole("button", { name: "Next file" }).click();
      await page.getByRole("button", { name: "Next file" }).click();
      assert.equal(await selectedPath(page), "secret.txt");
      state = chatState();
      await emitChat(page);
      await page
        .getByText("Direct questions can include this file. Review-wide chat still respects exclusions.")
        .waitFor();
      const secretQuestion = page.getByRole("textbox", { name: "Ask about this file" });
      await secretQuestion.fill("Can this direct question include the excluded file?");
      await secretQuestion.press("Control+Enter");
      await page.getByRole("heading", { name: "Writing an answer" }).waitFor();
      assert.deepEqual(commands.slice(-2), [
        { type: "new", scope: "file", path: "secret.txt" },
        {
          type: "ask",
          scope: "file",
          path: "secret.txt",
          question: "Can this direct question include the excluded file?",
        },
      ]);

      state = chatState({
        error: "The current review snapshot is not available.",
        threads: [
          thread({
            id: "secret-history",
            messages: [{ role: "user", text: "Keep this visible." }],
            path: "secret.txt",
            pendingQuestion: "Keep this visible.",
            status: "running",
          }),
        ],
      });
      await emitChat(page);
      await page.getByRole("heading", { name: "Chat is waiting for the current review" }).waitFor();
      await page.getByText("Keep this visible.").waitFor();
      await page.getByRole("heading", { name: "Writing an answer" }).waitFor();
      await page.locator(".chat-thread-state").getByRole("button", { name: "Cancel" }).waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Ask about this file" }).count(), 0);
      state.threads[0].status = "ready";
      state.threads[0].pendingQuestion = undefined;
      state.error = undefined;
      await emitChat(page);
      await page.getByRole("textbox", { name: "Ask about this file" }).waitFor();

      state = chatState({ available: false });
      await emitChat(page);
      await page.getByRole("heading", { name: "No chat agent is available." }).waitFor();
      state = chatState();
      await emitChat(page);
      await page.getByRole("textbox", { name: "Ask about this file" }).waitFor();

      const longToken = "segment".repeat(48);
      state = chatState({
        error: `The current snapshot could not read ${longToken}.`,
        threads: [
          thread({
            id: "long-current-thread",
            messages: [
              {
                role: "user",
                text: `https://example.test/${longToken}`,
              },
            ],
            path: "secret.txt",
            pendingQuestion: `https://example.test/${longToken}`,
            status: "running",
          }),
          thread({
            id: "long-background-thread",
            path: `src/${longToken}.ts`,
            pendingQuestion: "Long path",
            status: "running",
          }),
        ],
      });
      await emitChat(page);
      await page.setViewportSize({ width: 320, height: 568 });
      await page.getByText(`https://example.test/${longToken}`).waitFor();
      const longContentDimensions = await page.evaluate(() => ({
        body: document.body.scrollWidth,
        root: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
      }));
      assert.ok(
        longContentDimensions.body <= longContentDimensions.viewport &&
          longContentDimensions.root <= longContentDimensions.viewport,
        `320px long-content overflow ${JSON.stringify(longContentDimensions)}`,
      );
      state = chatState();
      await emitChat(page);
      await page.getByRole("textbox", { name: "Ask about this file" }).waitFor();

      for (const width of [1280, 980, 680, 320]) {
        await page.setViewportSize({ width, height: width === 320 ? 568 : 800 });
        await page.getByRole("textbox", { name: "Ask about this file" }).scrollIntoViewIfNeeded();
        const dimensions = await page.evaluate(() => ({
          body: document.body.scrollWidth,
          root: document.documentElement.scrollWidth,
          viewport: document.documentElement.clientWidth,
        }));
        assert.ok(
          dimensions.body <= dimensions.viewport && dimensions.root <= dimensions.viewport,
          `${width}px overflow ${JSON.stringify(dimensions)}`,
        );
        for (const selector of [
          ".summary-mode-switch button",
          ".chat-scope-option",
          ".chat-send",
        ]) {
          const boxes = await page.locator(selector).evaluateAll((elements) =>
            elements.map((element) => element.getBoundingClientRect().height),
          );
          assert.ok(boxes.every((height) => height >= 44), `${selector} at ${width}px`);
        }
      }

      await page.setViewportSize({ width: 1280, height: 800 });
      assert.ok(requestedAccesses.every((value) => value === access));
      const axe = await new AxeBuilder({ page }).include(".summary-pane").analyze();
      assert.deepEqual(axeFindings(axe), []);
    },
    {
      ignoredConsoleError: (message) =>
        message.includes("503 (Service Unavailable)") ||
        message.includes("504 (Gateway Timeout)"),
      serverLog: () => server.log(),
    },
  );
});

test("waits for the current access handoff before it loads protected chat", async () => {
  await runInBrowser(
    "protected chat handoff",
    { viewport: { width: 1280, height: 800 } },
    // fallow-ignore-next-line complexity -- This covers the prior-token handoff and reconnect sequence.
    async (page) => {
      const previousAccess = "b".repeat(43);
      const currentAccess = access;
      const nextAccess = "c".repeat(43);
      const commands = [];
      const requestedAccesses = [];
      let acceptedAccess = currentAccess;
      let pauseNextNew = false;
      let markNewPaused;
      let resumeNew;
      const newPaused = new Promise((resolve) => {
        markNewPaused = resolve;
      });
      const newResumed = new Promise((resolve) => {
        resumeNew = resolve;
      });
      let state = chatState();

      await page.addInitScript(() => {
        class ControlledEventSource extends EventTarget {
          static instances = [];

          constructor(url) {
            super();
            this.closed = false;
            this.ready = false;
            this.url = String(url);
            ControlledEventSource.instances.push(this);
            queueMicrotask(() => {
              this.ready = true;
              this.dispatchEvent(new MessageEvent("ready", { data: "{}" }));
            });
          }

          close() {
            this.closed = true;
          }
        }

        window.EventSource = ControlledEventSource;
        window.reviewChatEvents = {
          emit(type, data = "{}") {
            const event =
              type === "error"
                ? new Event(type)
                : new MessageEvent(type, { data });
            ControlledEventSource.instances.at(-1)?.dispatchEvent(event);
          },
          state() {
            return ControlledEventSource.instances.map((source) => ({
              closed: source.closed,
              ready: source.ready,
              url: source.url,
            }));
          },
        };
      });

      // fallow-ignore-next-line complexity -- This route rejects the prior token and records each protected request.
      await page.route("**/api/chat?*", async (route) => {
        const request = route.request();
        const requestAccess = new URL(request.url()).searchParams.get("access");
        requestedAccesses.push(requestAccess);
        if (requestAccess !== acceptedAccess) {
          await route.fulfill({
            json: { error: "Forbidden" },
            status: 403,
          });
          return;
        }
        if (request.method() === "GET") {
          await route.fulfill({ json: state });
          return;
        }
        const command = JSON.parse(request.postData() ?? "{}");
        commands.push(command);
        if (command.type === "new" && pauseNextNew) {
          markNewPaused();
          await newResumed;
        }
        if (command.type === "new") {
          state = chatState({
            threads: [
              thread({
                id: "protected-thread",
                path: command.path,
                scope: command.scope,
              }),
            ],
          });
        } else if (command.type === "ask") {
          const current = state.threads.at(0);
          current.messages.push({ role: "user", text: command.question });
          current.pendingQuestion = command.question;
          current.status = "running";
        }
        await route.fulfill({
          json: state,
          status: command.type === "ask" ? 202 : 200,
        });
      });

      await page.goto(`${server.url}#access=${previousAccess}`);
      await page
        .getByRole("heading", { name: "Note for src/new-name.ts" })
        .waitFor();
      await page.waitForTimeout(100);
      assert.deepEqual(requestedAccesses, []);

      await emitReviewChatEvent(page, "access", currentAccess);
      await page.waitForFunction(
        (expectedAccess) => {
          const source = window.reviewChatEvents.state().at(-1);
          return (
            source?.ready &&
            new URL(source.url).searchParams.get("access") === expectedAccess
          );
        },
        currentAccess,
      );
      await emitReviewChatEvent(page, "access", currentAccess);
      await selectChat(page);
      const question = page.getByRole("textbox", {
        name: "Ask about this file",
      });
      await question.waitFor();
      assert.ok(requestedAccesses.length > 0);
      assert.ok(requestedAccesses.every((value) => value === currentAccess));

      await question.fill("Does the handoff protect this chat?");
      await question.press("Control+Enter");
      await page.getByRole("heading", { name: "Writing an answer" }).waitFor();
      assert.deepEqual(commands, [
        { type: "new", scope: "file", path: "src/new-name.ts" },
        {
          type: "ask",
          scope: "file",
          path: "src/new-name.ts",
          question: "Does the handoff protect this chat?",
        },
      ]);
      assert.ok(requestedAccesses.every((value) => value === currentAccess));

      await emitReviewChatEvent(page, "error");
      await page.waitForTimeout(100);
      await page.getByRole("heading", { name: "Writing an answer" }).waitFor();

      const restoredChat = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/chat" &&
          response.request().method() === "GET" &&
          new URL(response.url()).searchParams.get("access") === currentAccess,
      );
      await emitReviewChatEvent(page, "ready");
      await restoredChat;
      await page.getByRole("heading", { name: "Writing an answer" }).waitFor();
      assert.ok(requestedAccesses.every((value) => value === currentAccess));

      state = chatState({
        threads: [
          thread({
            id: "stale-protected-thread",
            path: "src/new-name.ts",
            scope: "file",
            status: "stale",
          }),
        ],
      });
      await emitReviewChatEvent(page, "chat");
      const startNewThread = page.getByRole("button", { name: "Start new thread" });
      await startNewThread.waitFor();
      pauseNextNew = true;
      const commandFinished = startNewThread.click();
      await newPaused;
      acceptedAccess = nextAccess;
      const currentChatLoaded = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/chat" &&
          response.request().method() === "GET" &&
          new URL(response.url()).searchParams.get("access") === nextAccess,
        { timeout: 2_000 },
      );
      await emitReviewChatEvent(page, "access", nextAccess);
      resumeNew();
      await commandFinished;
      await currentChatLoaded;
      await page.getByRole("textbox", { name: "Ask about this file" }).waitFor();
      assert.equal(requestedAccesses.at(-1), nextAccess);
    },
  );
});
