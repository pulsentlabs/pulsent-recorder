// Minimal PostHog interface — no posthog-js dependency needed.
//
// posthog-js types the `loaded` callback parameter as
// `PostHogInterface = Omit<PostHog, 'config' | 'init'>`, which strips
// `config` from the type even though the runtime object always has it.
// We keep `config` optional here so users can pass either the full
// PostHog instance or the `loaded` callback parameter without type errors.
// At runtime we assert `config` exists — it always does.
interface PostHogLike {
  set_config(config: { before_send?: unknown }): void;
  onSessionId(
    callback: (
      sessionId: string,
      windowId: string | null | undefined,
      changeReason?: {
        noSessionId?: boolean;
        activityTimeout?: boolean;
        sessionPastMaximumLength?: boolean;
      },
    ) => void,
  ): () => void;
  config?: {
    token: string;
    before_send?: unknown;
  };
}

/**
 * Compatible with posthog-js BeforeSendFn / CaptureResult.
 * We use `any` for the public handler type so it's assignable to PostHog's
 * `before_send` without users needing type casts — the actual shapes evolve
 * across posthog-js versions and we only inspect `event` + `properties`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BeforeSendFn = (event: any) => any;

const API_HOST = "https://api.pulsent.ai";
const PREFIX = "[pulsent-recorder]";
const VERSION = "0.2.4";

// ----- Worker-based ingest fetch ------------------------------------------
//
// PostHog's session-replay network plugin patches `window.fetch` and
// `XMLHttpRequest` so it can capture outgoing requests as part of the rrweb
// stream. If we forward each `$snapshot` via main-thread fetch, PostHog
// records our forward → that becomes a new rrweb network event → it gets
// buffered → PostHog's 2-second flush timer emits another `$snapshot` →
// which we then forward again. The result is a self-sustaining ~2s loop
// that fires snapshots indefinitely.
//
// Routing the fetch through a Web Worker breaks the loop:
//   * the worker has its own `self.fetch`, untouched by the page's patches,
//   * worker resource timings stay in the worker's perf buffer, so the
//     main-thread `PerformanceObserver` PostHog uses can't see them either.
//
// We create the worker lazily on first use, from an inline Blob URL, so
// the SDK stays single-file. If creation fails (e.g. CSP forbids `blob:`
// workers) we fall back to direct fetch — accepting the loop in that
// environment is better than dropping snapshots entirely.

let _ingestWorker: Worker | null = null;
let _ingestWorkerUnavailable = false;
// Set to true the first time any caller passes debug=true. The worker is a
// shared singleton, so we can't gate logging per-instance — but in practice
// there is only ever one PulsentRecorder per page.
let _ingestWorkerDebug = false;

function _getIngestWorker(debug: boolean): Worker | null {
  if (debug) _ingestWorkerDebug = true;
  if (_ingestWorkerUnavailable) return null;
  if (_ingestWorker) return _ingestWorker;
  if (
    typeof Worker === "undefined" ||
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    _ingestWorkerUnavailable = true;
    return null;
  }
  try {
    // Tiny worker: receives { url, headers, body }, fires the POST, posts
    // back a status message we log when debug=true. Fire-and-forget; we do
    // not correlate individual requests with responses.
    const code =
      "self.onmessage=function(e){" +
      "var d=e.data;" +
      "fetch(d.url,{method:'POST',headers:d.headers,body:d.body})" +
      ".then(function(r){self.postMessage({ok:r.ok,status:r.status,statusText:r.statusText});})" +
      ".catch(function(err){self.postMessage({ok:false,error:String(err)});});" +
      "};";
    const blob = new Blob([code], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    _ingestWorker = new Worker(blobUrl);
    URL.revokeObjectURL(blobUrl);
    _ingestWorker.onmessage = (e: MessageEvent) => {
      if (!_ingestWorkerDebug) return;
      const d = e.data as {
        ok: boolean;
        status?: number;
        statusText?: string;
        error?: string;
      };
      if (d.ok) {
        console.log(PREFIX, `ingest OK — ${d.status}`);
      } else {
        console.warn(
          PREFIX,
          `ingest failed — ${d.status ?? ""} ${d.statusText ?? ""} ${d.error ?? ""}`.trim(),
        );
      }
    };
    _ingestWorker.onerror = (e: ErrorEvent) => {
      if (_ingestWorkerDebug) console.warn(PREFIX, "worker error —", e.message);
    };
    return _ingestWorker;
  } catch {
    _ingestWorkerUnavailable = true;
    return null;
  }
}

function _postIngest(opts: {
  url: string;
  token: string;
  body: string;
  debug: boolean;
}): void {
  const headers = {
    "Content-Type": "application/json",
    "X-PostHog-Token": opts.token,
  };

  const worker = _getIngestWorker(opts.debug);
  if (worker) {
    try {
      worker.postMessage({ url: opts.url, headers, body: opts.body });
      return;
    } catch {
      // fall through to direct fetch
    }
  }

  fetch(opts.url, {
    method: "POST",
    headers,
    body: opts.body,
  })
    .then((res) => {
      if (opts.debug) {
        if (res.ok) {
          console.log(PREFIX, `ingest OK — ${res.status}`);
        } else {
          console.warn(
            PREFIX,
            `ingest failed — ${res.status} ${res.statusText}`,
          );
        }
      }
    })
    .catch((err) => {
      if (opts.debug) console.warn(PREFIX, "ingest error —", err);
    });
}

/** Read posthog.config.token — always exists at runtime even when typed away. */
function getToken(posthog: PostHogLike): string {
  const token = (posthog as { config?: { token?: string } }).config?.token;
  if (!token) throw new Error(`${PREFIX} PostHog instance has no config.token`);
  return token;
}

