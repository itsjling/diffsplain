import { useCallback, useEffect, useRef, useState } from "react";

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
  currentAccess.current = access;

  const applyState = useCallback((next: ReviewChatState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    const request = ++requestNumber.current;
    const accessChanged = loadedAccess.current !== access;
    loadedAccess.current = access;
    if (!access) {
      applyState(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (accessChanged) applyState(null);
    const controller = new AbortController();
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
        if (request === requestNumber.current) applyState(next);
      })
      .catch((nextError: unknown) => {
        if (controller.signal.aborted || request !== requestNumber.current) return;
        setError(
          nextError instanceof Error ? nextError.message : "Could not load chat.",
        );
      })
      .finally(() => {
        if (request === requestNumber.current) setLoading(false);
      });
    return () => controller.abort();
  }, [access, applyState, refreshKey, reloadKey]);

  const reload = useCallback(() => {
    setReloadKey((current) => current + 1);
  }, []);

  const request = useCallback(
    // fallow-ignore-next-line complexity -- This serializes one command request and keeps prior history on failure.
    async (command: ChatCommand) => {
      if (!access || currentAccess.current !== access || commandPending) {
        return undefined;
      }
      const requestId = ++requestNumber.current;
      setCommandPending(true);
      setError(null);
      try {
        const response = await fetch(endpoint(access), {
          body: JSON.stringify(command),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const value = await responseData(response);
        if (!response.ok) throw new Error(errorFromResponse(value, response.status));
        const next = readState(value);
        if (requestId === requestNumber.current) applyState(next);
        return next;
      } catch (nextError) {
        if (requestId === requestNumber.current) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Could not update chat.",
          );
        }
        return undefined;
      } finally {
        setCommandPending(false);
      }
    },
    [access, applyState, commandPending],
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
