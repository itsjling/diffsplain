import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileDiffOptions } from "@pierre/diffs";
import { PatchDiff, Virtualizer } from "@pierre/diffs/react";
import {
  ReviewChat,
  ReviewChatRunningNotice,
} from "./review-chat";
import { useLiveSnapshot } from "./use-live-snapshot";
import { type ChatScope, useReviewChat } from "./use-review-chat";

type FileStatus = "added" | "modified" | "deleted" | "renamed" | "binary";

type FileSummary = {
  title: string;
  what: string;
  why: string;
  details: string[];
  risks: string[];
};

type DiffFile = {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
  isTruncated: boolean;
  totalDiffLines: number;
  patch: string;
  snippet: string;
  sourceUrl?: string;
  comparisonUrl?: string;
  summary: FileSummary;
  noteReady?: boolean;
  noteFailure?: string;
  agentExcluded?: boolean;
};

type DiffNotes = {
  fresh: boolean;
  complete: boolean;
  status: "idle" | "generating" | "complete" | "failed" | "stale";
  completedFiles: number;
  totalFiles: number;
  agent?: string;
  model?: string;
  reasoning?: string;
};

type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

type UsageSummary =
  | {
      status: "complete" | "partial";
      calls: number;
      reportedCalls: number;
      tokens: TokenUsage;
    }
  | {
      status: "unavailable";
      calls: number;
      reportedCalls: 0;
    };

type ReviewUsage = {
  agentNotes: UsageSummary;
  reviewChat: UsageSummary;
  combined: UsageSummary;
};

type DiffSnapshot = {
  version: string;
  generatedAt: string;
  repo: {
    name: string;
    root: string;
    base: string;
    head: string;
    branch?: string;
    baseBranch?: string;
    remote?: string;
    remoteUrl?: string;
    target?: {
      kind:
        | "worktree"
        | "base-worktree"
        | "checkout"
        | "range"
        | "branch"
        | "pull-request";
      base?: { ref: string; oid: string | null };
      head?: { ref: string; oid: string | null };
    };
  };
  change: {
    title: string;
    number?: number;
    url?: string;
    summary: string;
    why: string;
    highlights: string[];
    risks: string[];
  };
  files: DiffFile[];
  notes?: DiffNotes;
  usage?: ReviewUsage;
};

type AgentNoteState = "waiting" | "ready" | "failed" | "excluded";

const SWIPE_THRESHOLD = 48;
const SWIPE_EXCLUDED_TARGETS =
  ".diff-scroll, button, a, input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='dialog']";
const PICKER_FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
const DIFF_OPTIONS = {
  diffIndicators: "classic",
  diffStyle: "unified",
  disableFileHeader: true,
  hunkSeparators: "metadata",
  lineDiffType: "word-alt",
  overflow: "scroll",
  theme: "pierre-light",
  themeType: "light",
} satisfies FileDiffOptions<undefined>;

function shortRef(ref: string) {
  return ref.length > 16 ? ref.slice(0, 8) : ref;
}

const AGENT_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  opencode: "OpenCode",
};

const AGENT_NOTE_STATE_MARKS = {
  waiting: "…",
  ready: "✓",
  failed: "!",
  excluded: "×",
} satisfies Record<AgentNoteState, string>;

function formatName(value: string) {
  return value
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) =>
      part.toLowerCase() === "gpt"
        ? "GPT"
        : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
    )
    .join(" ");
}

function noteWriter(notes?: DiffNotes) {
  const model = notes?.model ? formatName(notes.model) : "Default model";
  const agent = notes?.agent
    ? (AGENT_NAMES[notes.agent.toLowerCase()] ?? formatName(notes.agent))
    : "Unknown agent";
  return `${model} (${agent})`;
}

const TOKEN_LABELS: Array<[keyof TokenUsage, string]> = [
  ["inputTokens", "Input"],
  ["outputTokens", "Output"],
  ["cacheReadTokens", "Cache read"],
  ["cacheWriteTokens", "Cache write"],
];

function usageState(summary: UsageSummary, notesGenerating: boolean) {
  if (notesGenerating) return "Writing";
  if (summary.status === "unavailable") return "Unavailable";
  return summary.status === "partial" ? "Partial" : "Complete";
}

