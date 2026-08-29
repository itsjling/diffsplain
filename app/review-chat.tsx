import { type KeyboardEvent, useMemo, useState } from "react";
import { SafeMarkdown } from "./safe-markdown";
import {
  chatIsRunning,
  matchingChatThread,
  type ChatScope,
  type ReviewChatState,
  type ReviewChatThread,
} from "./use-review-chat";

export type ReviewChatController = {
  access: string | null;
  cancel: (thread: ReviewChatThread) => Promise<ReviewChatState | undefined>;
  commandPending: boolean;
  error: string | null;
  loading: boolean;
  newThread: (target: { scope: ChatScope; path?: string }) => Promise<
    ReviewChatState | undefined
  >;
  retry: (thread: ReviewChatThread) => Promise<ReviewChatState | undefined>;
  retryCompaction: (
    thread: ReviewChatThread,
  ) => Promise<ReviewChatState | undefined>;
  reload: () => void;
  sendQuestion: (
    target: { scope: ChatScope; path?: string },
    question: string,
  ) => Promise<ReviewChatState | undefined>;
  state: ReviewChatState | null;
};

type ThreadTarget = { scope: ChatScope; path?: string };

function targetFor(scope: ChatScope, path: string): ThreadTarget {
  return scope === "file" ? { scope, path } : { scope };
}

function visibleThreads(
  state: ReviewChatState | null,
  scope: ChatScope,
  path: string,
  oldPath?: string,
) {
  const matchingPaths = new Set([path, oldPath].filter(Boolean));
  return (state?.threads ?? [])
    .filter(
      (thread) =>
        thread.scope === scope &&
        (scope === "review" || Boolean(thread.path && matchingPaths.has(thread.path))),
    )
    .sort((left, right) => Number(right.current) - Number(left.current));
}

const STATUS_TITLES: Record<ReviewChatThread["status"], string> = {
  blocked: "This thread needs a new step",
  cancelled: "The answer was cancelled",
  compacting: "Compacting prior history",
  failed: "The answer failed",
  ready: "Ready for a question",
  running: "Writing an answer",
  stale: "This history is from an earlier review",
};

function statusTitle(status: ReviewChatThread["status"]) {
  return STATUS_TITLES[status];
}

function citationLabel(citation: { path: string; startLine: number; endLine: number }) {
  const lines =
    citation.startLine === citation.endLine
      ? String(citation.startLine)
      : `${citation.startLine}–${citation.endLine}`;
  return `${citation.path}:${lines}`;
}

