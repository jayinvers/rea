import type { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import type { CdpNetworkEventSource } from "./CdpCaptureEventTypes.js";
import { cdpStringValue, recordValue } from "./CdpCaptureValues.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import type { CdpEvent } from "./CdpConnection.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import type { CaptureContext } from "./CdpPageCapture.js";

/** Only this page's dedicated workers attach; every other child is excluded. */
const WORKER_FILTER = [
  { type: "worker", exclude: false },
  { exclude: true },
] as const;

/**
 * One bound for waiting on worker sessions and for releasing them, mirroring
 * `cleanupCdpTargetCommands`: the owning page-session detach and transport
 * close remain the definitive release boundary.
 */
const WORKER_SESSION_DEADLINE_MS = 1_000;

/** An admitted worker session and the signal its detach fires. */
interface AdmittedWorkerSession {
  readonly targetId: string;
  readonly detach: AbortController;
}

/**
 * Bind one command to the capture's cancellation and a worker session's
 * detach signal, so commands to an exited worker settle immediately instead
 * of waiting out a transport deadline Chromium will never answer.
 */
export const workerCommandSignal = (
  capture: AbortSignal | undefined,
  workerDetach: AbortSignal,
): AbortSignal =>
  capture === undefined
    ? workerDetach
    : AbortSignal.any([capture, workerDetach]);

/**
 * Multiplexes Network events from dedicated worker sessions that Chromium
 * flattens onto the page connection. Attaching a session never pauses or
 * otherwise alters the worker: auto-attach runs with
 * `waitForDebuggerOnStart` disabled, and worker sessions receive only
 * `Network.enable` plus their own `Target.setAutoAttach` so workers they
 * start are observed too.
 */
export class CdpPageCaptureWorkerSessions {
  readonly #context: CaptureContext;
  readonly #limitations: string[];
  readonly #completeness: CdpCaptureCompleteness;
  readonly #workerTargets = new Map<string, AdmittedWorkerSession>();
  readonly #pendingEnables = new Set<Promise<void>>();
  #failure: { readonly cause: unknown } | undefined;
  #admitting = true;
  #notedUnsettledEnables = false;
  #notedUnadmittedWorkers = false;

  constructor(
    context: CaptureContext,
    limitations: string[],
    completeness: CdpCaptureCompleteness,
  ) {
    this.#context = context;
    this.#limitations = limitations;
    this.#completeness = completeness;
  }

  /**
   * Ask Chromium to flatten this page's dedicated workers onto the connection.
   * Browsers without the command keep the capture working with worker network
   * activity unobserved and an explicit limitation.
   */
  async enable(): Promise<void> {
    const attached = await optionalCdpCommand(
      this.#context,
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: WORKER_FILTER,
      },
      this.#limitations,
    );
    if (attached === undefined) this.#completeness.attachLimited("workers");
  }

  /**
   * Track child attach and detach notifications wherever Chromium delivers
   * them: on the page session for this page's workers, and on an admitted
   * worker session for workers that worker starts. A session this capture
   * never attached cannot grow the admission set.
   */
  observe(event: CdpEvent): void {
    if (
      event.method !== "Target.attachedToTarget" &&
      event.method !== "Target.detachedFromTarget"
    )
      return;
    if (
      event.sessionId !== this.#context.sessionId &&
      (event.sessionId === undefined ||
        !this.#workerTargets.has(event.sessionId))
    )
      return;
    if (event.method === "Target.attachedToTarget")
      this.#admitWorkerSession(event.params);
    else this.#releaseWorkerSession(event.params);
  }

  /** Worker attribution for events observed on one admitted worker session. */
  sourceFor(sessionId: string | undefined): CdpNetworkEventSource | undefined {
    const worker =
      sessionId === undefined ? undefined : this.#workerTargets.get(sessionId);
    return worker === undefined
      ? undefined
      : { worker_target_id: worker.targetId };
  }

  /**
   * Session and detach signal that currently observe the identified worker,
   * if that worker is still attached.
   */
  admittedWorker(
    workerTargetId: string,
  ):
    | { readonly sessionId: string; readonly detachSignal: AbortSignal }
    | undefined {
    for (const [sessionId, worker] of this.#workerTargets)
      if (worker.targetId === workerTargetId)
        return { sessionId, detachSignal: worker.detach.signal };
    return undefined;
  }

  /**
   * Stop admitting newly attached workers. Already-admitted sessions and
   * their events keep flowing until release; workers that attach afterwards
   * are reported as attach-limited instead of being silently unobserved.
   */
  stopAdmitting(): void {
    this.#admitting = false;
  }

  /**
   * Wait for every worker `Network.enable` sent so far under one bounded
   * deadline combined with the capture's cancellation, so a page that keeps
   * starting workers cannot stall the capture indefinitely. The first
   * failure that is not an expected worker termination is rethrown with its
   * original error semantics, because worker traffic would otherwise
   * silently vanish; when the deadline passes first, the capture proceeds
   * with what settled and records the unresolved remainder.
   */
  async settle(): Promise<void> {
    await this.#drainEnables();
    if (this.#failure !== undefined) throw this.#failure.cause;
  }

  /**
   * Drain the pending worker enables against one deadline. The enables
   * themselves stay bound to the capture cancellation and their worker's
   * detach signal, so abandoning the wait never abandons their cleanup.
   */
  async #drainEnables(): Promise<void> {
    if (this.#pendingEnables.size === 0) return;
    const deadline = new AbortController();
    const bounded =
      this.#context.signal === undefined
        ? deadline.signal
        : AbortSignal.any([deadline.signal, this.#context.signal]);
    let onExpired: () => void = () => undefined;
    const expired = new Promise<void>((resolve) => {
      onExpired = (): void => resolve();
      bounded.addEventListener("abort", onExpired, { once: true });
    });
    const timer = setTimeout(
      () => deadline.abort(),
      WORKER_SESSION_DEADLINE_MS,
    );
    timer.unref();
    try {
      for (;;) {
        if (this.#pendingEnables.size === 0) break;
        // A resolved deadline ends the wait for good; re-racing it would
        // spin, so distinguish the outcomes instead of rechecking the set.
        const drained = await Promise.race([
          Promise.all(this.#pendingEnables).then(() => "drained" as const),
          expired.then(() => "expired" as const),
        ]);
        if (drained === "expired") break;
      }
    } finally {
      clearTimeout(timer);
      bounded.removeEventListener("abort", onExpired);
    }
    if (this.#pendingEnables.size === 0 || this.#notedUnsettledEnables) return;
    this.#notedUnsettledEnables = true;
    this.#completeness.attachLimited("workers");
    this.#limitations.push(
      `Worker network observation did not settle within ${String(WORKER_SESSION_DEADLINE_MS)} ms; requests from workers whose sessions never settled may be missing.`,
    );
  }

  /**
   * Stop admitting workers and release the sessions this capture attached.
   * One short deadline bounds the whole sequence when the browser keeps its
   * socket open but stops replying, as `cleanupCdpTargetCommands` bounds the
   * page session's cleanup; the owning page-session detach and transport
   * close remain the definitive release boundary.
   */
  async release(): Promise<void> {
    this.stopAdmitting();
    await this.#drainEnables();
    const cleanup = new AbortController();
    const domainSignal =
      this.#context.signal === undefined
        ? cleanup.signal
        : AbortSignal.any([cleanup.signal, this.#context.signal]);
    const timeout = setTimeout(
      () => cleanup.abort(),
      WORKER_SESSION_DEADLINE_MS,
    );
    timeout.unref();
    try {
      if (this.#context.signal?.aborted !== true)
        for (const sessionId of [...this.#workerTargets.keys()]) {
          if (domainSignal.aborted) break;
          await sendBestEffort(
            this.#context.connection,
            "Network.disable",
            {},
            sessionId,
            domainSignal,
          );
        }
      // Cancellation skips optional worker shutdown but still releases the
      // attached sessions using the independent, bounded cleanup signal.
      for (const sessionId of [...this.#workerTargets.keys()]) {
        if (cleanup.signal.aborted) break;
        await sendBestEffort(
          this.#context.connection,
          "Target.detachFromTarget",
          { sessionId },
          undefined,
          cleanup.signal,
        );
      }
      this.#workerTargets.clear();
      await sendBestEffort(
        this.#context.connection,
        "Target.setAutoAttach",
        { autoAttach: false, filter: WORKER_FILTER },
        this.#context.sessionId,
        cleanup.signal,
      );
    } finally {
      clearTimeout(timeout);
      cleanup.abort();
    }
  }

  #admitWorkerSession(params: unknown): void {
    const record = recordValue(params);
    const workerSessionId = cdpStringValue(record?.sessionId);
    const targetInfo = recordValue(record?.targetInfo);
    const type = cdpStringValue(targetInfo?.type);
    if (workerSessionId === undefined || workerSessionId.length === 0) {
      this.#completeness.exclude("workers", "invalid_protocol_value");
      return;
    }
    // The CDP filter should admit only dedicated workers; ignore any other
    // child target rather than claim observation it does not have.
    if (type === undefined || !type.includes("worker")) return;
    const workerTargetId = cdpStringValue(targetInfo?.targetId);
    if (workerTargetId === undefined || workerTargetId.length === 0) {
      this.#completeness.exclude("workers", "invalid_protocol_value");
      return;
    }
    if (this.#workerTargets.has(workerSessionId)) return;
    if (!this.#admitting) {
      // A worker that attaches after the cutoff stays unobserved; report the
      // boundary instead of claiming coverage its sessions never had.
      if (!this.#notedUnadmittedWorkers) {
        this.#notedUnadmittedWorkers = true;
        this.#completeness.attachLimited("workers");
        this.#limitations.push(
          "Dedicated workers that started after the capture stopped admitting worker sessions are not observed; their network activity is absent from this result.",
        );
      }
      return;
    }
    const worker: AdmittedWorkerSession = {
      targetId: workerTargetId,
      detach: new AbortController(),
    };
    this.#workerTargets.set(workerSessionId, worker);
    const enabling = this.#enableWorkerObservation(workerSessionId, worker);
    this.#pendingEnables.add(enabling);
    void enabling.then(
      () => this.#pendingEnables.delete(enabling),
      () => this.#pendingEnables.delete(enabling),
    );
  }

  /**
   * Enable network observation for one admitted worker and subscribe to its
   * own worker children. `Target.setAutoAttach` does not recurse, so without
   * a subscription on the worker session a worker that starts another worker
   * is never attached and its requests silently vanish.
   */
  async #enableWorkerObservation(
    workerSessionId: string,
    worker: AdmittedWorkerSession,
  ): Promise<void> {
    const signal = workerCommandSignal(
      this.#context.signal,
      worker.detach.signal,
    );
    try {
      await this.#context.connection.send(
        "Network.enable",
        {},
        workerSessionId,
        signal,
      );
      await this.#context.connection.send(
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: WORKER_FILTER,
        },
        workerSessionId,
        signal,
      );
    } catch (cause: unknown) {
      if (
        worker.detach.signal.aborted ||
        (cause instanceof CdpCommandRejection &&
          cause.code === -32_001 &&
          cause.reportedMessage === "Session with given id not found.")
      ) {
        // The worker exited around the enable; nothing of it remains
        // observable, so keep the page capture intact.
        this.#workerTargets.delete(workerSessionId);
        return;
      }
      // A browser without session-scoped auto-attach still records this
      // worker's own traffic; only nested workers stay unobserved.
      if (
        cause instanceof CdpCommandRejection &&
        cause.command === "Target.setAutoAttach" &&
        cause.code === -32_601
      ) {
        this.#completeness.attachLimited("workers");
        this.#limitations.push(
          "Target.setAutoAttach was unavailable from an attached worker session; nested worker network activity may be unobserved.",
        );
        return;
      }
      this.#failure ??= { cause };
    }
  }

  #releaseWorkerSession(params: unknown): void {
    const sessionId = cdpStringValue(recordValue(params)?.sessionId);
    if (sessionId === undefined) return;
    const worker = this.#workerTargets.get(sessionId);
    if (worker === undefined) return;
    this.#workerTargets.delete(sessionId);
    // Chromium leaves commands sent to a detached flat session unanswered;
    // aborting settles them now rather than at the transport deadline.
    worker.detach.abort();
  }
}

const sendBestEffort = async (
  connection: CaptureContext["connection"],
  method: string,
  params: Readonly<Record<string, unknown>>,
  sessionId: string | undefined,
  signal: AbortSignal,
): Promise<void> => {
  try {
    await connection.send(method, params, sessionId, signal);
  } catch {
    // Best-effort release under the shared cleanup deadline; the
    // page-session detach and socket close own the definitive boundary.
  }
};