function UsageRow({
  label,
  summary,
}: {
  label: string;
  summary: UsageSummary;
}) {
  if (summary.status === "unavailable") {
    return (
      <div className="usage-row">
        <dt>{label}</dt>
        <dd className="usage-unavailable">Unavailable</dd>
      </div>
    );
  }
  const tokens = TOKEN_LABELS.flatMap(([field, label]) => {
    const value = summary.tokens[field];
    return value === undefined ? [] : [{ field, label, value }];
  });
  return (
    <div className="usage-row">
      <dt>{label}</dt>
      <dd>
        {summary.status === "partial" ? (
          <span className="usage-partial">Partial</span>
        ) : null}
        {tokens.map(({ field, label: tokenLabel, value }, index) => (
          <span
            aria-label={`${tokenLabel} ${value.toLocaleString()}`}
            className="usage-token"
            key={field}
          >
            {index === 0 ? "" : "· "}
            {tokenLabel} {value.toLocaleString()}
          </span>
        ))}
      </dd>
    </div>
  );
}

function UsagePanel({
  notesGenerating,
  usage,
}: {
  notesGenerating: boolean;
  usage: ReviewUsage;
}) {
  return (
    <details className="usage-disclosure">
      <summary>
        <span className="usage-summary-label">Agent usage</span>
        <span className="usage-summary-state">
          {usageState(usage.combined, notesGenerating)}
        </span>
      </summary>
      <section
        aria-label="Agent usage"
        aria-live="polite"
        className="usage-panel"
      >
        <dl>
          <UsageRow label="Notes" summary={usage.agentNotes} />
          <UsageRow label="Chat" summary={usage.reviewChat} />
          <UsageRow label="Total" summary={usage.combined} />
        </dl>
      </section>
    </details>
  );
}

// fallow-ignore-next-line complexity -- This formats every supported review target.
function changeScope(snapshot: DiffSnapshot) {
  const { repo } = snapshot;
  if (snapshot.change.number) return `PR #${snapshot.change.number}`;
  if (repo.target?.kind === "branch" && repo.baseBranch && repo.branch) {
    return `${repo.baseBranch} → ${repo.branch}`;
  }
  if (repo.target?.kind === "worktree") {
    return repo.head === "WORKTREE"
      ? "Empty repo → working tree"
      : "HEAD → working tree";
  }
  if (repo.target?.kind === "base-worktree") {
    return `${shortRef(repo.target.base?.ref || repo.base)} → working tree`;
  }
  if (repo.target?.kind === "checkout") {
    if (repo.base === repo.head) {
      return "HEAD → working tree";
    }
    const base =
      repo.baseBranch && repo.baseBranch !== repo.branch
        ? repo.baseBranch
        : shortRef(repo.base);
    const checkout = repo.branch
      ? `${repo.branch} checkout`
      : `${shortRef(repo.head)} checkout`;
    return `${base} → ${checkout}`;
  }
  return `${shortRef(repo.base)} → ${shortRef(repo.head)}`;
}

function browserTitle(snapshot: DiffSnapshot) {
  const target = snapshot.change.number
    ? `PR #${snapshot.change.number}`
    : snapshot.repo.target?.kind === "base-worktree"
      ? changeScope(snapshot)
      : snapshot.repo.branch || changeScope(snapshot);
  return `${snapshot.repo.name} · ${target} — Diffsplain`;
}