/** Read posthog.config.before_send — may be undefined. */
function getBeforeSend(posthog: PostHogLike): unknown {
  return (posthog as { config?: { before_send?: unknown } }).config
    ?.before_send;
}

export interface PulsentRecorderConfig {
  /** PostHog instance from your app — token is read automatically. */
  posthog: PostHogLike;
  /** Enable console logging for debugging. */
  debug?: boolean;
  /** Override the Pulsent API URL. Useful for local development (e.g. "http://localhost:8000"). */
  apiHost?: string;
  /** @internal Skip before_send registration (already handled by beforeSendHandler). */
  _skipBeforeSend?: boolean;
}

export class PulsentRecorder {
  private currentSessionId: string | null = null;
  private unsubscribeSessionId: (() => void) | null = null;
  private handleUnload: (() => void) | null = null;

  private readonly apiHost: string;

  private constructor(private readonly config: PulsentRecorderConfig) {
    this.apiHost = config.apiHost ?? API_HOST;
  }

  private _log(...args: unknown[]): void {
    if (this.config.debug) console.log(PREFIX, ...args);
  }

  private _warn(...args: unknown[]): void {
    if (this.config.debug) console.warn(PREFIX, ...args);
  }

  static init(config: PulsentRecorderConfig): PulsentRecorder {
    const instance = new PulsentRecorder(config);
    instance._setup();
    return instance;
  }

  /**
   * Create a `before_send` handler to pass directly into PostHog's config.
   * This ensures snapshot interception is active from the very first event,
   * avoiding the race condition where PostHog starts recording from persisted
   * config before `PulsentRecorder.init()` can hook in.
   *
   * Usage:
   *   const swish = PulsentRecorder.beforeSendHandler({ apiHost: '...' })
   *   posthog.init(token, { before_send: swish.handler })
   *   // later, after posthog is ready:
   *   swish.bind(posthog)   // starts session lifecycle tracking
   */
  static beforeSendHandler(opts?: {
    apiHost?: string;
    debug?: boolean;
  }): { handler: BeforeSendFn; bind: (posthog: PostHogLike) => PulsentRecorder } {
    const apiHost = opts?.apiHost ?? API_HOST;
    const debug = opts?.debug ?? false;
    let token: string | null = null;
    let pendingSnapshots: { props: Record<string, unknown>; ts: number }[] = [];

    const log = (...args: unknown[]) => {
      if (debug) console.log(PREFIX, ...args);
    };
    const warn = (...args: unknown[]) => {
      if (debug) console.warn(PREFIX, ...args);
    };

    const sendSnapshot = (props: Record<string, unknown>, ts: number) => {
      _postIngest({
        url: `${apiHost}/replays/ingest`,
        token: token!,
        body: JSON.stringify({
          session_id: props.$session_id,
          window_id: props.$window_id,
          snapshot_data: props.$snapshot_data,
          distinct_id: props.distinct_id,
          timestamp: ts,
          sdk_version: VERSION,
        }),
        debug,
      });
    };

    const handler: BeforeSendFn = (event) => {
      if (event?.event === "$snapshot") {
        const props = event.properties;
        const ts = Date.now();
        if (token) {
          sendSnapshot(props, ts);
        } else {
          // Buffer until bind() provides the token
          pendingSnapshots.push({ props, ts });
          log(`buffered snapshot (pre-bind) — ${pendingSnapshots.length} pending`);
        }
      }
      return event;
    };

    const bind = (posthog: PostHogLike): PulsentRecorder => {
      token = getToken(posthog);
      log(`bind — token=${token.slice(0, 12)}…`);

      // Flush any snapshots captured before bind
      if (pendingSnapshots.length > 0) {
        log(`flushing ${pendingSnapshots.length} buffered snapshots`);
        for (const { props, ts } of pendingSnapshots) {
          sendSnapshot(props, ts);
        }
        pendingSnapshots = [];
      }

      return PulsentRecorder.init({ posthog, apiHost, debug, _skipBeforeSend: true });
    };

    return { handler, bind };
  }

