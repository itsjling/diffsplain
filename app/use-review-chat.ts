import { useCallback, useEffect, useRef, useState } from "react";

const CHAT_GET_TIMEOUT_MS = 10_000;
const CHAT_POST_TIMEOUT_MS = 20_000;
const CHAT_RECONCILE_INTERVAL_MS = 5_000;

export type ChatScope = "review" | "file";

export type ChatCitation = {
  path: string;
  startLine: number;
  endLine: number;
};

export type ChatAnswer = {
  markdown: string;
  citations: ChatCitation[];
};

export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant" | "compacted"; answer: ChatAnswer };

export type ChatStatus =
  | "ready"
  | "running"
  | "compacting"
  | "failed"
  | "cancelled"
  | "blocked"
  | "stale";

export type ReviewChatThread = {
  id: string;
  current: boolean;
  scope: ChatScope;
  path?: string;
  status: ChatStatus;
  messages: ChatMessage[];
  pendingQuestion?: string;
  error?: string;
  canRetry: boolean;
  canRetryCompaction: boolean;
};

export type ReviewChatState = {
  available: boolean;
  fingerprint: string | null;
  snapshotReady: boolean;
  error?: string;
  inputLimitBytes: number;
  stale: boolean;
  threads: ReviewChatThread[];
};

type ChatCommand =
  | { type: "new"; scope: ChatScope; path?: string }
  | { type: "ask"; scope: ChatScope; path?: string; question: string }
  | { type: "cancel" | "retry" | "retry-compaction"; scope: ChatScope; path?: string };

type ThreadTarget = {
  scope: ChatScope;
  path?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

// fallow-ignore-next-line complexity -- This rejects malformed citation ranges at the service boundary.
function readCitation(value: unknown): ChatCitation | undefined {
  if (!isRecord(value)) return undefined;
  const path = readString(value.path);
  const { startLine, endLine } = value;
  if (
    !path ||
    typeof startLine !== "number" ||
    typeof endLine !== "number" ||
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return undefined;
  }
  return { path, startLine, endLine };
}

// fallow-ignore-next-line complexity -- This rejects malformed agent answers at the service boundary.
function readAnswer(value: unknown): ChatAnswer | undefined {
  if (!isRecord(value)) return undefined;
  const markdown = readString(value.markdown);
  if (!markdown || !Array.isArray(value.citations)) return undefined;
  const citations = value.citations.map(readCitation);
  if (citations.some((citation) => !citation)) return undefined;
  return { markdown, citations: citations as ChatCitation[] };
}

// fallow-ignore-next-line complexity -- This decodes the closed message union before the UI renders it.
function readMessage(value: unknown): ChatMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (value.role === "user") {
    const text = readString(value.text);
    return text === undefined ? undefined : { role: "user", text };
  }
  if (value.role === "assistant" || value.role === "compacted") {
    const answer = readAnswer(value.answer);
    return answer ? { role: value.role, answer } : undefined;
  }
  return undefined;
}

const CHAT_STATUSES = new Set<ChatStatus>([
  "ready",
  "running",
  "compacting",
  "failed",
  "cancelled",
  "blocked",
  "stale",
]);

// fallow-ignore-next-line complexity -- This validates the server thread shape before the UI reads it.
function readThread(value: unknown): ReviewChatThread | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  const scope = value.scope;
  const status = value.status;
  if (
    !id ||
    (scope !== "review" && scope !== "file") ||
    typeof value.current !== "boolean" ||
    typeof status !== "string" ||
    !CHAT_STATUSES.has(status as ChatStatus) ||
    !Array.isArray(value.messages)
  ) {
    return undefined;
  }
  const messages = value.messages.map(readMessage);
  if (messages.some((message) => !message)) return undefined;
  const path = readString(value.path);
  if (scope === "file" && !path) return undefined;
  return {
    id,
    current: value.current,
    scope,
    ...(path ? { path } : {}),
    status: status as ChatStatus,
    messages: messages as ChatMessage[],
    ...(readString(value.pendingQuestion)
      ? { pendingQuestion: readString(value.pendingQuestion) }
      : {}),
    ...(readString(value.error) ? { error: readString(value.error) } : {}),
    canRetry: value.canRetry === true,
    canRetryCompaction: value.canRetryCompaction === true,
  };
}

