import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { after, before } from "node:test";
import AxeBuilder from "@axe-core/playwright";

import { todoDemoFiles } from "../../site/todo-demo.js";
import {
  browserRoot,
  runInBrowser,
  startStaticServer,
} from "./browser-harness.mjs";

const selectedFile = todoDemoFiles.find(
  (file) => file.path === "src/lib/todoStore.test.ts",
);
const selectedDiffLine = selectedFile.patch
  .split("\n")
  .find((line) => line.startsWith("+") && !line.startsWith("+++"))
  .slice(1);
let server;

function runLandingJourney(name, options, journey) {
  return runInBrowser(name, options, journey, {
    serverLog: () => server.log(),
  });
}

async function assertFocusRing(locator, label, ringLocator = locator) {
  const focus = await locator.evaluate((element) => {
    return {
      active: element === document.activeElement,
      focusVisible: element.matches(":focus-visible"),
    };
  });
  const ring = await ringLocator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  assert.equal(focus.active, true, `${label} should have focus`);
  assert.equal(focus.focusVisible, true, `${label} should match :focus-visible`);
  assert.ok(
    (ring.outlineStyle !== "none" && ring.outlineWidth !== "0px") ||
      ring.boxShadow !== "none",
    `${label} should show a focus ring`,
  );
}

async function tabTo(page, selector) {
  for (let count = 0; count < 20; count += 1) {
    await page.keyboard.press("Tab");
    const found = await page.evaluate(
      (candidate) => document.activeElement?.matches(candidate),
      selector,
    );
    if (found) return;
  }
  assert.fail(`Keyboard focus did not reach ${selector}`);
}

function axeFindings(results) {
  return results.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    targets: nodes.flatMap((node) => node.target),
  }));
}

async function assertDemoHasNoAxeViolations(page) {
  const results = await new AxeBuilder({ page })
    .include("[data-demo]")
    .analyze();
  assert.deepEqual(axeFindings(results), []);
  const passedRules = new Set(results.passes.map(({ id }) => id));
  for (const rule of ["aria-roles", "button-name", "color-contrast"]) {
    assert.ok(passedRules.has(rule), `axe should pass ${rule}`);
  }
}

async function demoPickerPosition(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
  );
  return page.locator(".demo-picker-list").evaluate((list) => {
    const active = list.querySelector('[aria-current="true"]');
    if (!(active instanceof HTMLElement)) {
      throw new Error("No active picker row");
    }
    const listBounds = list.getBoundingClientRect();
    const activeBounds = active.getBoundingClientRect();
    return {
      bottomGap: listBounds.bottom - activeBounds.bottom,
      centerGap: Math.abs(
        listBounds.top +
          listBounds.height / 2 -
          (activeBounds.top + activeBounds.height / 2),
      ),
      rowHeight: activeBounds.height,
      topGap: activeBounds.top - listBounds.top,
    };
  });
}

async function dispatchSwipe(locator, startX, endX) {
  await locator.evaluate(
    (element, points) => {
      const fire = (type, clientX) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "changedTouches", {
          value: [{ clientX }],
        });
        element.dispatchEvent(event);
      };
      fire("touchstart", points.startX);
      fire("touchend", points.endX);
    },
    { startX, endX },
  );
}

before(async () => {
  server = await startStaticServer(resolve(browserRoot, "site"));
});

after(async () => {
  await server?.stop();
});