function relativeTime(value: string | null) {
  if (!value) return "Connecting";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1_000),
  );
  if (seconds < 8) return "Updated now";
  if (seconds < 60) return `Updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (remainingHours > 0) return `Updated ${days}d ${remainingHours}h ago`;
  return `Updated ${days}d ago`;
}

function statusLabel(status: FileStatus) {
  if (status === "added") return "Added";
  if (status === "deleted") return "Deleted";
  if (status === "renamed") return "Renamed";
  if (status === "binary") return "Binary";
  return "Modified";
}

function readyAgentNoteState(
  file: DiffFile,
  notes: DiffNotes,
): "ready" | undefined {
  if (file.noteReady === true) return "ready";
  if (file.noteReady === false) return undefined;
  if (notes.complete) return "ready";
  return undefined;
}

function unresolvedAgentNoteState(
  file: DiffFile,
  notes: DiffNotes,
): "failed" | "waiting" {
  if (file.noteFailure !== undefined) return "failed";
  if (notes.status === "failed") return "failed";
  return "waiting";
}

function agentNoteState(
  file: DiffFile,
  notes: DiffNotes | undefined,
): AgentNoteState | null {
  if (notes === undefined) return null;
  if (file.agentExcluded === true) return "excluded";
  const readyState = readyAgentNoteState(file, notes);
  if (readyState !== undefined) return readyState;
  return unresolvedAgentNoteState(file, notes);
}

function PickerAgentNoteState({ state }: { state: AgentNoteState }) {
  return (
    <span
      className={`picker-note-state picker-note-state--${state}`}
      aria-label={`Agent note ${state}`}
      role="img"
      title={`Agent note ${state}`}
    >
      <span aria-hidden="true">{AGENT_NOTE_STATE_MARKS[state]}</span>
      {state}
    </span>
  );
}

function hasSelectedText() {
  return window.getSelection()?.isCollapsed === false;
}

function isTextEntryTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']",
      ),
    )
  );
}

function canStartSwipe(target: EventTarget | null) {
  return (
    target instanceof Element && !target.closest(SWIPE_EXCLUDED_TARGETS)
  );
}

function swipeStep(
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const horizontal = end.x - start.x;
  const vertical = end.y - start.y;
  if (
    Math.abs(horizontal) < SWIPE_THRESHOLD ||
    Math.abs(horizontal) <= Math.abs(vertical) * 1.25
  ) {
    return 0;
  }
  return horizontal < 0 ? 1 : -1;
}

function pickerFocusableElements(dialog: HTMLElement | null) {
  if (!dialog) return [];
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(PICKER_FOCUSABLE),
  ).filter((element) => element.offsetParent !== null);
}

function pickerEdgeTarget(
  event: KeyboardEvent,
  active: Element | null,
  first: HTMLElement,
  last: HTMLElement,
) {
  if (event.shiftKey) return active === first ? last : null;
  return active === last ? first : null;
}

function pickerFocusTarget(
  event: KeyboardEvent,
  dialog: HTMLElement,
  focusable: HTMLElement[],
) {
  if (focusable.length === 0) return null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!dialog.contains(active)) return event.shiftKey ? last : first;
  return pickerEdgeTarget(event, active, first, last);
}

function trapPickerFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (event.key !== "Tab" || !dialog) return;
  const target = pickerFocusTarget(
    event,
    dialog,
    pickerFocusableElements(dialog),
  );
  if (!target) return;
  event.preventDefault();
  target.focus();
}

function fileNavigationStep(event: KeyboardEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return 0;
  if (isTextEntryTarget(target)) return 0;
  const focusedFileControl = target.closest(
    ".nav-button, .file-picker-trigger",
  );
  if (
    target !== document.body &&
    !focusedFileControl
  ) {
    return 0;
  }
  if (!focusedFileControl && hasSelectedText()) return 0;
  if (event.key === "ArrowRight") return 1;
  if (event.key === "ArrowLeft") return -1;
  return 0;
}

function BrandBlock() {
  return (
    <div className="brand-block">
      <img className="brand-mark" src="./logo-256.png" width="52" height="52" alt="" />
      <div>
        <p className="brand-name">Diffsplain</p>
        <p className="brand-tag">Agent-made change notes</p>
      </div>
    </div>
  );
}

function DiffLines({ patch }: { patch: string }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const renderablePatch = useMemo(
    () =>
      patch
        .split("\n")
        .filter((line) => !/^(?:\.\.\.|…) diff truncated;/.test(line))
        .join("\n"),
    [patch],
  );

  useEffect(() => {
    shellRef.current
      ?.closest<HTMLElement>(".diff-scroll")
      ?.scrollTo({ top: 0, left: 0 });
  }, [renderablePatch]);

  return (
    <div
      ref={shellRef}
      className="diff-renderer-shell"
      role="region"
      aria-label="Unified code diff"
    >
      <PatchDiff
        key={renderablePatch}
        patch={renderablePatch}
        options={DIFF_OPTIONS}
        className="diff-renderer"
      />
    </div>
  );
}

function LoadingState() {
  return (
    <main className="loading-shell">
      <div className="loading-mark">DP</div>
      <p className="eyebrow">LOCAL DIFF READER</p>
      <h1>Preparing the changes.</h1>
      <div className="loading-line" aria-hidden="true">
        <span />
      </div>
      <p className="loading-note">
        Waiting for the workspace snapshot at <code>/diff-data.json</code>
      </p>
    </main>
  );
}

function EmptyState({
  snapshot,
  loadError,
}: {
  snapshot: DiffSnapshot;
  loadError: string | null;
}) {
  return (
    <main className="empty-shell">
      <div className="empty-topline">
        <BrandBlock />
        <div className={`sync-state ${loadError ? "sync-state--error" : ""}`}>
          <span className="live-dot" aria-hidden="true" />
          <div>
            <strong>{loadError ? "Reconnecting" : "Watching"}</strong>
            <span>{snapshot.repo.name}</span>
          </div>
        </div>
      </div>
      <div className="empty-message">
        <p className="eyebrow">CLEAN WORKSPACE</p>
        <h1>No changed files.</h1>
        <p>
          Diffsplain is watching changes against{" "}
          <code>{shortRef(snapshot.repo.base)}</code>. New work will appear here.
        </p>
      </div>
    </main>
  );
}

function ConnectionNotice({
  demoUnavailable,
  message,
}: {
  demoUnavailable: boolean;
  message: string | null;
}) {
  if (!message) return null;
  return (
    <div className="connection-error" role="status">
      {message}
      {demoUnavailable
        ? ". Check public/demo-diff-data.json."
        : " The last valid review stays visible while Diffsplain retries."}
    </div>
  );
}

export default function Home() {
  const { access, chatRevision, demoUnavailable, loadError, snapshot } =
    useLiveSnapshot<DiffSnapshot>();
  const chat = useReviewChat({ access, refreshKey: chatRevision });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [motion, setMotion] = useState<"next" | "previous" | "pick">("pick");
  const [motionKey, setMotionKey] = useState(0);
  const [summaryMode, setSummaryMode] = useState<"note" | "chat">("note");
  const [chatScope, setChatScope] = useState<ChatScope>("file");
  const [clock, setClock] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const pickerDialogRef = useRef<HTMLElement | null>(null);
  const pickerListRef = useRef<HTMLDivElement | null>(null);
  const activePickerRowRef = useRef<HTMLButtonElement | null>(null);
  const pickerReturnFocusRef = useRef<HTMLElement | null>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    document.title = snapshot ? browserTitle(snapshot) : "Diffsplain";
  }, [snapshot]);

  useEffect(() => {
    const ticker = window.setInterval(() => setClock((value) => value + 1), 5_000);
    return () => window.clearInterval(ticker);
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    setSelectedPath((current) => {
      if (current && snapshot.files.some((file) => file.path === current)) {
        return current;
      }
      return snapshot.files[0]?.path ?? null;
    });
  }, [snapshot]);

  const files = useMemo(() => snapshot?.files ?? [], [snapshot]);
  const currentIndex = Math.max(
    0,
    files.findIndex((file) => file.path === selectedPath),
  );
  const currentFile = files[currentIndex];

  const openPicker = useCallback(() => {
    if (!pickerReturnFocusRef.current) {
      const active =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      pickerReturnFocusRef.current =
        active && active !== document.body ? active : pickerTriggerRef.current;
    }
    setPickerOpen(true);
  }, []);

  const closePicker = useCallback(() => {
    setPickerOpen(false);
  }, []);

  const chooseFile = useCallback(
    (index: number, direction: "next" | "previous" | "pick" = "pick") => {
      const file = files[index];
      if (!file) return;
      setMotion(direction);
      setMotionKey((value) => value + 1);
      setSelectedPath(file.path);
      closePicker();
      setQuery("");
    },
    [closePicker, files],
  );

  const move = useCallback(
    (step: number) => {
      if (files.length < 2) return;
      const nextIndex = (currentIndex + step + files.length) % files.length;
      chooseFile(nextIndex, step > 0 ? "next" : "previous");
    },
    [chooseFile, currentIndex, files.length],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (isTextEntryTarget(event.target)) return;
        event.preventDefault();
        if (!pickerOpen) openPicker();
        return;
      }

      if (pickerOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          closePicker();
          return;
        }
        trapPickerFocus(event, pickerDialogRef.current);
        return;
      }

      const step = fileNavigationStep(event);
      if (!step) return;
      event.preventDefault();
      move(step);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closePicker, move, openPicker, pickerOpen]);

  useEffect(() => {
    const focusTarget = pickerOpen
      ? searchRef.current
      : pickerReturnFocusRef.current;
    if (!focusTarget) return;

    const frame = window.requestAnimationFrame(() => {
      if (pickerOpen) {
        const list = pickerListRef.current;
        const activeRow = activePickerRowRef.current;
        if (list && activeRow) {
          list.scrollTop =
            activeRow.offsetTop -
            (list.clientHeight - activeRow.offsetHeight) / 2;
        }
      }

      const connectedTarget = focusTarget.isConnected
        ? focusTarget
        : pickerTriggerRef.current;
      connectedTarget?.focus();
      if (!pickerOpen) pickerReturnFocusRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pickerOpen]);

  const visibleFiles = useMemo(() => {
    const cleanQuery = query.trim().toLowerCase();
    return files.flatMap((file, index) =>
      !cleanQuery || file.path.toLowerCase().includes(cleanQuery)
        ? [{ file, index }]
        : [],
    );
  }, [files, query]);

  if (!snapshot) {
    return (
      <>
        <LoadingState />
        <ConnectionNotice
          demoUnavailable={demoUnavailable}
          message={loadError}
        />
      </>
    );
  }

  if (!files.length) {
    return (
      <>
        <EmptyState snapshot={snapshot} loadError={loadError} />
        <ConnectionNotice
          demoUnavailable={demoUnavailable}
          message={loadError}
        />
      </>
    );
  }

  if (!currentFile) return <LoadingState />;

  const showFull = expandedFiles.has(currentFile.path);
  const shownPatch =
    currentFile.isTruncated && !showFull
      ? currentFile.snippet
      : currentFile.patch;
  const changeLabel = changeScope(snapshot);
  const noteReady =
    currentFile.noteReady ?? snapshot.notes?.complete ?? true;
  const agentExcluded = currentFile.agentExcluded === true;
  const notesGenerating = snapshot.notes?.status === "generating";
  const notesFailed = snapshot.notes?.status === "failed";
  const notesInProgress = !agentExcluded && notesGenerating && !noteReady;
  const noteUnavailable = !agentExcluded && notesFailed && !noteReady;
  const noteProgress = snapshot.notes
    ? `${snapshot.notes.completedFiles} of ${snapshot.notes.totalFiles} ready`
    : "";
  const hasFreshNote =
    !agentExcluded && noteReady && snapshot.notes?.fresh === true;
  const writer = noteWriter(snapshot.notes);
  const syncLabel = loadError
    ? "Reconnecting"
    : notesGenerating
      ? "Writing notes"
      : notesFailed
        ? "Notes stopped"
        : "Watching";
  const syncDetail = loadError
    ? relativeTime(snapshot.generatedAt)
    : notesGenerating || notesFailed
      ? noteProgress
      : relativeTime(snapshot.generatedAt);

  return (
    <main className="app-shell">
      <header className="topbar">
        <BrandBlock />

        <div className="change-block">
          <div className="change-meta">
            <span>{snapshot.repo.name}</span>
            <span className="meta-separator">/</span>
            {snapshot.change.url ? (
              <a href={snapshot.change.url} target="_blank" rel="noreferrer">
                {changeLabel}
              </a>
            ) : (
              <span>{changeLabel}</span>
            )}
          </div>
          <p>{snapshot.change.title}</p>
        </div>

        <div
          className={`sync-state ${
            loadError
              ? "sync-state--error"
              : notesFailed
                ? "sync-state--notes-error"
                : notesGenerating
                  ? "sync-state--notes"
                  : ""
          }`}
          title={loadError ?? `Snapshot ${snapshot.version}`}
        >
          <span className="live-dot" aria-hidden="true" />
          <div>
            <strong>{syncLabel}</strong>
            <span>{syncDetail}</span>
          </div>
        </div>
      </header>

      <section className="reader" aria-label="Changed file reader">
        <div className="reader-toolbar">
          <button
            type="button"
            className="nav-button nav-button--previous"
            onClick={() => move(-1)}
            aria-label="Previous file"
            title="Previous file (Left arrow)"
          >
            <span aria-hidden="true">←</span>
          </button>

          <button
            ref={pickerTriggerRef}
            type="button"
            className="file-picker-trigger"
            onClick={openPicker}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            aria-label={`Choose file. Current file ${currentIndex + 1} of ${files.length}: ${currentFile.path}`}
          >
            <span className="file-count">
              {String(currentIndex + 1).padStart(2, "0")}
              <i>/</i>
              {String(files.length).padStart(2, "0")}
            </span>
            <span className={`status-pin status-pin--${currentFile.status}`} />
            <span className="current-path">{currentFile.path}</span>
            <span className="picker-hint">
              <kbd>⌘</kbd>
              <kbd>K</kbd>
            </span>
          </button>

          <div className="file-stats" aria-label="Change totals">
            <span className={`status-label status-label--${currentFile.status}`}>
              {statusLabel(currentFile.status)}
            </span>
            <span className="addition">+{currentFile.additions}</span>
            <span className="deletion">−{currentFile.deletions}</span>
          </div>

          <button
            type="button"
            className="nav-button nav-button--next"
            onClick={() => move(1)}
            aria-label="Next file"
            title="Next file (Right arrow)"
          >
            <span aria-hidden="true">→</span>
          </button>
        </div>

        <div
          className={`page page--${motion}`}
          key={`${currentFile.path}-${motionKey}`}
          onTouchStart={(event) => {
            const touch = event.touches[0];
            touchStart.current =
              event.touches.length === 1 &&
              touch &&
              !hasSelectedText() &&
              canStartSwipe(event.target)
                ? { x: touch.clientX, y: touch.clientY }
                : null;
          }}
          onTouchEnd={(event) => {
            const start = touchStart.current;
            touchStart.current = null;
            const touch = event.changedTouches[0];
            if (!start || !touch || hasSelectedText()) return;
            const step = swipeStep(start, {
              x: touch.clientX,
              y: touch.clientY,
            });
            if (step) move(step);
          }}
          onTouchCancel={() => {
            touchStart.current = null;
          }}
        >
          <section className="diff-pane" aria-labelledby="diff-heading">
            <div className="pane-heading">
              <div>
                <p className="eyebrow">UNIFIED DIFF</p>
                <h1 id="diff-heading">{currentFile.path.split("/").pop()}</h1>
                {currentFile.oldPath ? (
                  <p className="renamed-from">from {currentFile.oldPath}</p>
                ) : null}
              </div>
              <div className="diff-actions">
                {currentFile.isTruncated ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setExpandedFiles((current) => {
                        const next = new Set(current);
                        if (next.has(currentFile.path)) {
                          next.delete(currentFile.path);
                        } else {
                          next.add(currentFile.path);
                        }
                        return next;
                      })
                    }
                  >
                    {showFull ? "Show excerpt" : "Read full diff"}
                  </button>
                ) : null}
                {currentFile.sourceUrl ? (
                  <a
                    className="text-button"
                    href={currentFile.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open file ↗
                  </a>
                ) : null}
                {currentFile.comparisonUrl ? (
                  <a
                    className="text-button"
                    href={currentFile.comparisonUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open comparison ↗
                  </a>
                ) : null}
              </div>
            </div>

            {currentFile.isBinary ? (
              <div className="diff-scroll">
                <div className="binary-card">
                  <span className="binary-icon" aria-hidden="true">
                    01
                  </span>
                  <p className="eyebrow">BINARY CHANGE</p>
                  <h2>The file contents cannot appear as text.</h2>
                  <p>
                    The change is still part of this set. Read the agent note for
                    its role.
                  </p>
                </div>
              </div>
            ) : (
              <Virtualizer
                className="diff-scroll"
                contentClassName="diff-scroll-content"
              >
                <DiffLines
                  key={showFull ? "full" : "excerpt"}
                  patch={shownPatch}
                />
              </Virtualizer>
            )}

            <footer className="diff-footer">
              <span>
                {showFull || !currentFile.isTruncated
                  ? `${currentFile.totalDiffLines.toLocaleString()} diff lines`
                  : `Excerpt from ${currentFile.totalDiffLines.toLocaleString()} diff lines`}
              </span>
              <span>Use ← → to change files</span>
            </footer>
          </section>

          <aside className="summary-pane" aria-label="Review details">
            <div className="summary-scroll">
              <div
                aria-label="Review details view"
                className="summary-mode-switch"
                role="group"
              >
                <button
                  aria-pressed={summaryMode === "note"}
                  className={summaryMode === "note" ? "is-selected" : ""}
                  id="agent-note-tab"
                  onClick={() => setSummaryMode("note")}
                  type="button"
                >
                  Agent note
                </button>
                <button
                  aria-pressed={summaryMode === "chat"}
                  className={summaryMode === "chat" ? "is-selected" : ""}
                  id="review-chat-tab"
                  onClick={() => setSummaryMode("chat")}
                  type="button"
                >
                  Ask agent
                </button>
              </div>
              <ReviewChatRunningNotice
                chat={chat}
                chatVisible={summaryMode === "chat"}
                currentPath={currentFile.path}
                scope={chatScope}
              />
              {summaryMode === "note" ? (
                <div
                  aria-labelledby="agent-note-tab summary-heading"
                  id="agent-note-panel"
                >
              <div
                className={`summary-kicker ${
                  agentExcluded
                    ? "summary-kicker--excluded"
                    : notesInProgress || noteUnavailable
                    ? "summary-kicker--pending"
                    : ""
                }`}
              >
                <span>
                  {agentExcluded
                    ? "AGENT NOTE · EXCLUDED"
                    : notesInProgress
                    ? "AGENT NOTE · WRITING"
                    : noteUnavailable
                      ? "AGENT NOTE · STOPPED"
                      : "AGENT NOTE"}
                </span>
                <span>
                  {String(currentIndex + 1).padStart(2, "0")} /{" "}
                  {String(files.length).padStart(2, "0")}
                </span>
              </div>

              {agentExcluded ? (
                <div
                  className="excluded-note"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <h2 id="summary-heading">Excluded from agent context</h2>
                  <p className="summary-lead">
                    This patch stays in the local review, but automatic note
                    requests omit it. Direct questions may include this file;
                    review-wide chat still respects exclusions.
                  </p>
                </div>
              ) : notesInProgress ? (
                <div
                  className="summary-loading"
                  role="status"
                  aria-live="polite"
                >
                  <h2 id="summary-heading">Writing summary of diff...</h2>
                  <div className="note-skeleton" aria-hidden="true">
                    <div className="note-skeleton-group">
                      <span className="note-skeleton-line note-skeleton-line--long" />
                      <span className="note-skeleton-line note-skeleton-line--medium" />
                    </div>
                    <div className="note-skeleton-group">
                      <span className="note-skeleton-line note-skeleton-line--label" />
                      <span className="note-skeleton-line note-skeleton-line--long" />
                      <span className="note-skeleton-line note-skeleton-line--short" />
                    </div>
                    <div className="note-skeleton-group">
                      <span className="note-skeleton-line note-skeleton-line--label" />
                      <span className="note-skeleton-line note-skeleton-line--medium" />
                      <span className="note-skeleton-line note-skeleton-line--long" />
                      <span className="note-skeleton-line note-skeleton-line--short" />
                    </div>
                  </div>
                </div>
              ) : noteUnavailable ? (
                <>
                  <h2 id="summary-heading">This note is not ready.</h2>
                  <p className="summary-lead">
                    The agent stopped before it reached this file. The diff is
                    still ready to review.
                  </p>
                  <section className="note-section note-section--pending">
                    <p className="eyebrow">WHAT TO DO</p>
                    <p>
                      Check the terminal error, then start Diffsplain again.
                    </p>
                  </section>
                </>
              ) : (
                <>
                  <h2 id="summary-heading">{currentFile.summary.title}</h2>
                  <p className="summary-lead">{currentFile.summary.what}</p>

                  <section className="note-section">
                    <p className="eyebrow">WHY IT CHANGED</p>
                    <p>{currentFile.summary.why}</p>
                  </section>
                </>
              )}

              {!agentExcluded &&
              !notesInProgress &&
              !noteUnavailable &&
              currentFile.summary.details.length ? (
                <section className="note-section">
                  <p className="eyebrow">KEY DETAILS</p>
                  <ul>
                    {currentFile.summary.details.map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {!agentExcluded &&
              !notesInProgress &&
              !noteUnavailable &&
              currentFile.summary.risks.length ? (
                <section className="note-section note-section--risk">
                  <p className="eyebrow">CHECK CLOSELY</p>
                  <ul>
                    {currentFile.summary.risks.map((risk) => (
                      <li key={risk}>{risk}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
                </div>
              ) : (
                <div
                  aria-labelledby="review-chat-tab"
                  id="review-chat-panel"
                >
                  <ReviewChat
                    agentExcluded={agentExcluded}
                    chat={chat}
                    oldPath={currentFile.oldPath}
                    path={currentFile.path}
                    scope={chatScope}
                    setScope={setChatScope}
                  />
                </div>
              )}
              {snapshot.usage ? (
                <UsagePanel
                  notesGenerating={notesGenerating}
                  usage={snapshot.usage}
                />
              ) : null}
            </div>

            {summaryMode === "note" &&
            !agentExcluded &&
            !notesInProgress &&
            (hasFreshNote || noteUnavailable) ? (
              <footer className="agent-signoff">
                <span className="agent-glyph" aria-hidden="true">
                  ✦
                </span>
                <span>
                  {noteUnavailable
                    ? `${writer} stopped`
                    : `Written by ${writer}`}
                  <small>
                    {noteUnavailable
                      ? noteProgress
                      : `Snapshot ${snapshot.version.slice(0, 10)} · ${new Date(
                          snapshot.generatedAt,
                        ).toLocaleString()}`}
                  </small>
                </span>
              </footer>
            ) : null}
          </aside>
        </div>
      </section>

      {pickerOpen ? (
        <div
          className="picker-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closePicker();
          }}
        >
          <section
            ref={pickerDialogRef}
            className="picker-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Choose a changed file"
          >
            <div className="picker-header">
              <div>
                <p className="eyebrow">ALL CHANGED FILES</p>
                <h2>Jump to a file</h2>
              </div>
              <button
                type="button"
                className="picker-close"
                onClick={closePicker}
                aria-label="Close file picker"
              >
                Esc
              </button>
            </div>

            <label className="picker-search">
              <span aria-hidden="true">⌕</span>
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by path…"
                aria-label="Filter changed files"
                aria-controls="file-picker-list"
              />
              <small aria-live="polite">{visibleFiles.length} files</small>
            </label>

            <div
              ref={pickerListRef}
              className="picker-list"
              id="file-picker-list"
            >
              {visibleFiles.map(({ file, index }) => {
                const active = file.path === currentFile.path;
                const noteState = agentNoteState(file, snapshot.notes);
                return (
                  <button
                    ref={active ? activePickerRowRef : undefined}
                    type="button"
                    className={`picker-row ${active ? "picker-row--active" : ""}`}
                    key={file.path}
                    aria-current={active ? "true" : undefined}
                    onClick={() =>
                      chooseFile(
                        index,
                        index > currentIndex ? "next" : "previous",
                      )
                    }
                  >
                    <span className="picker-index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className={`status-pin status-pin--${file.status}`} />
                    <span className="picker-path">{file.path}</span>
                    <span className="picker-change-count">
                      <i>+{file.additions}</i>
                      <b>−{file.deletions}</b>
                    </span>
                    {noteState ? (
                      <PickerAgentNoteState state={noteState} />
                    ) : null}
                  </button>
                );
              })}
              {!visibleFiles.length ? (
                <p className="picker-empty">No changed file matches “{query}”.</p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      <ConnectionNotice
        demoUnavailable={demoUnavailable}
        message={loadError}
      />
      <span className="sr-only" aria-live="polite">
        {clock >= 0
          ? `Showing ${currentFile.path}, file ${currentIndex + 1} of ${files.length}. ${
              notesGenerating || notesFailed
                ? `${syncLabel}: ${noteProgress}`
                : relativeTime(snapshot.generatedAt)
            }`
          : ""}
      </span>
    </main>
  );
}
