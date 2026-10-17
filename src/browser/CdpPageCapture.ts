import type { InspectWebPageInput } from "../domain/browserObservation.js";
import type { WebPageInspection } from "../domain/browserObservationSchemas.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { stableWebResources } from "../domain/webInventory.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import { CdpConnection } from "./CdpConnection.js";
import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import { authorizedMainFrame } from "./CdpAuthorizedMainFrame.js";
import { captureStorage } from "./CdpCaptureStorage.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import {
  captureAccessibility,
  captureDom,
  captureFrames,
  captureResources,
  type CapturedResource,
  type DomCapture,
  mainFrameUrl,
} from "./CdpCaptureDocuments.js";
import { capturedSvgNodeKind } from "./CdpCaptureDomSvg.js";
import {
  allowedSanitizedUrl,
  delayWithCancellation,
} from "./CdpCaptureValues.js";
import { captureScripts } from "./CdpPageCaptureScripts.js";
import { captureWorkers } from "./CdpPageCaptureWorkers.js";
import {
  CdpPageCaptureWorkerSessions,
  workerCommandSignal,
} from "./CdpPageCaptureWorkerSessions.js";
import type { WebSourceMapRequest } from "./WebSourceMapFetcher.js";

export interface CaptureContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly operation: Extract<
    BrowserObservationOperation,
    "inspect_web_page" | "analyze_web_bundle"
  >;
  readonly discovery: CdpEndpointDiscovery;
  readonly target: CdpEndpointTarget;
  readonly input: InspectWebPageInput;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

interface CaptureState {
  readonly context: CaptureContext;
  readonly events: CdpCaptureEvents;
  readonly workerSessions: CdpPageCaptureWorkerSessions;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly limitations: string[];
  readonly startedAt: string;
}

interface CapturedSections {
  readonly attachedUrl: string;
  readonly frames: WebPageInspection["frames"];
  readonly dom: DomCapture;
  readonly accessibility: ReturnType<typeof captureAccessibility>;
  readonly scripts: WebPageInspection["scripts"];
  readonly resources: WebPageInspection["resources"];
  readonly workers: WebPageInspection["workers"];
  readonly storage: WebPageInspection["storage"];
}

export interface CapturedPage {
  readonly inspection: WebPageInspection;
  readonly sourceMapRequests: readonly WebSourceMapRequest[];
}

/** Capture and normalize one attached page without evaluating page JavaScript. */
export const capturePage = async (
  context: CaptureContext,
): Promise<CapturedPage> => {
  const allowedOrigins = new Set(context.input.allowed_origins);
  const events = new CdpCaptureEvents(context.input, allowedOrigins);
  const limitations: string[] = [
    "Observation starts when REA attaches; prior network and console activity is unavailable.",
    "Raw network headers, bodies, cookies, storage values, console objects, and WebSocket payloads are never retained; explicitly requested primitive console text is retained verbatim, while payload captures retain value-free shapes.",
    "Source maps are reported only as declarative URLs and are not fetched.",
    "URL-less scripts and console events without an allowed source URL are excluded because their origin cannot be proven.",
    ...(context.target.attached === null
      ? [
          "CDP discovery omitted the target attachment state; attached is reported as unknown.",
        ]
      : []),
  ];
  const workerSessions = new CdpPageCaptureWorkerSessions(
    context,
    limitations,
    events.completeness,
  );
  const removeListener = context.connection.onEvent((event) => {
    // A worker's child-attach notifications arrive on that worker's own
    // flattened session, so every event first passes the worker multiplexer,
    // which reacts only to Target attach and detach methods.
    workerSessions.observe(event);
    if (event.sessionId === context.sessionId) {
      events.ingest(event);
      return;
    }
    const source = workerSessions.sourceFor(event.sessionId);
    if (source !== undefined) events.ingest(event, source);
  });
  const state: CaptureState = {
    context,
    events,
    workerSessions,
    allowedOrigins,
    limitations,
    startedAt: new Date().toISOString(),
  };
  try {
    return await captureAuthorizedPage(state);
  } finally {
    removeListener();
    await workerSessions.release();
  }
};