test("selects a demo file and shows its matching diff and note", async () => {
  await runLandingJourney(
    "landing pointer journey",
    { viewport: { width: 1280, height: 900 } },
    async (page) => {
      await page.goto(server.url);
      const demo = page.getByRole("region", {
        name: "Interactive ten-file todo pull request demo",
      });
      await demo.waitFor();
      await page.getByRole("table", { name: "Current file diff" }).waitFor();
      await page.getByRole("complementary", { name: "Agent note" }).waitFor();

      const invitation = page.getByRole("button", {
        name: /Explore the demo/,
      });
      await invitation.click();
      const dialog = page.getByRole("dialog", { name: "Jump to a file" });
      await dialog.waitFor();
      await page
        .getByRole("button", { name: "Close file picker" })
        .click();
      assert.equal(
        await invitation.evaluate((element) => element === document.activeElement),
        true,
      );

      await page.getByRole("button", { name: /Choose file/ }).click();
      await dialog.waitFor();
      const search = page.getByRole("searchbox", {
        name: "Search changed files",
      });
      await search.fill("todoStore.test");
      await dialog
        .getByRole("button")
        .filter({ hasText: selectedFile.path })
        .click();

      assert.equal(
        await page.locator("[data-demo-path]").textContent(),
        selectedFile.path,
      );
      assert.equal(
        await page.locator("[data-demo-summary-title]").textContent(),
        selectedFile.summary.title,
      );
      assert.match(
        await page.locator("[data-demo-stats]").textContent(),
        new RegExp(`\\+${selectedFile.additions}.*−${selectedFile.deletions}`),
      );
      assert.ok(
        (await page.locator("[data-demo-diff]").textContent()).includes(
          selectedDiffLine,
        ),
      );
      assert.equal(
        await page.locator("[data-demo-live]").textContent(),
        `Showing ${selectedFile.path}, file 9 of 10`,
      );

      await page.getByRole("button", { name: /Choose file/ }).click();
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () =>
          document.activeElement?.matches("[data-demo-picker-trigger]"),
      );
      await page.keyboard.press("ArrowRight");
      assert.equal(
        await page.locator("[data-demo-path]").textContent(),
        todoDemoFiles[9].path,
      );

      const picker = page.getByRole("button", { name: /Choose file/ });
      const backdrop = page.locator("[data-demo-picker-backdrop]");
      await picker.click();
      await page
        .getByRole("button", { name: "Close file picker" })
        .click();
      await backdrop.waitFor({ state: "hidden" });
      await page.waitForFunction(
        () =>
          document.activeElement?.matches("[data-demo-picker-trigger]"),
      );
      await page.keyboard.press("ArrowRight");
      assert.equal(
        await page.locator("[data-demo-path]").textContent(),
        todoDemoFiles[0].path,
      );

      await picker.click();
      await backdrop.click({ position: { x: 5, y: 5 } });
      await backdrop.waitFor({ state: "hidden" });
      await page.waitForFunction(
        () =>
          document.activeElement?.matches("[data-demo-picker-trigger]"),
      );
      await page.keyboard.press("ArrowRight");
      assert.equal(
        await page.locator("[data-demo-path]").textContent(),
        todoDemoFiles[1].path,
      );
    },
  );
});

test("keeps landing edge files near the list bounds and centers an ordinary row", async () => {
  await runLandingJourney(
    "landing picker positions",
    { viewport: { width: 1280, height: 900 } },
    async (page) => {
      await page.goto(server.url);
      const picker = page.getByRole("button", { name: /Choose file/ });
      const dialog = page.getByRole("dialog", { name: "Jump to a file" });

      await picker.click();
      let position = await demoPickerPosition(page);
      assert.ok(
        position.topGap < position.rowHeight,
        JSON.stringify(position),
      );

      await dialog
        .getByRole("button")
        .filter({ hasText: todoDemoFiles[5].path })
        .click();
      await picker.click();
      position = await demoPickerPosition(page);
      assert.ok(position.centerGap <= 1);

      await dialog
        .getByRole("button")
        .filter({ hasText: todoDemoFiles.at(-1).path })
        .click();
      await picker.click();
      position = await demoPickerPosition(page);
      assert.ok(
        position.bottomGap < position.rowHeight,
        JSON.stringify(position),
      );
    },
  );
});

