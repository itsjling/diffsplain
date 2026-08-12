import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import {
  parsedViteOutput,
  runInBrowser,
  startViteServer,
} from "./browser-harness.mjs";

let fixtureDirectory;
let output;
let server;
let serverUrl;

function snapshot(version, files) {
  return {
    version,
    generatedAt: "2026-07-31T00:00:00.000Z",
    repo: {
      name: "browser-fixture",
      root: "/fixture/browser-fixture",
      base: "main",
      head: "fixture-head",
      branch: "feature/browser-review",
      target: { kind: "worktree" },
    },
    change: {
      title: `Fixture review ${version}`,
      summary: "A deterministic browser fixture.",
      why: "Browser checks need no local repository or account.",
      highlights: [],
      risks: [],
    },
    notes: {
      fresh: true,
      complete: true,
      status: "complete",
      completedFiles: files.length,
      totalFiles: files.length,
    },
    files,
  };
}

function textFile(path, title, { truncated = false } = {}) {
  const patch = [
    `diff --git a/${path} b/${path}`,
    "index 0000000..1111111 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-before",
    `+${title} full patch`,
  ].join("\n");
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 1,
    isBinary: false,
    isTruncated: truncated,
    totalDiffLines: truncated ? 2_048 : 7,
    patch,
    snippet: truncated
      ? `${patch.split("\n").slice(0, 4).join("\n")}\n… diff truncated; read the full diff.`
      : patch,
    summary: {
      title,
      what: `${title} explains the changed behavior.`,
      why: "The fixture proves that notes remain readable.",
      details: ["The mock provider emits deterministic review data."],
      risks: ["The fixture risk is intentionally public."],
    },
  };
}

function binaryFile(version) {
  return {
    path: "assets/logo.png",
    status: "binary",
    additions: 0,
    deletions: 0,
    isBinary: true,
    isTruncated: false,
    totalDiffLines: 0,
    patch: "Binary files differ",
    snippet: "Binary files differ",
    summary: {
      title: `Binary note ${version}`,
      what: "The binary file stays in the review.",
      why: "Reviewers still need the note for non-text files.",
      details: ["The image bytes are not included in the test fixture."],
      risks: [],
    },
  };
}

function fixture(version = "one") {
  const files = [
    textFile("src/todos.ts", "Explain saved todos"),
    textFile("src/long-list.ts", "Explain the full patch", { truncated: true }),
    binaryFile(version),
  ];
  if (version !== "one") files[1].summary.title = `Live review ${version}`;
  return snapshot(version, files);
}

function longFileListFixture() {
  return snapshot(
    "long-file-list",
    Array.from({ length: 30 }, (_, index) =>
      textFile(
        `src/file-${String(index + 1).padStart(2, "0")}.ts`,
        `Explain file ${index + 1}`,
      ),
    ),
  );
}

function filteredFileListFixture() {
  return snapshot(
    "filtered-file-list",
    Array.from({ length: 60 }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return textFile(
        index % 2 === 1
          ? `src/match-file-${String((index + 1) / 2).padStart(2, "0")}.ts`
          : `src/other-file-${number}.ts`,
        `Explain file ${number}`,
      );
    }),
  );
}

