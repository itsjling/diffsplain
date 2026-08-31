import { useEffect, useRef, useState } from "react";

const FALLBACK_POLL_MS = 1_500;

type SnapshotShape = {
  version: string;
  generatedAt: string;
  files: unknown[];
};

type LiveTarget = {
  access: string | null;
  key: string;
  project: string | null;
};

type ConfirmedChatAccess = {
  access: string;
  targetKey: string;
};

type SnapshotSource = "demo" | "live";

type SnapshotResult<T> = {
  next: T;
  source: SnapshotSource;
  staticDemo: boolean;
};

class DemoUnavailableError extends Error {}

function currentTarget(): LiveTarget {
  const session = new URLSearchParams(window.location.hash.slice(1));
  const access = session.get("access");
  const project = session.get("project");
  return {
    access,
    key: `${document.baseURI}|${project ?? ""}|${access ?? ""}`,
    project,
  };
}

function hasSnapshotShape(value: object): value is SnapshotShape {
  const snapshot = value as SnapshotShape;
  return [
    typeof snapshot.version === "string",
    typeof snapshot.generatedAt === "string",
    Array.isArray(snapshot.files),
  ].every(Boolean);
}

async function parseSnapshot(response: Response) {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error("Snapshot data is malformed");
  }
}

function validateSnapshot<T extends SnapshotShape>(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("Snapshot data is malformed");
  }
  if (!hasSnapshotShape(value)) {
    throw new Error("Snapshot data is malformed");
  }
  return value as T;
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Could not read the snapshot";
}

async function checkedSnapshot<T extends SnapshotShape>(response: Response) {
  if (!response.ok) {
    throw new Error(`Snapshot returned ${response.status}`);
  }
  return validateSnapshot<T>(await parseSnapshot(response));
}

async function demoSnapshot<T extends SnapshotShape>(
  response: Promise<Response>,
  staticDemo: boolean,
): Promise<SnapshotResult<T>> {
  try {
    return {
      next: await checkedSnapshot<T>(await response),
      source: "demo",
      staticDemo,
    };
  } catch (error) {
    throw new DemoUnavailableError(errorMessage(error));
  }
}

// fallow-ignore-next-line complexity -- browser tests cover each live and demo result.
async function fetchSnapshot<T extends SnapshotShape>(
  signal: AbortSignal,
  source: SnapshotSource | null,
  target: LiveTarget,
): Promise<SnapshotResult<T>> {
  const liveUrl = new URL("diff-data.json", document.baseURI);
  liveUrl.searchParams.set("t", String(Date.now()));
  if (target.access) liveUrl.searchParams.set("access", target.access);
  const liveResponse = await fetch(liveUrl, {
    cache: "no-store",
    signal,
  });
  const staticDemo =
    liveResponse.headers.get("x-diffsplain-demo") === "true";

  if (liveResponse.status === 404) {
    if (source === "live") throw new Error("Live snapshot is missing");
    return demoSnapshot<T>(
      fetch(new URL("demo-diff-data.json", document.baseURI), { signal }),
      false,
    );
  }
  if (staticDemo) {
    return demoSnapshot<T>(Promise.resolve(liveResponse), true);
  }
  return {
    next: await checkedSnapshot<T>(liveResponse),
    source: "live",
    staticDemo: false,
  };
}

function unavailableRequest(
  active: boolean,
  controller: AbortController,
) {
  return !active || controller.signal.aborted;
}