const captureAuthorizedPage = async (
  state: CaptureState,
): Promise<CapturedPage> => {
  const { context, allowedOrigins, limitations } = state;
  const { connection, sessionId, input, signal } = context;
  await authorizeObservationWindow(state);
  await captureJsonResponseBodies(state);
  const frameResult = await authorizedMainFrame({
    connection: context.connection,
    sessionId: context.sessionId,
    signal: context.signal,
    allowedOrigins,
    operation: context.operation,
  });
  const attachedUrl = mainFrameUrl(frameResult) ?? "";
  const frameCapture = captureFrames(
    frameResult,
    allowedOrigins,
    undefined,
    state.events.completeness,
  );
  const frames = frameCapture.items;
  const captureFrame = frames[0];
  if (captureFrame === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  state.events.beginFinalCapture(captureFrame.frame_id);
  const resourceCapture = captureResources(
    await connection.send("Page.getResourceTree", {}, sessionId, signal),
    allowedOrigins,
    state.events.completeness,
  );
  const resources = stableWebResources(
    resourceCapture.items.map(publicResource),
  );
  const dom = await capturePageDom(state);
  const accessibility = await accessibilityForFrames(state, frames);
  const scripts = await captureScripts({
    context,
    events: state.events,
    rawResources: resourceCapture.items,
    resources,
    frameIds: new Set(frames.map((frame) => frame.frame_id)),
  });
  const workers = await captureWorkers(
    { context, allowedOrigins, limitations, events: state.events },
    new Set(frames.map((frame) => frame.frame_id)),
  );
  const storageCapture = await captureStorage(
    context,
    attachedUrl,
    limitations,
  );
  if (!input.include_storage_keys)
    state.events.completeness.exclude("storage_keys", "not_approved", null);
  else if (storageCapture.keysExclusion !== undefined)
    state.events.completeness.exclude(
      "storage_keys",
      storageCapture.keysExclusion,
      null,
    );
  await report(context.progress, 3, "Normalizing browser evidence");
  const completedFrameResult = await authorizedMainFrame({
    connection: context.connection,
    sessionId: context.sessionId,
    signal: context.signal,
    allowedOrigins,
    operation: context.operation,
  });
  const completedUrl = mainFrameUrl(completedFrameResult) ?? "";
  assertDocumentUnchanged(state, completedUrl, attachedUrl);
  // The worker listener stays active through the reads above, so workers
  // admitted after the observation window settle again here; a late enable
  // failure surfaces with its own cause instead of vanishing into the
  // best-effort release. Admission closes first: a page that keeps starting
  // workers would otherwise extend this drain indefinitely.
  state.workerSessions.stopAdmitting();
  await state.workerSessions.settle();
  // The settle waits asynchronously with the page listener still attached, so
  // a navigation that lands while it drains fails the inspection exactly like
  // one observed before the reads, instead of returning evidence from two
  // documents.
  assertDocumentUnchanged(state, completedUrl, attachedUrl);
  // Body IDs were enumerated before asynchronous CDP reads. Events remain
  // enabled through the final capture, so account for eligible responses that
  // arrived while those reads were pending.
  state.events.settleUnexaminedResponseBodies();
  state.events.recordScriptMetadataBudgetExclusions();
  return {
    inspection: normalizedInspection(state, {
      attachedUrl,
      frames,
      dom,
      accessibility,
      scripts: scripts.inventory,
      resources,
      workers,
      storage: storageCapture.value,
    }),
    sourceMapRequests: scripts.sourceMapRequests,
  };
};

/**
 * The captured inventory must describe exactly one authorized document. A
 * main-frame navigation observed at any point — during the observation
 * window, the final reads, or the worker settle that drains after them —
 * fails the inspection instead of merging two documents' evidence.
 */
const assertDocumentUnchanged = (
  state: CaptureState,
  currentUrl: string,
  attachedUrl: string,
): void => {
  if (state.events.originViolation)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  if (state.events.navigationDuringCapture || currentUrl !== attachedUrl)
    throw new BrowserObservationError("inspect_web_page", "target_changed");
};

const captureJsonResponseBodies = async (
  state: CaptureState,
): Promise<void> => {
  const requests = state.events.responseBodyRequests();
  for (let index = 0; index < requests.length; index += 1) {
    const candidate = requests[index];
    if (candidate === undefined) continue;
    const current = state.events.currentResponseBodyRequest(candidate);
    if (current === undefined) continue;
    if (current.encoded_data_length === null) {
      state.events.responseBodyUnavailable(candidate);
      continue;
    }
    // Worker requests exist only in the issuing worker's Network domain, and
    // a worker exit must settle the read promptly instead of waiting out the
    // transport deadline Chromium leaves unanswered.
    const workerSession =
      current.worker_target_id === null
        ? undefined
        : state.workerSessions.admittedWorker(current.worker_target_id);
    if (current.worker_target_id !== null && workerSession === undefined) {
      state.events.responseBodyUnavailable(candidate);
      state.limitations.push(
        `Response body unavailable for request ${candidate.requestId}: the issuing worker session detached before the body was read.`,
      );
      continue;
    }
    let result: unknown;
    try {
      result = await optionalCdpCommand(
        workerSession === undefined
          ? state.context
          : {
              ...state.context,
              sessionId: workerSession.sessionId,
              signal: workerCommandSignal(
                state.context.signal,
                workerSession.detachSignal,
              ),
            },
        "Network.getResponseBody",
        { requestId: candidate.requestId },
        state.limitations,
      );
    } catch (cause: unknown) {
      if (workerSession?.detachSignal.aborted === true) {
        state.events.responseBodyUnavailable(candidate);
        state.limitations.push(
          `Response body unavailable for request ${candidate.requestId}: the issuing worker session detached before the body was read.`,
        );
        continue;
      }
      if (
        !(cause instanceof CdpCommandRejection) ||
        cause.command !== "Network.getResponseBody" ||
        cause.reportedMessage === null ||
        !rejectedResponseBodyRead(cause.code, workerSession?.sessionId)
      )
        throw cause;
      state.events.responseBodyUnavailable(candidate);
      state.limitations.push(
        `Response body unavailable for request ${candidate.requestId}: ${cause.userMessage}`,
      );
      continue;
    }
    if (result !== undefined) {
      state.events.ingestResponseBody(candidate, result);
      continue;
    }
    for (const remaining of requests.slice(index))
      state.events.responseBodyUnavailable(remaining);
    return;
  }
};

/**
 * The page session reports missing bodies as -32000. A flattened worker
 * session also vanishes with -32001 when its worker terminates first.
 */
const rejectedResponseBodyRead = (
  code: number | null,
  workerSession: string | undefined,
): boolean =>
  code === -32_000 || (workerSession !== undefined && code === -32_001);

const authorizeObservationWindow = async (
  state: CaptureState,
): Promise<void> => {
  const { context, allowedOrigins, events } = state;
  const { connection, sessionId, signal } = context;
  await report(context.progress, 1, "Enabling passive CDP domains");
  await connection.send("Page.enable", {}, sessionId, signal);
  const initialFrameResult = await authorizedMainFrame({
    connection: context.connection,
    sessionId: context.sessionId,
    signal: context.signal,
    allowedOrigins,
    operation: context.operation,
  });
  const mainFrame = captureFrames(initialFrameResult, allowedOrigins).items[0];
  if (mainFrame === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  events.beginAuthorizedFrame(mainFrame.frame_id);
  await enableObservationDomains(state);
  await report(context.progress, 2, "Observing page events");
  await delayWithCancellation(
    context.input.observation_ms,
    context.operation,
    signal,
  );
  // Worker sessions admitted during the window settle before their response
  // bodies are enumerated, so an enable failure surfaces with its own cause.
  await state.workerSessions.settle();
  if (events.originViolation)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
};

const capturePageDom = async (state: CaptureState): Promise<DomCapture> => {
  const { context, allowedOrigins } = state;
  const result = await context.connection.send(
    "DOMSnapshot.captureSnapshot",
    {
      computedStyles: [],
      includePaintOrder: false,
      includeDOMRects: false,
    },
    context.sessionId,
    context.signal,
  );
  const capture = captureDom(
    result,
    allowedOrigins,
    context.input,
    state.events.completeness,
  );
  let step = capture.next();
  let descriptionUnavailable = false;
  const pendingController = new AbortController();
  const signal =
    context.signal === undefined
      ? pendingController.signal
      : AbortSignal.any([context.signal, pendingController.signal]);
  while (!step.done) {
    const pending = step.value.map(async (query) => {
      if (descriptionUnavailable) return undefined;
      try {
        return capturedSvgNodeKind(
          query,
          await context.connection.send(
            "DOM.describeNode",
            { backendNodeId: query.backendNodeId, depth: 0 },
            context.sessionId,
            signal,
          ),
        );
      } catch (cause: unknown) {
        // A detached node can disappear between snapshot and description.
        // Preserve partial metadata, but propagate transport/cancellation errors.
        if (!(cause instanceof CdpCommandRejection)) throw cause;
        if (cause.code === -32_601) descriptionUnavailable = true;
        else if (cause.code !== -32_000) throw cause;
        return undefined;
      }
    });
    try {
      // Promise.all preserves snapshot order even when CDP replies out of order.
      step = capture.next(await Promise.all(pending));
    } catch (cause: unknown) {
      // Stop and settle this bounded batch before the session can be detached.
      pendingController.abort();
      await Promise.allSettled(pending);
      throw cause;
    }
  }
  if (step.value.unresolvedSvgNodes > 0)
    state.limitations.push(
      `SVG identity was unavailable for ${String(step.value.unresolvedSvgNodes)} snapshotted XLink candidate nodes; their URL destinations remain unknown.`,
    );
  return step.value;
};

const normalizedInspection = (
  state: CaptureState,
  captured: CapturedSections,
): WebPageInspection => ({
  browser: state.context.discovery.version,
  target: normalizedTarget(
    state.context.target,
    captured.attachedUrl,
    state.allowedOrigins,
  ),
  capture_window: {
    started_at: state.startedAt,
    ended_at: new Date().toISOString(),
    observation_ms: state.context.input.observation_ms,
  },
  completeness: state.events.completeness.snapshot(),
  frames: [...captured.frames],
  dom: { total_nodes: captured.dom.total, nodes: [...captured.dom.nodes] },
  accessibility: {
    total_nodes: captured.accessibility.total,
    text_capture: captured.accessibility.textCapture,
    nodes: [...captured.accessibility.nodes],
  },
  scripts: captured.scripts,
  resources: [...captured.resources],
  network: {
    requests: [...state.events.network.values()],
    websocket_connections: [...state.events.webSocketConnectionsById.values()],
    coverage_started_at: state.startedAt,
    prior_activity_available: false,
  },
  console: {
    events: [...state.events.console],
    coverage_started_at: state.startedAt,
    prior_activity_available: false,
  },
  workers: [...captured.workers],
  metadata: {
    responses: [...state.events.responseMetadata],
    dom_urls: [...captured.dom.urls],
    agent_hints: deduplicatedAgentHints([
      ...state.events.agentHints,
      ...captured.dom.agentHints,
    ]),
    excluded_dom_urls: captured.dom.excludedUrls,
    headers_allowlisted: true,
  },
  storage: captured.storage,
  limitations: state.limitations,
});

const enableObservationDomains = async (state: CaptureState): Promise<void> => {
  const { connection, sessionId, signal } = state.context;
  await connection.send("Runtime.enable", {}, sessionId, signal);
  await connection.send("Debugger.enable", {}, sessionId, signal);
  await connection.send("Network.enable", {}, sessionId, signal);
  // Dedicated workers carry their own CDP sessions; flatten them onto this
  // connection so their Network events can be multiplexed into the capture.
  await state.workerSessions.enable();
};

const accessibilityForFrames = async (
  state: CaptureState,
  frames: readonly { readonly frame_id: string }[],
): Promise<ReturnType<typeof captureAccessibility>> => {
  const { context, limitations, events } = state;
  const results: unknown[] = [];
  let unavailable = false;
  for (const frame of frames) {
    const result = await optionalCdpCommand(
      context,
      "Accessibility.getFullAXTree",
      { frameId: frame.frame_id },
      limitations,
    );
    if (result === undefined) unavailable = true;
    else results.push(result);
  }
  if (unavailable) events.completeness.unavailable("accessibility");
  const capture = captureAccessibility(results, {
    includeText: context.input.include_accessibility_text,
    ...(results.length === 0 && unavailable ? { unavailable: true } : {}),
    completeness: events.completeness,
  });
  if (!context.input.include_accessibility_text)
    events.completeness.exclude(
      "accessibility",
      "not_approved",
      capture.textCapture.excluded_fields,
    );
  if (capture.hasUnobservedChildren)
    events.completeness.truncate("accessibility");
  return capture;
};

const publicResource = ({ rawUrl: _rawUrl, ...resource }: CapturedResource) =>
  resource;

const deduplicatedAgentHints = (
  hints: WebPageInspection["metadata"]["agent_hints"],
): WebPageInspection["metadata"]["agent_hints"] => {
  const seen = new Set<string>();
  return hints.filter((hint) => {
    const key = `${hint.mechanism}\0${hint.declaration}\0${hint.url ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const normalizedTarget = (
  target: CdpEndpointTarget,
  currentUrl: string,
  allowedOrigins: ReadonlySet<string>,
): WebPageInspection["target"] => {
  const url = allowedSanitizedUrl(currentUrl, allowedOrigins);
  return {
    target_id: target.id,
    type: target.type,
    title: target.title,
    url: url?.url ?? "[unsupported-url]",
    origin: url?.origin ?? "",
    attached: target.attached,
  };
};

const report = async (
  progress: ProgressReporter | undefined,
  completed: number,
  message: string,
): Promise<void> =>
  await progress?.report({
    phase: "browser_observation",
    completed,
    total: 3,
    message,
    ...(completed === 3 ? { terminal: true } : {}),
  });