async function writeSnapshot(value) {
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`);
}

function runReviewJourney(name, options, journey) {
  return runInBrowser(name, options, journey, {
    ignoredConsoleError: (message) =>
      message.includes("status of 503") || message.includes("status of 404"),
    serverLog: () => server.log(),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("parses Vite's URL when text and color codes cross output chunks", () => {
  let outputText = "";
  for (const chunk of [
    "\u001b[3",
    "2m  ➜  Loc",
    "al:\u001b[0",
    "m   http://127.0.0.1:4173/\n",
  ]) {
    outputText += chunk;
  }

  assert.equal(parsedViteOutput(outputText).url, "http://127.0.0.1:4173/");
});

async function selectFile(page, search) {
  await page.locator(".file-picker-trigger").click();
  await page.getByRole("dialog", { name: "Choose a changed file" }).waitFor();
  const input = page.getByRole("textbox", { name: "Filter changed files" });
  await input.fill(search);
  await page.getByRole("button", { name: new RegExp(search, "i") }).click();
}

async function dispatchTouchGesture(locator, start, end) {
  await locator.evaluate(
    (element, points) => {
      const touch = (point) =>
        new Touch({
          identifier: 1,
          target: element,
          clientX: point.x,
          clientY: point.y,
          pageX: point.x,
          pageY: point.y,
          screenX: point.x,
          screenY: point.y,
          radiusX: 2,
          radiusY: 2,
          rotationAngle: 0,
          force: 0.5,
        });
      const startTouch = touch(points.start);
      element.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          cancelable: true,
          changedTouches: [startTouch],
          targetTouches: [startTouch],
          touches: [startTouch],
        }),
      );
      const endTouch = touch(points.end);
      element.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          cancelable: true,
          changedTouches: [endTouch],
          targetTouches: [],
          touches: [],
        }),
      );
    },
    { start, end },
  );
}

async function selectedFilePath(page) {
  return page.locator(".current-path").textContent();
}

async function hasFocus(locator) {
  return locator.evaluate((element) => document.activeElement === element);
}

async function checkKeyboardFileNavigation(page) {
  const next = page.getByRole("button", { name: "Next file" });
  await next.focus();
  await next.press("Enter");
  await page.getByRole("heading", { name: "Live review interaction" }).waitFor();
  assert.equal(await hasFocus(next), true);

  await next.press("ArrowLeft");
  await page.getByRole("heading", { name: "Explain saved todos" }).waitFor();
  assert.equal(await hasFocus(next), true);
}

function pickerControls(page) {
  return {
    close: page.getByRole("button", { name: "Close file picker" }),
    dialog: page.getByRole("dialog", { name: "Choose a changed file" }),
    search: page.getByRole("textbox", { name: "Filter changed files" }),
    trigger: page.locator(".file-picker-trigger"),
  };
}

async function assertTouchTarget(locator) {
  const box = await locator.boundingBox();
  assert.ok(box);
  assert.ok(box.width >= 44);
  assert.ok(box.height >= 44);
}

async function checkPickerSemantics(page, controls) {
  const { close, dialog, trigger } = controls;
  assert.match(
    String(await trigger.getAttribute("aria-label")),
    /Choose file\. Current file 1 of 3/,
  );
  await trigger.focus();
  await trigger.press("Enter");
  await dialog.waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "Filter changed files",
  );
  assert.equal(await dialog.getAttribute("aria-modal"), "true");
  assert.equal(
    await page.locator(".picker-row[aria-current='true']").count(),
    1,
  );
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector(".picker-search"))
        .backgroundColor !== "rgba(0, 0, 0, 0)",
  );
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector(".picker-dialog")).transform ===
      "none",
  );
  await assertTouchTarget(close);
  await assertTouchTarget(page.locator(".picker-row").first());
}

async function checkPickerFocusLoop(page, controls) {
  const { close, dialog, search, trigger } = controls;
  await close.focus();
  await close.press("Shift+Tab");
  const lastRow = page.locator(".picker-row").last();
  assert.equal(await hasFocus(lastRow), true);
  await lastRow.press("Tab");
  assert.equal(await hasFocus(close), true);

  await search.focus();
  await search.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.classList.contains("file-picker-trigger"),
  );
  assert.equal(await hasFocus(trigger), true);

  await selectSummaryHeading(page);
  await trigger.press("ArrowRight");
  await page.waitForFunction(
    () =>
      document.querySelector(".current-path")?.textContent ===
      "src/long-list.ts",
  );
  assert.equal(await hasFocus(trigger), true);

  await trigger.press("Enter");
  await dialog.waitFor();
  await close.click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.classList.contains("file-picker-trigger"),
  );
  await selectSummaryHeading(page);
  await trigger.press("ArrowRight");
  await page.waitForFunction(
    () =>
      document.querySelector(".current-path")?.textContent ===
      "assets/logo.png",
  );
  assert.equal(await hasFocus(trigger), true);

  await trigger.press("Enter");
  await dialog.waitFor();
  await page.locator(".picker-backdrop").click({
    position: { x: 5, y: 5 },
  });
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.classList.contains("file-picker-trigger"),
  );
  await selectSummaryHeading(page);
  await trigger.press("ArrowRight");
  await page.waitForFunction(
    () =>
      document.querySelector(".current-path")?.textContent === "src/todos.ts",
  );
  assert.equal(await hasFocus(trigger), true);
}

async function chooseLongFile(page, controls) {
  await controls.trigger.press("Enter");
  await controls.dialog
    .getByRole("button", { name: /src\/long-list\.ts/i })
    .click();
  await page.getByRole("heading", { name: "Live review interaction" }).waitFor();
  await page.waitForFunction(
    () => document.activeElement?.classList.contains("file-picker-trigger"),
  );
}

async function assertGestureIgnored(page, locator, start, end) {
  const path = await selectedFilePath(page);
  await dispatchTouchGesture(locator, start, end);
  assert.equal(await selectedFilePath(page), path);
}

async function selectSummaryHeading(page) {
  await page.locator(".summary-pane h2").evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function checkProtectedTouchGestures(page, controls) {
  await assertGestureIgnored(
    page,
    page.locator(".diff-scroll"),
    { x: 280, y: 300 },
    { x: 140, y: 305 },
  );
  await assertGestureIgnored(
    page,
    page.getByRole("button", { name: "Read full diff" }),
    { x: 280, y: 120 },
    { x: 140, y: 125 },
  );

  await selectSummaryHeading(page);
  await assertGestureIgnored(
    page,
    page.locator(".summary-scroll"),
    { x: 280, y: 600 },
    { x: 140, y: 605 },
  );
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await assertGestureIgnored(
    page,
    page.locator(".summary-scroll"),
    { x: 180, y: 500 },
    { x: 260, y: 650 },
  );

  await controls.trigger.press("Enter");
  await assertGestureIgnored(
    page,
    controls.dialog,
    { x: 280, y: 300 },
    { x: 140, y: 305 },
  );
  await controls.search.press("Escape");
}

before(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "diffsplain-browser-fixture-"));
  output = join(fixtureDirectory, "diff-data.json");
  server = await startViteServer({
    env: {
      DIFFSPLAIN_LIVE_OUTPUT: output,
      FORCE_COLOR: "1",
    },
  });
  serverUrl = server.url;
});

after(async () => {
  await server?.stop();
  if (fixtureDirectory && existsSync(fixtureDirectory)) {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("shows error, empty, binary, truncated, and refreshed review states on desktop", async () => {
  await runReviewJourney("desktop review journey", { viewport: { width: 1280, height: 800 } }, async (page) => {
    await page.goto(serverUrl);
    await page.getByText("Snapshot returned 503").waitFor();

    await writeSnapshot(snapshot("empty", []));
    await page.getByRole("heading", { name: "No changed files." }).waitFor();

    await writeSnapshot(fixture());
    await page.getByRole("heading", { name: "Explain saved todos" }).waitFor();
    await page.getByText("The fixture risk is intentionally public.").waitFor();
    await page.waitForFunction(
      () =>
        document.title ===
        "browser-fixture · feature/browser-review — Diffsplain",
    );

    const pullRequest = fixture();
    pullRequest.version = "pull-request";
    pullRequest.change.number = 42;
    pullRequest.repo.target.kind = "pull-request";
    await writeSnapshot(pullRequest);
    await page.waitForFunction(
      () => document.title === "browser-fixture · PR #42 — Diffsplain",
    );

    const branchReview = fixture();
    branchReview.version = "branch-review";
    await writeSnapshot(branchReview);

    await selectFile(page, "long-list");
    await page.getByRole("button", { name: "Read full diff" }).click();
    await page.getByText("Explain the full patch full patch").waitFor();

    await selectFile(page, "logo.png");
    await page.getByText("The file contents cannot appear as text.").waitFor();
    await page.getByRole("heading", { name: "Binary note one" }).waitFor();

    await writeSnapshot(fixture("two"));
    await page.getByRole("heading", { name: "Binary note two" }).waitFor();
  });
});

test("keeps the newest live snapshot through late responses and faults", async () => {
  await runReviewJourney(
    "ordered live refresh",
    { viewport: { width: 1280, height: 800 } },
    async (page) => {
      await writeSnapshot(fixture("ordered-one"));
      await page.goto(serverUrl);
      await page.getByRole("heading", { name: "Explain saved todos" }).waitFor();
      await selectFile(page, "long-list");
      await page
        .getByRole("heading", { name: "Live review ordered-one" })
        .waitFor();

      const staleCaptured = deferred();
      const releaseStale = deferred();
      const staleDelivered = deferred();
      let holdNext = true;
      const delaySnapshot = async (route) => {
        if (!holdNext) {
          await route.continue();
          return;
        }
        holdNext = false;
        const response = await route.fetch();
        const body = await response.body();
        staleCaptured.resolve();
        await releaseStale.promise;
        await route.fulfill({ response, body });
        staleDelivered.resolve();
      };
      await page.route("**/diff-data.json?*", delaySnapshot);

      await writeSnapshot(fixture("ordered-stale"));
      await staleCaptured.promise;
      await writeSnapshot(fixture("ordered-newest"));
      await page
        .getByRole("heading", { name: "Live review ordered-newest" })
        .waitFor();
      releaseStale.resolve();
      await staleDelivered.promise;
      await page.unroute("**/diff-data.json?*", delaySnapshot);
      await page.waitForTimeout(100);

      await page
        .getByRole("heading", { name: "Live review ordered-newest" })
        .waitFor();
      assert.equal(
        await page.locator(".current-path").textContent(),
        "src/long-list.ts",
      );

      await page.route(
        "**/diff-data.json?*",
        (route) =>
          route.fulfill({
            body: JSON.stringify({ error: "temporary failure" }),
            contentType: "application/json",
            status: 503,
          }),
        { times: 1 },
      );
      await writeSnapshot(fixture("failed-refresh"));
      await page.getByText("Snapshot returned 503").waitFor();
      await page
        .getByRole("heading", { name: "Live review ordered-newest" })
        .waitFor();

      await writeSnapshot(fixture("recovered"));
      await page.getByRole("heading", { name: "Live review recovered" }).waitFor();
      await page.getByText("Snapshot returned 503").waitFor({ state: "hidden" });

      await page.route(
        "**/diff-data.json?*",
        (route) =>
          route.fulfill({
            body: "{not valid JSON",
            contentType: "application/json",
            status: 200,
          }),
        { times: 1 },
      );
      await writeSnapshot(fixture("malformed-refresh"));
      await page.getByText("Snapshot data is malformed").waitFor();
      await page.getByRole("heading", { name: "Live review recovered" }).waitFor();

      await writeSnapshot(fixture("after-malformed"));
      await page
        .getByRole("heading", { name: "Live review after-malformed" })
        .waitFor();

      await page.route(
        "**/diff-data.json?*",
        (route) =>
          route.fulfill({
            body: "Not found",
            contentType: "text/plain",
            status: 404,
          }),
        { times: 1 },
      );
      await writeSnapshot(fixture("missing-refresh"));
      await page.getByText("Live snapshot is missing").waitFor();
      await page
        .getByRole("heading", { name: "Live review after-malformed" })
        .waitFor();

      await writeSnapshot(fixture("after-missing"));
      await page
        .getByRole("heading", { name: "Live review after-missing" })
        .waitFor();
      await page.getByText("Live snapshot is missing").waitFor({ state: "hidden" });

      const duplicate = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/diff-data.json" &&
          response.ok(),
      );
      await writeSnapshot(fixture("after-missing"));
      await duplicate;
      assert.equal(
        await page
          .getByRole("heading", { name: "Live review after-missing" })
          .count(),
        1,
      );
      assert.equal(
        await page.locator(".current-path").textContent(),
        "src/long-list.ts",
      );
    },
  );
});

test("keeps a pending success when a newer refresh fails", async () => {
  await runReviewJourney(
    "pending successful refresh",
    { viewport: { width: 1280, height: 800 } },
    async (page) => {
      await writeSnapshot(fixture("pending-base"));
      await page.goto(serverUrl);
      await page.getByRole("heading", { name: "Explain saved todos" }).waitFor();
      await selectFile(page, "long-list");

      const successCaptured = deferred();
      const releaseSuccess = deferred();
      const successDelivered = deferred();
      const delaySuccess = async (route) => {
        const response = await route.fetch();
        const body = await response.body();
        successCaptured.resolve();
        await releaseSuccess.promise;
        await route.fulfill({ response, body });
        successDelivered.resolve();
      };
      await page.route("**/diff-data.json?*", delaySuccess);
      await writeSnapshot(fixture("pending-success"));
      await successCaptured.promise;

      await page.route(
        "**/diff-data.json?*",
        (route) =>
          route.fulfill({
            body: JSON.stringify({ error: "newer request failed" }),
            contentType: "application/json",
            status: 503,
          }),
        { times: 1 },
      );
      await writeSnapshot(fixture("newer-failure"));
      await page.getByText("Snapshot returned 503").waitFor();

      releaseSuccess.resolve();
      await successDelivered.promise;
      await page.unroute("**/diff-data.json?*", delaySuccess);
      await page
        .getByRole("heading", { name: "Live review pending-success" })
        .waitFor();
      await page.getByText("Snapshot returned 503").waitFor({ state: "hidden" });
      assert.equal(
        await page.locator(".current-path").textContent(),
        "src/long-list.ts",
      );
    },
  );
});

test("recovers from event faults without resetting the selected file", async () => {
  await runReviewJourney(
    "event stream recovery",
    { viewport: { width: 1280, height: 800 } },
    async (page) => {
      await page.addInitScript(() => {
        class ControlledEventSource extends EventTarget {
          static instances = [];

          constructor(url) {
            super();
            this.closed = false;
            this.url = String(url);
            ControlledEventSource.instances.push(this);
            queueMicrotask(() => {
              this.dispatchEvent(
                new MessageEvent("ready", { data: "{}" }),
              );
            });
          }

          close() {
            this.closed = true;
          }
        }

        window.EventSource = ControlledEventSource;
        window.controlledEvents = {
          emit(type, data = "{}") {
            const source = ControlledEventSource.instances.at(-1);
            const event =
              type === "error"
                ? new Event(type)
                : new MessageEvent(type, { data });
            source.dispatchEvent(event);
          },
          state() {
            return ControlledEventSource.instances.map((source) => ({
              closed: source.closed,
              url: source.url,
            }));
          },
        };
      });

      await writeSnapshot(fixture("stream-one"));
      await page.goto(serverUrl);
      await page.getByRole("heading", { name: "Explain saved todos" }).waitFor();
      await selectFile(page, "long-list");
      await page.getByRole("heading", { name: "Live review stream-one" }).waitFor();

      const slowSnapshot = async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_900));
        await route.continue();
      };
      await page.route("**/diff-data.json?*", slowSnapshot);
      await page.evaluate(() => window.controlledEvents.emit("error"));
      await page.getByText("Live updates disconnected").waitFor();
      await writeSnapshot(fixture("stream-polled"));
      await page
        .getByRole("heading", { name: "Live review stream-polled" })
        .waitFor();
      await page.unroute("**/diff-data.json?*", slowSnapshot);

      const malformedRefresh = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/diff-data.json" &&
          response.ok(),
      );
      await page.evaluate(() =>
        window.controlledEvents.emit("update", "not-json"),
      );
      await malformedRefresh;
      await page.getByText("A live update was malformed").waitFor();
      let recoveredRequests = 0;
      const countRecoveredRequests = async (route) => {
        recoveredRequests += 1;
        await route.continue();
      };
      await page.route("**/diff-data.json?*", countRecoveredRequests);
      await writeSnapshot(fixture("stream-two"));
      await page.evaluate(() => window.controlledEvents.emit("update"));
      await page
        .getByText("A live update was malformed")
        .waitFor({ state: "hidden" });
      await page.getByRole("heading", { name: "Live review stream-two" }).waitFor();
      await page.waitForTimeout(1_700);
      assert.equal(recoveredRequests, 1);
      await page.unroute("**/diff-data.json?*", countRecoveredRequests);

      await page.evaluate(() => {
        window.controlledEvents.emit("update");
        window.controlledEvents.emit("update");
      });
      await page.getByRole("heading", { name: "Live review stream-two" }).waitFor();
      assert.equal(
        await page.locator(".current-path").textContent(),
        "src/long-list.ts",
      );

      const priorEventSources = await page.evaluate(() =>
        window.controlledEvents.state(),
      );
      await page.evaluate(() => {
        window.location.hash = "project=next-target";
      });
      await page.getByRole("heading", { name: "Live review stream-two" }).waitFor();
      const eventSources = await page.evaluate(() =>
        window.controlledEvents.state(),
      );
      assert.equal(eventSources.length, priorEventSources.length + 1);
      assert.equal(eventSources.at(-2).closed, true);
      assert.match(eventSources.at(-1).url, /project=next-target/);
      assert.equal(
        await page.locator(".current-path").textContent(),
        "src/long-list.ts",
      );

      const access = "a".repeat(43);
      await page.evaluate(
        (nextAccess) => window.controlledEvents.emit("access", nextAccess),
        access,
      );
      await page.waitForFunction(
        (nextAccess) =>
          window.controlledEvents.state().at(-1)?.url.includes(nextAccess),
        access,
      );
      const accessEventSources = await page.evaluate(() =>
        window.controlledEvents.state(),
      );
      assert.equal(accessEventSources.at(-2).closed, true);
      assert.match(accessEventSources.at(-1).url, /project=next-target/);
      assert.match(accessEventSources.at(-1).url, new RegExp(`access=${access}`));
      assert.equal(
        new URLSearchParams(new URL(page.url()).hash.slice(1)).get("access"),
        access,
      );
      assert.equal(
        await page.locator(".current-path").textContent(),
        "src/long-list.ts",
      );
    },
  );
});

test("runs the full picker and refresh journey at the supported mobile viewport", async () => {
  await runReviewJourney(
    "mobile review journey",
    { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } },
    async (page) => {
      await writeSnapshot(fixture("mobile-one"));
      await page.goto(serverUrl);
      await page.getByRole("heading", { name: "Explain saved todos" }).waitFor();

      await selectFile(page, "long-list");
      await page.getByRole("heading", { name: "Live review mobile-one" }).waitFor();
      await page.getByRole("button", { name: "Read full diff" }).click();
      await page.getByText("Explain the full patch full patch").waitFor();
      await page.getByText("The fixture risk is intentionally public.").waitFor();

      await writeSnapshot(fixture("mobile-two"));
      await page.getByRole("heading", { name: "Live review mobile-two" }).waitFor();
    },
  );
});

test("keeps the supported narrow layouts within the viewport", async () => {
  for (const width of [320, 390]) {
    await runInBrowser(
      `${width}-pixel review layout`,
      {
        hasTouch: true,
        isMobile: true,
        viewport: { width, height: width === 320 ? 740 : 844 },
      },
      async (page) => {
        await writeSnapshot(fixture(`narrow-${width}`));
        await page.goto(serverUrl);
        await page.getByRole("heading", { name: "Explain saved todos" }).waitFor();

        const widths = await page.evaluate(() => ({
          body: document.body.scrollWidth,
          root: document.documentElement.scrollWidth,
          viewport: document.documentElement.clientWidth,
        }));
        assert.ok(
          widths.root <= widths.viewport && widths.body <= widths.viewport,
          `page width ${JSON.stringify(widths)}`,
        );
      },
    );
  }
});

test("keeps narrow-screen touch and keyboard navigation usable", async () => {
  await runInBrowser(
    "narrow-screen interactions",
    { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } },
    async (page) => {
      await writeSnapshot(fixture("interaction"));
      await page.goto(serverUrl);
      await page.getByRole("heading", { name: "Explain saved todos" }).waitFor();

      await checkKeyboardFileNavigation(page);
      const controls = pickerControls(page);
      await checkPickerSemantics(page, controls);
      await checkPickerFocusLoop(page, controls);
      await chooseLongFile(page, controls);
      await checkProtectedTouchGestures(page, controls);
      await dispatchTouchGesture(
        page.locator(".summary-scroll"),
        { x: 280, y: 600 },
        { x: 140, y: 605 },
      );
      await page.getByRole("heading", { name: "Binary note interaction" }).waitFor();
    },
  );
});

test("centers the selected file when reopening the picker", async () => {
  await runReviewJourney(
    "center selected picker file",
    { viewport: { width: 1280, height: 800 } },
    async (page) => {
      await writeSnapshot(longFileListFixture());
      await page.goto(serverUrl);
      await page.getByRole("heading", { name: "Explain file 1" }).waitFor();

      const controls = pickerControls(page);
      await controls.trigger.click();
      const selectedRow = page.getByRole("button", {
        name: /src\/file-30\.ts/i,
      });
      await selectedRow.click();
      await page.getByRole("heading", { name: "Explain file 30" }).waitFor();

      await controls.trigger.click();
      await controls.dialog.waitFor();
      await page.waitForFunction(() => {
        const list = document.querySelector(".picker-list");
        const active = document.querySelector(".picker-row--active");
        if (!list || !active) return false;
        const listBounds = list.getBoundingClientRect();
        const activeBounds = active.getBoundingClientRect();
        const listCenter = listBounds.top + listBounds.height / 2;
        const activeCenter = activeBounds.top + activeBounds.height / 2;
        return Math.abs(listCenter - activeCenter) <= 1;
      });
    },
  );
});

test("keeps filtered picker indexes and full-snapshot keyboard navigation aligned", async () => {
  await runReviewJourney(
    "filtered picker indexes",
    { viewport: { width: 1280, height: 800 } },
    async (page) => {
      await writeSnapshot(filteredFileListFixture());
      await page.goto(serverUrl);
      await page.getByRole("heading", { name: "Explain file 01" }).waitFor();

      const controls = pickerControls(page);
      await controls.trigger.click();
      await controls.search.fill("match-file");
      const selectedRow = page.getByRole("button", {
        name: /src\/match-file-30\.ts/i,
      });
      assert.equal(
        await page.locator(".picker-row").first().locator(".picker-index").textContent(),
        "02",
      );
      assert.equal(await selectedRow.locator(".picker-index").textContent(), "60");
      await selectedRow.click();
      await page.getByRole("heading", { name: "Explain file 60" }).waitFor();
      assert.match(
        await controls.trigger.getAttribute("aria-label"),
        /Current file 60 of 60: src\/match-file-30\.ts/,
      );

      await controls.trigger.click();
      await controls.dialog.waitFor();
      await page.waitForFunction(() => {
        const list = document.querySelector(".picker-list");
        const active = document.querySelector(".picker-row--active");
        if (!list || !active) return false;
        const listBounds = list.getBoundingClientRect();
        const activeBounds = active.getBoundingClientRect();
        const listCenter = listBounds.top + listBounds.height / 2;
        const activeCenter = activeBounds.top + activeBounds.height / 2;
        return Math.abs(listCenter - activeCenter) <= 1;
      });
      assert.match(
        await page.locator(".picker-row--active").textContent(),
        /src\/match-file-30\.ts/,
      );

      await controls.close.click();
      await controls.dialog.waitFor({ state: "hidden" });
      await controls.trigger.press("ArrowLeft");
      await page.getByRole("heading", { name: "Explain file 59" }).waitFor();
      await controls.trigger.press("ArrowRight");
      await page.getByRole("heading", { name: "Explain file 60" }).waitFor();
    },
  );
});