function validUpdateEvent(event: Event) {
  try {
    const value = JSON.parse((event as MessageEvent<string>).data);
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

export function useLiveSnapshot<T extends SnapshotShape>() {
  const [snapshot, setSnapshot] = useState<T | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [demoUnavailable, setDemoUnavailable] = useState(false);
  const [chatRevision, setChatRevision] = useState(0);
  const [target, setTarget] = useState(currentTarget);
  const [confirmedChatAccess, setConfirmedChatAccess] =
    useState<ConfirmedChatAccess | null>(null);
  const latestVersion = useRef<string | null>(null);
  const source = useRef<SnapshotSource | null>(null);

  useEffect(() => {
    const handleTargetChange = () => {
      const next = currentTarget();
      setTarget((current) => (current.key === next.key ? current : next));
    };
    window.addEventListener("hashchange", handleTargetChange);
    return () => window.removeEventListener("hashchange", handleTargetChange);
  }, []);

  // fallow-ignore-next-line complexity -- one effect owns and cleans up all refresh work.
  useEffect(() => {
    if (demoUnavailable) return;

    let active = true;
    let events: EventSource | undefined;
    let poll: number | undefined;
    let pollingRequest = false;
    let requestNumber = 0;
    let latestSuccessfulRequest = 0;
    const requests = new Set<AbortController>();

    latestVersion.current = null;
    source.current = null;
    setSnapshot(null);
    setFetchError(null);
    setStreamError(null);

    const stopPolling = () => {
      if (poll === undefined) return;
      window.clearInterval(poll);
      poll = undefined;
    };
    const requestRefresh = () => {
      if (active) void refresh();
    };
    const requestPollRefresh = async () => {
      if (!active || pollingRequest) return;
      pollingRequest = true;
      try {
        await refresh();
      } finally {
        pollingRequest = false;
      }
    };
    const startPolling = () => {
      if (poll !== undefined) return;
      poll = window.setInterval(
        () => void requestPollRefresh(),
        FALLBACK_POLL_MS,
      );
    };
    const applySnapshot = (result: SnapshotResult<T>) => {
      source.current = result.source;
      if (result.next.version !== latestVersion.current) {
        latestVersion.current = result.next.version;
        setSnapshot(result.next);
      }
      setFetchError(null);
      if (!result.staticDemo) return;
      stopPolling();
      events?.close();
      setStreamError(null);
    };
    const finishRequest = (
      result: SnapshotResult<T>,
      controller: AbortController,
      request: number,
    ) => {
      if (
        unavailableRequest(active, controller) ||
        request < latestSuccessfulRequest
      ) {
        return;
      }
      latestSuccessfulRequest = request;
      applySnapshot(result);
    };
    const handleFetchError = (error: unknown) => {
      const message = errorMessage(error);
      if (!(error instanceof DemoUnavailableError)) {
        setFetchError(message);
        return;
      }
      setDemoUnavailable(true);
      setFetchError(`Bundled demo is unavailable: ${message}`);
    };
    const failRequest = (
      error: unknown,
      controller: AbortController,
      request: number,
    ) => {
      if (
        unavailableRequest(active, controller) ||
        request !== requestNumber
      ) {
        return;
      }
      handleFetchError(error);
    };

    async function refresh() {
      const request = ++requestNumber;
      const controller = new AbortController();
      requests.add(controller);

      try {
        const result = await fetchSnapshot<T>(
          controller.signal,
          source.current,
          target,
        );
        finishRequest(result, controller, request);
      } catch (error) {
        failRequest(error, controller, request);
      } finally {
        requests.delete(controller);
      }
    }

    const initial = window.setTimeout(requestRefresh, 0);
    if ("EventSource" in window) {
      const eventsUrl = new URL("events", document.baseURI);
      if (target.project) {
        eventsUrl.searchParams.set("project", target.project);
      }
      if (target.access) {
        eventsUrl.searchParams.set("access", target.access);
      }
      events = new EventSource(eventsUrl);
      events.addEventListener("ready", () => {
        if (!active) return;
        stopPolling();
        setStreamError(null);
        setChatRevision((revision) => revision + 1);
        requestRefresh();
      });
      events.addEventListener("update", (event) => {
        if (!active) return;
        if (!validUpdateEvent(event)) {
          setStreamError(
            "A live update was malformed. Polling for the next valid snapshot.",
          );
          startPolling();
        } else {
          stopPolling();
          setStreamError(null);
        }
        requestRefresh();
      });
      events.addEventListener("chat", () => {
        if (!active) return;
        setChatRevision((revision) => revision + 1);
      });
      events.addEventListener("access", (event) => {
        if (!active) return;
        const nextAccess = (event as MessageEvent<string>).data;
        if (!/^[A-Za-z0-9_-]{32,}$/.test(nextAccess)) return;
        const session = new URLSearchParams(window.location.hash.slice(1));
        session.set("access", nextAccess);
        window.history.replaceState(null, "", `#${session}`);
        const nextTarget = currentTarget();
        setConfirmedChatAccess({ access: nextAccess, targetKey: nextTarget.key });
        setTarget((current) =>
          current.key === nextTarget.key ? current : nextTarget,
        );
      });
      events.addEventListener("error", () => {
        if (!active) return;
        setStreamError(
          "Live updates disconnected. Polling while the stream reconnects.",
        );
        startPolling();
      });
    } else {
      setStreamError(
        "Live events are unavailable. Polling for snapshot changes.",
      );
      startPolling();
    }

    return () => {
      active = false;
      window.clearTimeout(initial);
      stopPolling();
      events?.close();
      for (const request of requests) request.abort();
      requests.clear();
    };
  }, [demoUnavailable, target]);

  return {
    access:
      confirmedChatAccess?.targetKey === target.key
        ? confirmedChatAccess.access
        : null,
    chatRevision,
    demoUnavailable,
    loadError: fetchError ?? streamError,
    snapshot,
  };
}