// fallow-ignore-next-line complexity -- This validates the full chat response before it reaches local state.
function readState(value: unknown): ReviewChatState {
  if (!isRecord(value) || !Array.isArray(value.threads)) {
    throw new Error("The chat service returned invalid data.");
  }
  const threads = value.threads.map(readThread);
  if (
    typeof value.available !== "boolean" ||
    typeof value.snapshotReady !== "boolean" ||
    typeof value.stale !== "boolean" ||
    typeof value.inputLimitBytes !== "number" ||
    !Number.isSafeInteger(value.inputLimitBytes) ||
    value.inputLimitBytes < 1 ||
    threads.some((thread) => !thread)
  ) {
    throw new Error("The chat service returned invalid data.");
  }
  return {
    available: value.available,
    fingerprint: readString(value.fingerprint) ?? null,
    snapshotReady: value.snapshotReady,
    ...(readString(value.error) ? { error: readString(value.error) } : {}),
    inputLimitBytes: value.inputLimitBytes,
    stale: value.stale,
    threads: threads as ReviewChatThread[],
  };
}

function endpoint(access: string) {
  const url = new URL("api/chat", document.baseURI);
  url.searchParams.set("access", access);
  return url;
}

async function responseData(response: Response) {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error("The chat service returned invalid data.");
  }
}

function errorFromResponse(value: unknown, status: number) {
  if (isRecord(value) && typeof value.error === "string" && value.error) {
    return value.error;
  }
  return `Chat returned ${status}.`;
}

function commandTarget({ scope, path }: ThreadTarget) {
  return scope === "file" ? { scope, path } : { scope };
}

export function matchingChatThread(
  state: ReviewChatState | null,
  { scope, path }: ThreadTarget,
) {
  return state?.threads.find(
    (thread) =>
      thread.current &&
      thread.scope === scope &&
      (scope === "review" || thread.path === path),
  );
}

export function chatIsRunning(thread: ReviewChatThread | undefined) {
  return thread?.status === "running" || thread?.status === "compacting";
}