  private _sendSessionEnd(sessionId: string, reason: string): void {
    this._log(`session end — session=${sessionId} reason=${reason}`);
    navigator.sendBeacon(
      `${this.apiHost}/replays/session-end`,
      new Blob(
        [
          JSON.stringify({
            session_id: sessionId,
            reason,
            token: getToken(this.config.posthog),
          }),
        ],
        { type: "application/json" },
      ),
    );
  }

  private _ingestSnapshot(
    sessionId: string,
    windowId: string,
    snapshotData: unknown,
    distinctId: string,
  ): void {
    this._log(
      `ingesting snapshot — session=${sessionId} window=${windowId} distinct_id=${distinctId}`,
    );
    _postIngest({
      url: `${this.apiHost}/replays/ingest`,
      token: getToken(this.config.posthog),
      body: JSON.stringify({
        session_id: sessionId,
        window_id: windowId,
        snapshot_data: snapshotData,
        distinct_id: distinctId,
        timestamp: Date.now(),
        sdk_version: VERSION,
      }),
      debug: this.config.debug ?? false,
    });
  }

  private _setup(): void {
    const { posthog } = this.config;
    let token: string;
    try {
      token = getToken(posthog);
    } catch {
      this._warn("no PostHog token found — recording disabled");
      return;
    }

    this._log(`init — token=${token.slice(0, 12)}…`);

    // 1. Intercept $snapshot events via before_send (non-destructive append)
    //    Skip if already registered via beforeSendHandler()
    if (!this.config._skipBeforeSend) {
      const snapshotHandler: BeforeSendFn = (event) => {
        if (event?.event === "$snapshot") {
          const props = event.properties;
          this._ingestSnapshot(
            props.$session_id as string,
            props.$window_id as string,
            props.$snapshot_data,
            props.distinct_id as string,
          );
        } else if (this.config.debug && event) {
          this._log(`before_send passthrough — event=${event.event}`);
        }
        return event;
      };

      const existing = getBeforeSend(posthog);
      this._log(
        `before_send — existing handler: ${existing ? (Array.isArray(existing) ? `array(${(existing as unknown[]).length})` : "function") : "none"}`,
      );
      posthog.set_config({
        before_send: existing
          ? Array.isArray(existing)
            ? [...(existing as BeforeSendFn[]), snapshotHandler]
            : [existing as BeforeSendFn, snapshotHandler]
          : snapshotHandler,
      });
    } else {
      this._log("before_send — already registered via beforeSendHandler()");
    }

    // 2. Session rotation signal — fires on idle timeout or max session length
    this.unsubscribeSessionId = posthog.onSessionId(
      (newSessionId, _windowId, changeReason) => {
        this._log(
          `session ID changed — new=${newSessionId} reason=${JSON.stringify(changeReason ?? null)}`,
        );
        if (this.currentSessionId && changeReason) {
          const reason = changeReason.activityTimeout
            ? "activity_timeout"
            : changeReason.sessionPastMaximumLength
              ? "session_length"
              : null;
          if (reason) this._sendSessionEnd(this.currentSessionId, reason);
        }
        this.currentSessionId = newSessionId;
      },
    );

    // 3. Tab close — sendBeacon survives page unload, fetch does not
    this.handleUnload = () => {
      if (this.currentSessionId)
        this._sendSessionEnd(this.currentSessionId, "tab_close");
    };
    window.addEventListener("beforeunload", this.handleUnload);

    this._log("ready");
  }

  destroy(): void {
    this._log("destroy");
    this.unsubscribeSessionId?.();
    if (this.handleUnload) {
      window.removeEventListener("beforeunload", this.handleUnload);
    }
    this.unsubscribeSessionId = null;
    this.handleUnload = null;
  }
}
