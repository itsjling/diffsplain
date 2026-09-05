import { todoDemoFiles } from "./todo-demo.js";
import {
  filterDemoFiles,
  focusLoopTarget,
  nextPickerRowIndex,
  shouldHandleFileArrow,
  swipeDirection,
  wrapDemoIndex,
} from "./demo-controller.js";

const copyButtons = [...document.querySelectorAll(".copy-button")];
const copyStatus = document.querySelector(".copy-status");
let statusTimer;

const resetCopyButtons = () => {
  for (const button of copyButtons) {
    button.textContent = button.dataset.copyLabel;
  }
};

for (const copyButton of copyButtons) {
  copyButton.dataset.copyLabel = copyButton.textContent.trim();
  copyButton.addEventListener("click", async () => {
    const value = copyButton.dataset.copy;
    if (!value) return;

    clearTimeout(statusTimer);
    resetCopyButtons();

    try {
      await navigator.clipboard.writeText(value);
      copyButton.textContent = "Copied";
      copyStatus.textContent = value.includes("<")
        ? "Command copied. Replace placeholders before running."
        : "Command copied. Paste it in your terminal.";
    } catch {
      copyStatus.textContent =
        "Copy failed. Select the command and copy it manually.";
    }

    copyStatus.classList.add("is-visible");
    statusTimer = setTimeout(() => {
      copyStatus.classList.remove("is-visible");
      resetCopyButtons();
      copyStatus.textContent = "";
    }, 2200);
  });
}

const commandChoice = document.querySelector("[data-command-choice]");
commandChoice.addEventListener("change", () => {
  const option = commandChoice.selectedOptions[0];
  const command = commandChoice.value;
  document.querySelector("[data-hero-command]").textContent = command;
  document.querySelector("[data-hero-copy]").dataset.copy = command;
  document.querySelector("[data-command-note]").textContent = option.dataset.note
    ? `${option.dataset.note}. Run from any directory.`
    : "Run in your repo. Replace <integer> with a PR number before running.";
  const source = document.querySelector("[data-command-source]");
  source.hidden = !option.dataset.url;
  if (option.dataset.url) source.href = option.dataset.url;
  else source.removeAttribute("href");
  clearTimeout(statusTimer);
  resetCopyButtons();
  copyStatus.classList.remove("is-visible");
  copyStatus.textContent = "";
});

const demo = document.querySelector("[data-demo]");