test("reports copy success and failure without stale status", async () => {
  await runLandingJourney(
    "landing copy feedback",
    { viewport: { width: 1280, height: 900 } },
    async (page) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (value) => {
              if (window.__clipboardFailure) {
                throw new Error("Clipboard denied");
              }
              window.__copiedCommand = value;
            },
          },
        });
      });
      await page.goto(server.url);

      const copy = page.locator("[data-hero-copy]");
      const status = page.getByRole("status");
      await copy.click();
      await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
      assert.equal(await copy.textContent(), "Copied");
      assert.equal(
        await status.textContent(),
        "Command copied. Paste it in your terminal.",
      );
      assert.equal(
        await page.evaluate(() => window.__copiedCommand),
        "npx diffsplain --pr 198",
      );

      await page.evaluate(() => {
        window.__clipboardFailure = true;
      });
      await copy.click();
      await page
        .getByText("Copy failed. Select the command and copy it manually.", {
          exact: true,
        })
        .waitFor();
      assert.equal(await copy.textContent(), "Copy command");
      assert.equal(
        await status.textContent(),
        "Copy failed. Select the command and copy it manually.",
      );

      await page.waitForTimeout(2_300);
      assert.equal(await status.textContent(), "");
      assert.equal(
        await status.evaluate((element) => element.matches(".is-visible")),
        false,
      );
    },
  );
});

test("starts with a concise mobile proof and expands the full demo", async () => {
  await runLandingJourney(
    "landing mobile proof disclosure",
    {
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    },
    async (page) => {
      await page.goto(server.url);
      const demo = page.locator("[data-demo]");
      const toggle = page.locator("[data-demo-mobile-toggle]");
      const noteSection = page.locator(".demo-note-section").first();
      const diffFooter = page.locator(".demo-diff-footer");

      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      assert.equal(await noteSection.isVisible(), false);
      assert.equal(await diffFooter.isVisible(), false);
      assert.ok((await demo.boundingBox()).height < 600);

      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      assert.match(await toggle.textContent(), /Show concise demo/);
      assert.equal(await noteSection.isVisible(), true);
      assert.equal(await diffFooter.isVisible(), true);

      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      assert.equal(await noteSection.isVisible(), false);
    },
  );
});

test("keeps a visible keyboard focus order and announces file changes", async () => {
  await runLandingJourney(
    "landing keyboard and accessibility",
    {
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 900 },
    },
    async (page) => {
      await page.goto(server.url);
      const demo = page.locator("[data-demo]");
      await tabTo(page, "[data-demo]");
      await assertFocusRing(demo, "demo");

      const expectedControls = [
        "Show previous file",
        /Choose file/,
        "Show next file",
      ];
      for (const name of expectedControls) {
        await page.keyboard.press("Tab");
        const control = page.getByRole("button", { name });
        await assertFocusRing(control, String(name));
      }

      await page.keyboard.press("Enter");
      assert.equal(
        await page.locator("[data-demo-path]").textContent(),
        todoDemoFiles[1].path,
      );
      assert.equal(
        await page.locator("[data-demo-live]").textContent(),
        `Showing ${todoDemoFiles[1].path}, file 2 of 10`,
      );

      await page.keyboard.press("Shift+Tab");
      const picker = page.getByRole("button", { name: /Choose file/ });
      await assertFocusRing(picker, "file picker");
      await page.keyboard.press("Enter");
      const search = page.getByRole("searchbox", {
        name: "Search changed files",
      });
      await page.waitForFunction(
        () => document.activeElement?.matches("[data-demo-picker-search]"),
      );
      await assertFocusRing(
        search,
        "file search",
        page.locator(".demo-picker-search"),
      );
      await search.fill("todoStore.test");
      await page.keyboard.press("ArrowDown");
      const selectedRow = page
        .getByRole("dialog", { name: "Jump to a file" })
        .getByRole("button")
        .filter({ hasText: selectedFile.path });
      await assertFocusRing(selectedRow, "file result");
      await page.keyboard.press("Enter");
      await assertFocusRing(picker, "returned file picker");
      assert.equal(
        await page.locator("[data-demo-live]").textContent(),
        `Showing ${selectedFile.path}, file 9 of 10`,
      );

      await page.keyboard.press("Tab");
      await assertFocusRing(
        page.getByRole("button", { name: "Show next file" }),
        "next file after picker",
      );
      await page.keyboard.press("Tab");
      await assertFocusRing(
        page.getByRole("region", { name: "Scrollable unified diff" }),
        "scrollable diff",
      );
      await page.keyboard.press("Tab");
      await assertFocusRing(
        page.getByRole("region", { name: "Scrollable agent note" }),
        "scrollable note",
      );

      await assertDemoHasNoAxeViolations(page);
      await picker.click();
      await assertDemoHasNoAxeViolations(page);
    },
  );
});