// fallow-ignore-next-line complexity -- This hook owns one chat state, refresh path, and command lifecycle.
export function useReviewChat({
  access,
  refreshKey,
}: {
  access: string | null;
  refreshKey: number;
}) {
  const [state, setState] = useState<ReviewChatState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandPending, setCommandPending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const stateRef = useRef<ReviewChatState | null>(null);
  const requestNumber = useRef(0);
  const loadedAccess = useRef<string | null>(null);
  const currentAccess = useRef(access);
  const getController = useRef<AbortController | null>(null);
  const commandInFlight = useRef(false);
  currentAccess.current = access;

  const applyState = useCallback((next: ReviewChatState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const applyResponse = useCallback(
    (next: ReviewChatState, request: number) => {
      if (request !== requestNumber.current) return false;
      applyState(next);
      return true;
    },
    [applyState],
  );

  const reconcileBestEffort = useCallback(
    async ({ preserveError = false }: { preserveError?: boolean } = {}) => {
      if (
        !access ||
        currentAccess.current !== access ||
        commandInFlight.current ||
        getController.current
      ) {
        return;
      }
      const request = ++requestNumber.current;
      const controller = new AbortController();
      getController.current = controller;
      const timeout = window.setTimeout(
        () => controller.abort(),
        CHAT_GET_TIMEOUT_MS,
      );
      try {
        const response = await fetch(endpoint(access), {
          cache: "no-store",
          signal: controller.signal,
        });
        const value = await responseData(response);
        if (!response.ok) throw new Error(errorFromResponse(value, response.status));
        const next = readState(value);
        if (currentAccess.current === access && applyResponse(next, request)) {
          if (!preserveError) setError(null);
        }
      } catch {
      } finally {
        window.clearTimeout(timeout);
        if (getController.current === controller) getController.current = null;
      }
    },
    [access, applyResponse],
  );

  useEffect(() => {
    const accessChanged = loadedAccess.current !== access;
    loadedAccess.current = access;
    if (!access) {
      requestNumber.current += 1;
      applyState(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (accessChanged) applyState(null);
    if (commandInFlight.current) {
      setLoading(false);
      return;
    }
    const request = ++requestNumber.current;
    const controller = new AbortController();
    getController.current?.abort();
    getController.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CHAT_GET_TIMEOUT_MS);
    setLoading(true);
    setError(null);
    void fetch(endpoint(access), {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = await responseData(response);
        if (!response.ok) throw new Error(errorFromResponse(value, response.status));
        return readState(value);
      })
      .then((next) => {
        if (currentAccess.current === access) applyResponse(next, request);
      })
      .catch((nextError: unknown) => {
        if ((!timedOut && controller.signal.aborted) || request !== requestNumber.current) return;
        setError(
          timedOut
            ? "The chat request timed out."
            : nextError instanceof Error
              ? nextError.message
              : "Could not load chat.",
        );
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (getController.current === controller) getController.current = null;
        if (request === requestNumber.current) setLoading(false);
      });
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
      if (getController.current === controller) getController.current = null;
    };
  }, [access, applyResponse, applyState, refreshKey, reloadKey]);

  useEffect(() => {
    if (!access || !state?.threads.some(chatIsRunning)) return;
    const interval = window.setInterval(
      () => void reconcileBestEffort(),
      CHAT_RECONCILE_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [access, reconcileBestEffort, state]);

  const reload = useCallback(() => {
    setReloadKey((current) => current + 1);
  }, []);

  const request = useCallback(
    // fallow-ignore-next-line complexity -- This serializes one command request and keeps prior history on failure.
    async (command: ChatCommand) => {
      if (
        !access ||
        currentAccess.current !== access ||
        commandInFlight.current
      ) {
        return undefined;
      }
      const requestId = ++requestNumber.current;
      const previousGet = getController.current;
      getController.current = null;
      previousGet?.abort();
      commandInFlight.current = true;
      setCommandPending(true);
      setError(null);
      const controller = new AbortController();
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, CHAT_POST_TIMEOUT_MS);
      let ambiguousFailure = false;
      try {
        const response = await fetch(endpoint(access), {
          body: JSON.stringify(command),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        const value = await responseData(response);
        if (!response.ok) throw new Error(errorFromResponse(value, response.status));
        const next = readState(value);
        if (currentAccess.current === access) applyResponse(next, requestId);
        return next;
      } catch (nextError) {
        ambiguousFailure = true;
        if (requestId === requestNumber.current) {
          setError(
            timedOut
              ? "The chat command timed out. Checking its status."
              : nextError instanceof Error
                ? nextError.message
                : "Could not update chat.",
          );
        }
        return undefined;
      } finally {
        window.clearTimeout(timeout);
        commandInFlight.current = false;
        setCommandPending(false);
        if (ambiguousFailure) void reconcileBestEffort({ preserveError: true });
      }
    },
    [access, applyResponse, reconcileBestEffort],
  );

  const newThread = useCallback(
    (target: ThreadTarget) => request({ type: "new", ...commandTarget(target) }),
    [request],
  );

  const sendQuestion = useCallback(
    async (target: ThreadTarget, question: string) => {
      const existing = matchingChatThread(stateRef.current, target);
      const current =
        !existing || existing.status === "stale"
          ? await newThread(target)
          : stateRef.current;
      if (!current) return undefined;
      return request({
        type: "ask",
        ...commandTarget(target),
        question,
      });
    },
    [newThread, request],
  );

  const cancel = useCallback(
    (thread: ReviewChatThread) =>
      request({ type: "cancel", ...commandTarget(thread) }),
    [request],
  );
  const retry = useCallback(
    (thread: ReviewChatThread) =>
      request({ type: "retry", ...commandTarget(thread) }),
    [request],
  );
  const retryCompaction = useCallback(
    (thread: ReviewChatThread) =>
      request({ type: "retry-compaction", ...commandTarget(thread) }),
    [request],
  );

  return {
    access,
    cancel,
    commandPending,
    error,
    loading,
    newThread,
    retry,
    retryCompaction,
    reload,
    sendQuestion,
    state,
  };
}