if (demo) {
  const elements = {
    count: demo.querySelector("[data-demo-count]"),
    statusPin: demo.querySelector("[data-demo-status-pin]"),
    path: demo.querySelector("[data-demo-path]"),
    stats: demo.querySelector("[data-demo-stats]"),
    headingPath: demo.querySelector("[data-demo-heading-path]"),
    diff: demo.querySelector("[data-demo-diff]"),
    lineCount: demo.querySelector("[data-demo-line-count]"),
    page: demo.querySelector("[data-demo-page]"),
    prev: demo.querySelector("[data-demo-prev]"),
    next: demo.querySelector("[data-demo-next]"),
    summaryTitle: demo.querySelector("[data-demo-summary-title]"),
    summaryCount: demo.querySelector("[data-demo-summary-count]"),
    summaryWhat: demo.querySelector("[data-demo-summary-what]"),
    summaryWhy: demo.querySelector("[data-demo-summary-why]"),
    summaryDetails: demo.querySelector("[data-demo-summary-details]"),
    riskSection: demo.querySelector("[data-demo-risk-section]"),
    summaryRisks: demo.querySelector("[data-demo-summary-risks]"),
    pickerTrigger: demo.querySelector("[data-demo-picker-trigger]"),
    pickerBackdrop: demo.querySelector("[data-demo-picker-backdrop]"),
    pickerClose: demo.querySelector("[data-demo-picker-close]"),
    pickerSearch: demo.querySelector("[data-demo-picker-search]"),
    pickerMatchCount: demo.querySelector("[data-demo-picker-match-count]"),
    pickerList: demo.querySelector("[data-demo-picker-list]"),
    invitation: document.querySelector("[data-demo-invitation]"),
    mobileToggle: demo.querySelector("[data-demo-mobile-toggle]"),
    mobileToggleLabel: demo.querySelector(
      "[data-demo-mobile-toggle-label]",
    ),
    mobileToggleIcon: demo.querySelector("[data-demo-mobile-toggle-icon]"),
    live: demo.querySelector("[data-demo-live]"),
  };

  let currentIndex = 0;
  let pickerReturnFocus = elements.pickerTrigger;
  let touchStartX = null;

  const makeElement = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  const parsePatch = (patch) => {
    let oldLine = null;
    let newLine = null;

    return patch.split("\n").map((line) => {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        return { type: "hunk", oldNumber: "", newNumber: "", marker: "", code: line };
      }

      if (
        line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line.startsWith("\\ No newline")
      ) {
        return { type: "meta", oldNumber: "", newNumber: "", marker: "", code: line };
      }

      if (line.startsWith("+")) {
        const row = {
          type: "add",
          oldNumber: "",
          newNumber: newLine,
          marker: "+",
          code: line.slice(1),
        };
        newLine += 1;
        return row;
      }

      if (line.startsWith("-")) {
        const row = {
          type: "delete",
          oldNumber: oldLine,
          newNumber: "",
          marker: "−",
          code: line.slice(1),
        };
        oldLine += 1;
        return row;
      }

      const row = {
        type: "context",
        oldNumber: oldLine,
        newNumber: newLine,
        marker: "",
        code: line.startsWith(" ") ? line.slice(1) : line,
      };
      if (oldLine !== null) oldLine += 1;
      if (newLine !== null) newLine += 1;
      return row;
    });
  };

  const renderDiff = (file) => {
    const fragment = document.createDocumentFragment();
    const rows = parsePatch(file.patch);

    const firstChange = rows.findIndex((row) => row.type === "add" || row.type === "delete");
    for (const [index, row] of rows.entries()) {
      const rowElement = makeElement(
        "div",
        `demo-diff-row demo-diff-row--${row.type}`,
      );
      rowElement.classList.toggle("demo-diff-row--preview-skip", index < firstChange);
      rowElement.setAttribute("role", "row");

      const oldNumber = makeElement(
        "span",
        "demo-old-number",
        row.oldNumber === null ? "" : row.oldNumber,
      );
      const newNumber = makeElement(
        "span",
        "demo-new-number",
        row.newNumber === null ? "" : row.newNumber,
      );
      const marker = makeElement("span", "demo-line-marker", row.marker);
      const code = makeElement("code", "demo-diff-code", row.code);

      oldNumber.setAttribute("role", "cell");
      newNumber.setAttribute("role", "cell");
      marker.setAttribute("aria-hidden", "true");
      code.setAttribute("role", "cell");
      rowElement.append(oldNumber, newNumber, marker, code);
      fragment.append(rowElement);
    }

    elements.diff.replaceChildren(fragment);
    elements.lineCount.textContent = `${rows.length} diff lines`;
    elements.diff.parentElement.scrollTo({ top: 0, left: 0 });
  };

  const renderList = (target, values) => {
    const fragment = document.createDocumentFragment();
    for (const value of values) {
      fragment.append(makeElement("li", "", value));
    }
    target.replaceChildren(fragment);
  };

  const renderPicker = (query = "") => {
    const matches = filterDemoFiles(todoDemoFiles, query);
    elements.pickerMatchCount.textContent = `${matches.length} ${matches.length === 1 ? "file" : "files"}`;

    if (!matches.length) {
      elements.pickerList.replaceChildren(
        makeElement("p", "demo-picker-empty", "No changed files match."),
      );
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const { file, index } of matches) {
      const row = makeElement("button", "demo-picker-row");
      row.type = "button";
      if (index === currentIndex) row.setAttribute("aria-current", "true");

      const fileIndex = makeElement(
        "span",
        "demo-picker-row-index",
        String(index + 1).padStart(2, "0"),
      );
      const pin = makeElement("span", "demo-status-pin");
      pin.dataset.status = file.status;
      const path = makeElement("span", "demo-picker-row-path", file.path);
      const stats = makeElement("span", "demo-picker-row-stats");
      stats.append(
        makeElement(
          "span",
          "demo-picker-row-additions",
          `+${file.additions}`,
        ),
        makeElement(
          "span",
          "demo-picker-row-deletions",
          `−${file.deletions}`,
        ),
      );

      row.append(fileIndex, pin, path, stats);
      row.addEventListener("click", () => {
        showFile(index, index >= currentIndex ? "next" : "prev");
        closePicker();
      });
      fragment.append(row);
    }

    elements.pickerList.replaceChildren(fragment);
  };

  const showFile = (index, direction = "next") => {
    currentIndex = wrapDemoIndex(index, todoDemoFiles.length);
    const file = todoDemoFiles[currentIndex];
    const summary = file.summary;
    const paddedIndex = String(currentIndex + 1).padStart(2, "0");

    elements.count.textContent = `${paddedIndex} / ${todoDemoFiles.length}`;
    elements.statusPin.dataset.status = file.status;
    elements.path.textContent = file.path;
    const statusLabel = makeElement("span", "demo-status-label", file.status);
    statusLabel.dataset.status = file.status;
    elements.stats.replaceChildren(
      statusLabel,
      makeElement("span", "demo-additions", `+${file.additions}`),
      makeElement("span", "demo-deletions", `−${file.deletions}`),
    );
    elements.headingPath.textContent = file.path.split("/").at(-1);
    elements.summaryTitle.textContent = summary.title;
    elements.summaryCount.textContent = `${paddedIndex} / ${todoDemoFiles.length}`;
    elements.summaryWhat.textContent = summary.what;
    elements.summaryWhy.textContent = summary.why;
    renderList(elements.summaryDetails, summary.details);

    elements.riskSection.hidden = !summary.risks.length;
    renderList(elements.summaryRisks, summary.risks);
    renderDiff(file);
    renderPicker(elements.pickerSearch.value);

    const motionClass =
      direction === "prev" ? "is-moving-prev" : "is-moving-next";
    elements.page.classList.remove("is-moving-next", "is-moving-prev");
    void elements.page.offsetWidth;
    elements.page.classList.add(motionClass);
    elements.page.addEventListener(
      "animationend",
      () => elements.page.classList.remove(motionClass),
      { once: true },
    );

    elements.pickerTrigger.setAttribute(
      "aria-label",
      `Choose file. Current file ${currentIndex + 1} of ${todoDemoFiles.length}: ${file.path}`,
    );
    elements.live.textContent = `Showing ${file.path}, file ${currentIndex + 1} of ${todoDemoFiles.length}`;
  };

  const openPicker = (returnFocus = elements.pickerTrigger) => {
    pickerReturnFocus = returnFocus;
    elements.pickerBackdrop.hidden = false;
    elements.pickerTrigger.setAttribute("aria-expanded", "true");
    elements.pickerSearch.value = "";
    renderPicker();
    requestAnimationFrame(() => {
      const activeRow = elements.pickerList.querySelector(
        '[aria-current="true"]',
      );
      if (activeRow) {
        elements.pickerList.scrollTop =
          activeRow.offsetTop -
          (elements.pickerList.clientHeight - activeRow.offsetHeight) / 2;
      }
      elements.pickerSearch.focus();
    });
  };

  const closePicker = () => {
    if (elements.pickerBackdrop.hidden) return;
    elements.pickerBackdrop.hidden = true;
    elements.pickerTrigger.setAttribute("aria-expanded", "false");
    pickerReturnFocus.focus();
  };

  elements.prev.addEventListener("click", () =>
    showFile(currentIndex - 1, "prev"),
  );
  elements.next.addEventListener("click", () =>
    showFile(currentIndex + 1, "next"),
  );
  elements.pickerTrigger.addEventListener("click", () =>
    openPicker(elements.pickerTrigger),
  );
  elements.invitation.addEventListener("click", () =>
    openPicker(elements.invitation),
  );
  elements.pickerClose.addEventListener("click", closePicker);
  elements.pickerSearch.addEventListener("input", (event) =>
    renderPicker(event.target.value),
  );
  elements.pickerBackdrop.addEventListener("click", (event) => {
    if (event.target === elements.pickerBackdrop) closePicker();
  });
  elements.mobileToggle.addEventListener("click", () => {
    const expanded = demo.classList.toggle("is-mobile-expanded");
    elements.diff.parentElement.scrollTo({ top: 0, left: 0 });
    elements.mobileToggle.setAttribute("aria-expanded", String(expanded));
    elements.mobileToggleLabel.textContent = expanded
      ? "Show concise demo"
      : "Explore full demo";
    elements.mobileToggleIcon.textContent = expanded ? "↑" : "↓";
    elements.live.textContent = expanded
      ? "Full interactive demo expanded"
      : "Concise demo shown";
  });

  document.addEventListener("keydown", (event) => {
    const pickerIsOpen = !elements.pickerBackdrop.hidden;
    const targetAcceptsText =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target.isContentEditable;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (!pickerIsOpen) openPicker(elements.pickerTrigger);
      return;
    }

    if (event.key === "Escape" && pickerIsOpen) {
      event.preventDefault();
      closePicker();
      return;
    }

    if (event.key === "Tab" && pickerIsOpen) {
      const focusable = [
        ...elements.pickerBackdrop.querySelectorAll("button, input"),
      ].filter((element) => !element.disabled);
      const activeIndex = focusable.indexOf(document.activeElement);
      const targetIndex = focusLoopTarget(
        activeIndex,
        focusable.length - 1,
        event.shiftKey,
      );
      if (targetIndex !== null) {
        event.preventDefault();
        focusable[targetIndex].focus();
      }
      return;
    }

    if (
      pickerIsOpen &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      const rows = [...elements.pickerList.querySelectorAll("button")];
      if (!rows.length) return;
      const activeIndex = rows.indexOf(document.activeElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = nextPickerRowIndex(activeIndex, rows.length, step);
      event.preventDefault();
      rows[nextIndex].focus();
      return;
    }

    if (
      !shouldHandleFileArrow({
        pickerIsOpen,
        targetAcceptsText,
        targetHandlesArrow: Boolean(
          event.target.closest(
            ".demo-diff-scroll, .demo-summary-scroll",
          ),
        ),
        demoHasFocus: demo.contains(document.activeElement),
      })
    ) {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      showFile(currentIndex - 1, "prev");
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      showFile(currentIndex + 1, "next");
    }
  });

  elements.page.addEventListener("click", (event) => {
    if (
      !event.target.closest(
        "button, a, input, .demo-diff-scroll, .demo-summary-scroll",
      )
    ) {
      demo.focus({ preventScroll: true });
    }
  });

  elements.page.addEventListener(
    "touchstart",
    (event) => {
      if (event.target.closest(".demo-diff-scroll")) {
        touchStartX = null;
        return;
      }
      touchStartX = event.changedTouches[0]?.clientX ?? null;
    },
    { passive: true },
  );
  elements.page.addEventListener(
    "touchend",
    (event) => {
      if (touchStartX === null) return;
      const distance = (event.changedTouches[0]?.clientX ?? touchStartX) - touchStartX;
      touchStartX = null;
      const direction = swipeDirection(distance);
      if (!direction) return;
      showFile(currentIndex + (direction === "next" ? 1 : -1), direction);
    },
    { passive: true },
  );

  showFile(0);
}