test("changes one file on touch without firing another control", async () => {
  await runLandingJourney(
    "landing touch journey",
    {
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    },
    async (page) => {
      await page.goto(server.url);
      await page.evaluate(() => {
        window.__demoControlClicks = 0;
        for (const control of document.querySelectorAll(
          "[data-demo-prev], [data-demo-next], [data-demo-picker-trigger]",
        )) {
          control.addEventListener("click", () => {
            window.__demoControlClicks += 1;
          });
        }
      });

      await dispatchSwipe(page.locator(".demo-summary-scroll"), 300, 140);
      assert.equal(
        await page.locator("[data-demo-path]").textContent(),
        todoDemoFiles[1].path,
      );
      assert.equal(
        await page.locator("[data-demo-live]").textContent(),
        `Showing ${todoDemoFiles[1].path}, file 2 of 10`,
      );
      assert.equal(
        await page
          .locator("[data-demo-picker-trigger]")
          .getAttribute("aria-expanded"),
        "false",
      );
      assert.equal(
        await page.evaluate(() => window.__demoControlClicks),
        0,
      );

      await dispatchSwipe(page.locator(".demo-diff-scroll"), 300, 140);
      assert.equal(
        await page.locator("[data-demo-path]").textContent(),
        todoDemoFiles[1].path,
      );
      assert.equal(
        await page.evaluate(() => window.__demoControlClicks),
        0,
      );
    },
  );
});

test("keeps click focus and arrow-key scrolling inside scroll regions", async () => {
  await runLandingJourney(
    "landing scroll region keyboard scrolling",
    {
      reducedMotion: "reduce",
      viewport: { width: 390, height: 844 },
    },
    async (page) => {
      await page.goto(server.url);
      await page.locator("[data-demo-mobile-toggle]").click();
      const diff = page.getByRole("region", {
        name: "Scrollable unified diff",
      });
      await diff.click();
      const path = await page.locator("[data-demo-path]").textContent();

      assert.equal(
        await diff.evaluate((element) => element === document.activeElement),
        true,
      );
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        () =>
          document.querySelector(".demo-diff-scroll")?.scrollLeft > 0,
      );

      assert.equal(
        await page.locator("[data-demo-path]").textContent(),
        path,
      );

      const note = page.getByRole("region", {
        name: "Scrollable agent note",
      });
      await note.click();
      assert.equal(
        await note.evaluate((element) => element === document.activeElement),
        true,
      );
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(
        () =>
          document.querySelector(".demo-summary-scroll")?.scrollTop > 0,
      );
      assert.equal(
        await page.locator("[data-demo-path]").textContent(),
        path,
      );
    },
  );
});


test("keeps the quick start clear of the demo across desktop widths", async () => {
  await runLandingJourney(
    "landing layout separation",
    { viewport: { width: 1280, height: 900 } },
    async (page) => {
      await page.goto(server.url);
      for (const width of [1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        const gap = await page.evaluate(() => {
          const command = document.querySelector(".hero__command").getBoundingClientRect();
          const demo = document.querySelector(".hero__demo-stage").getBoundingClientRect();
          return demo.left - command.right;
        });
        assert.ok(gap >= 32, `Expected a clear gutter at ${width}px; got ${gap}px`);
      }
    },
  );
});