function ChatMessages({ threads }: { threads: ReviewChatThread[] }) {
  return (
    <div className="chat-history" aria-live="polite">
      {threads.map((thread) => (
        <section className="chat-thread" key={thread.id}>
          {!thread.current ? (
            <p className="chat-history-label">Stale history</p>
          ) : null}
          {thread.messages.map((message, index) => {
            if (message.role === "user") {
              return (
                <article className="chat-message chat-message--user" key={`${thread.id}-${index}`}>
                  <p className="chat-message-label">Question</p>
                  <p className="chat-question">{message.text}</p>
                </article>
              );
            }
            const label = message.role === "compacted" ? "Earlier context" : "Answer";
            return (
              <article className="chat-message chat-message--assistant" key={`${thread.id}-${index}`}>
                <p className="chat-message-label">{label}</p>
                <SafeMarkdown markdown={message.answer.markdown} />
                {message.answer.citations.length ? (
                  <div className="chat-citations" aria-label="Source citations">
                    {message.answer.citations.map((citation, citationIndex) => (
                      <span className="chat-citation" key={`${citation.path}-${citationIndex}`}>
                        {citationLabel(citation)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function canStartNewThread(thread: ReviewChatThread) {
  return (
    thread.status === "stale" ||
    (thread.status === "blocked" && !thread.canRetryCompaction)
  );
}

// fallow-ignore-next-line complexity -- This renders the allowed server actions for one thread state.
function ThreadActions({
  chat,
  target,
  thread,
}: {
  chat: ReviewChatController;
  target: ThreadTarget;
  thread: ReviewChatThread;
}) {
  return (
    <div className="chat-state-actions">
      {chatIsRunning(thread) ? (
        <button
          className="chat-action chat-action--quiet"
          disabled={chat.commandPending}
          onClick={() => void chat.cancel(thread)}
          type="button"
        >
          Cancel
        </button>
      ) : null}
      {thread.canRetry ? (
        <button
          className="chat-action"
          disabled={chat.commandPending}
          onClick={() => void chat.retry(thread)}
          type="button"
        >
          Retry
        </button>
      ) : null}
      {thread.canRetryCompaction ? (
        <button
          className="chat-action"
          disabled={chat.commandPending}
          onClick={() => void chat.retryCompaction(thread)}
          type="button"
        >
          Retry compaction
        </button>
      ) : null}
      {canStartNewThread(thread) ? (
        <button
          className="chat-action"
          disabled={chat.commandPending}
          onClick={() => void chat.newThread(target)}
          type="button"
        >
          Start new thread
        </button>
      ) : null}
    </div>
  );
}

// fallow-ignore-next-line complexity -- This renders the server-reported state and actions for one thread.
function ThreadState({
  chat,
  target,
  thread,
}: {
  chat: ReviewChatController;
  target: ThreadTarget;
  thread: ReviewChatThread;
}) {
  if (thread.status === "ready") return null;
  return (
    <section className={`chat-thread-state chat-thread-state--${thread.status}`} role="status">
      <div>
        <h3>{statusTitle(thread.status)}</h3>
        {thread.error ? <p>{thread.error}</p> : null}
        {thread.pendingQuestion && !chatIsRunning(thread) ? (
          <p className="chat-pending-question">Pending: {thread.pendingQuestion}</p>
        ) : null}
      </div>
      <ThreadActions chat={chat} target={target} thread={thread} />
    </section>
  );
}

const COMPOSER_COPY: Record<ChatScope, { label: string; placeholder: string }> = {
  file: {
    label: "Ask about this file",
    placeholder: "Ask about this change, its risks, or a line of code.",
  },
  review: {
    label: "Ask about this review",
    placeholder: "Ask how the changes fit together.",
  },
};

function composerIsWaiting(thread: ReviewChatThread | undefined) {
  return Boolean(thread && thread.status !== "ready" && thread.status !== "stale");
}

function sendFromShortcut(
  event: KeyboardEvent<HTMLTextAreaElement>,
  send: () => void,
) {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    send();
  }
}

// fallow-ignore-next-line complexity -- This keeps one controlled question field, submit path, and shortcut together.
function ChatComposer({
  chat,
  scope,
  path,
  thread,
}: {
  chat: ReviewChatController;
  scope: ChatScope;
  path: string;
  thread: ReviewChatThread | undefined;
}) {
  const [question, setQuestion] = useState("");
  const target = targetFor(scope, path);
  const disabled = chat.commandPending || composerIsWaiting(thread);
  const { label, placeholder } = COMPOSER_COPY[scope];

  async function send() {
    const trimmed = question.trim();
    if (!trimmed || disabled) return;
    const result = await chat.sendQuestion(target, trimmed);
    if (result) setQuestion("");
  }

  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label htmlFor="review-chat-question">{label}</label>
      <textarea
        disabled={disabled}
        id="review-chat-question"
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => sendFromShortcut(event, () => void send())}
        placeholder={placeholder}
        rows={4}
        value={question}
      />
      <div className="chat-composer-footer">
        <span>Cmd/Ctrl+Enter sends</span>
        <button className="chat-send" disabled={disabled || !question.trim()} type="submit">
          Ask agent
        </button>
      </div>
    </form>
  );
}

function backgroundDetail(background: ReviewChatThread, currentPath: string) {
  if (background.scope === "review") return "the review";
  if (background.path === currentPath) return "this file";
  return background.path ?? "another file";
}

function hiddenRunningThreads(
  state: ReviewChatState | null,
  chatVisible: boolean,
  currentPath: string,
  scope: ChatScope,
) {
  const running = (state?.threads ?? []).filter(chatIsRunning);
  if (!chatVisible) return running;
  const current = matchingChatThread(state, targetFor(scope, currentPath));
  return running.filter((thread) => thread.id !== current?.id);
}

export function ReviewChatRunningNotice({
  chat,
  chatVisible,
  currentPath,
  scope,
}: {
  chat: ReviewChatController;
  chatVisible: boolean;
  currentPath: string;
  scope: ChatScope;
}) {
  const hidden = hiddenRunningThreads(
    chat.state,
    chatVisible,
    currentPath,
    scope,
  );
  if (!hidden.length) return null;
  return (
    <div aria-label="Running chat answers">
      {hidden.map((thread) => (
        <section className="chat-background-notice" key={thread.id} role="status">
          <p>Still answering about {backgroundDetail(thread, currentPath)}.</p>
          <button
            className="chat-action chat-action--quiet"
            disabled={chat.commandPending}
            onClick={() => void chat.cancel(thread)}
            type="button"
          >
            Cancel
          </button>
        </section>
      ))}
    </div>
  );
}

// fallow-ignore-next-line complexity -- This is the visible state renderer for mutually exclusive chat service states.
export function ReviewChat({
  agentExcluded,
  chat,
  oldPath,
  path,
  scope,
  setScope,
}: {
  agentExcluded: boolean;
  chat: ReviewChatController;
  oldPath?: string;
  path: string;
  scope: ChatScope;
  setScope: (scope: ChatScope) => void;
}) {
  const target = targetFor(scope, path);
  const threads = useMemo(
    () => visibleThreads(chat.state, scope, path, oldPath),
    [chat.state, oldPath, path, scope],
  );
  const current = matchingChatThread(chat.state, target);
  const hasStaleHistory = threads.some((thread) => thread.status === "stale");
  const canCompose =
    Boolean(chat.state?.available) &&
    Boolean(chat.state?.snapshotReady) &&
    !chat.state?.error &&
    (!current || current.status === "ready" || current.status === "stale");

  return (
    <div className="review-chat" aria-labelledby="chat-heading">
      <div className="chat-heading-row">
        <div>
          <h2 id="chat-heading">Ask the agent</h2>
          <p>Keep questions tied to the review evidence.</p>
        </div>
        <div aria-label="Chat scope" className="chat-scope" role="group">
          <button
            aria-pressed={scope === "file"}
            className={scope === "file" ? "chat-scope-option is-selected" : "chat-scope-option"}
            onClick={() => setScope("file")}
            type="button"
          >
            This file
          </button>
          <button
            aria-pressed={scope === "review"}
            className={scope === "review" ? "chat-scope-option is-selected" : "chat-scope-option"}
            onClick={() => setScope("review")}
            type="button"
          >
            Review
          </button>
        </div>
      </div>

      {agentExcluded ? (
        <p className="chat-exclusion-note">
          Direct questions can include this file. Review-wide chat still respects exclusions.
        </p>
      ) : null}

      {!chat.access ? (
        <section className="chat-empty-state" role="status">
          <h3>Chat opens in a live review.</h3>
          <p>Start Diffsplain with an access token and a selected agent to ask questions here.</p>
        </section>
      ) : chat.loading && !chat.state ? (
        <section className="chat-empty-state" role="status">
          <h3>Loading chat history.</h3>
          <p>Checking the current review before questions can start.</p>
        </section>
      ) : !chat.state && chat.error ? (
        <section className="chat-empty-state chat-empty-state--error" role="status">
          <h3>Chat could not connect.</h3>
          <p>{chat.error}</p>
          <button
            className="chat-action"
            disabled={chat.loading}
            onClick={chat.reload}
            type="button"
          >
            Try again
          </button>
        </section>
      ) : !chat.state?.available ? (
        <section className="chat-empty-state" role="status">
          <h3>No chat agent is available.</h3>
          <p>Start Diffsplain with a coding agent, then return to this review.</p>
        </section>
      ) : !chat.state.snapshotReady ? (
        <section className="chat-empty-state chat-empty-state--error" role="status">
          <h3>Chat is waiting for the review.</h3>
          <p>{chat.state.error ?? "The current review snapshot is recovering. Try again when it is ready."}</p>
        </section>
      ) : (
        <>
          {chat.error ? (
            <section className="chat-transient-error" role="status">
              <h3>Chat could not update.</h3>
              <p>{chat.error}</p>
            </section>
          ) : null}
          {chat.state.error ? (
            <section className="chat-transient-error chat-transient-error--recovery" role="status">
              <h3>Chat is waiting for the current review.</h3>
              <p>{chat.state.error}</p>
            </section>
          ) : null}
          {threads.length ? <ChatMessages threads={threads} /> : null}
          {current ? (
            <ThreadState chat={chat} target={target} thread={current} />
          ) : !chat.state.error ? (
            <section className="chat-empty-state">
              <h3>Ask about {scope === "file" ? "this file" : "the review"}.</h3>
              <p>Your first question starts a thread for this review version.</p>
              {hasStaleHistory ? (
                <button
                  className="chat-action"
                  disabled={chat.commandPending}
                  onClick={() => void chat.newThread(target)}
                  type="button"
                >
                  Start new thread
                </button>
              ) : null}
            </section>
          ) : null}
          {canCompose ? (
            <ChatComposer
              chat={chat}
              key={scope === "file" ? `file:${path}` : "review"}
              path={path}
              scope={scope}
              thread={current}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
