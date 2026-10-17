import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import {
  DEDICATED_WORKER_SESSION_ID,
  DEDICATED_WORKER_TARGET_ID,
  NESTED_WORKER_SESSION_ID,
  NESTED_WORKER_TARGET_ID,
  WORKER_SCRIPT_REQUEST_ID,
  startFakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";
import type { FakeCdpCommand } from "../../fixtures/fakeCdpBrowserTypes.js";

type FakeBrowser = Awaited<ReturnType<typeof startFakeCdpBrowser>>;

const inspect = async (browser: FakeBrowser) =>
  await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 20,
    }),
  );

const waitForCommand = async (
  browser: FakeBrowser,
  matches: (command: FakeCdpCommand) => boolean,
): Promise<void> => {
  while (!browser.commands.some(matches))
    await new Promise((resolve) => setTimeout(resolve, 5));
};

const waitForFrameTreeReads = async (
  browser: FakeBrowser,
  count: number,
): Promise<void> => {
  while (
    browser.commands.filter((command) => command.method === "Page.getFrameTree")
      .length < count
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
};

const detachDedicatedWorker = (browser: FakeBrowser): void => {
  browser.emitEvent({
    method: "Target.detachedFromTarget",
    sessionId: "session-1",
    params: {
      sessionId: DEDICATED_WORKER_SESSION_ID,
      targetId: DEDICATED_WORKER_TARGET_ID,
    },
  });
};

it("records dedicated worker requests from their flattened CDP session", async () => {
  const browser = await startFakeCdpBrowser({
    dedicatedWorkerRequests: true,
  });
  try {
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 20,
      }),
    );
    if (!result.ok) throw result.error;

    const workerRequest = result.value.network.requests.find(
      ({ request_id }) => request_id === "worker-request-1",
    );
    expect(workerRequest).toMatchObject({
      url: `${browser.allowedOrigin}/worker-api?token=worker-secret`,
      worker_target_id: DEDICATED_WORKER_TARGET_ID,
      status: 200,
      mime_type: "application/json",
    });
    const pageRequest = result.value.network.requests.find(
      ({ request_id }) => request_id === "request-1",
    );
    expect(pageRequest?.worker_target_id).toBe(null);
    // A worker session REA never admitted must not contribute requests.
    expect(
      result.value.network.requests.some(
        ({ request_id }) => request_id === "rogue-session-request",
      ),
    ).toBe(false);

    expect(
      browser.commands.filter(
        ({ method, sessionId }) =>
          method === "Network.enable" &&
          sessionId === DEDICATED_WORKER_SESSION_ID,
      ),
    ).toHaveLength(1);
    expect(browser.commands).toContainEqual(
      expect.objectContaining({
        method: "Target.setAutoAttach",
        sessionId: "session-1",
        params: expect.objectContaining({
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        }),
      }),
    );
    // The capture releases the worker sessions it admitted.
    expect(browser.commands).toContainEqual(
      expect.objectContaining({
        method: "Target.detachFromTarget",
        params: { sessionId: DEDICATED_WORKER_SESSION_ID },
      }),
    );
    expect(browser.commands).toContainEqual(
      expect.objectContaining({
        method: "Network.disable",
        sessionId: DEDICATED_WORKER_SESSION_ID,
      }),
    );
    expect(browser.commands).toContainEqual(
      expect.objectContaining({
        method: "Target.setAutoAttach",
        params: expect.objectContaining({ autoAttach: false }),
      }),
    );
  } finally {
    await browser.close();
  }
});

it("reads worker JSON response bodies through the worker session", async () => {
  const browser = await startFakeCdpBrowser({
    dedicatedWorkerRequests: true,
  });
  try {
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 20,
        include_json_body_shapes: true,
      }),
    );
    if (!result.ok) throw result.error;

    const workerRequest = result.value.network.requests.find(
      ({ request_id }) => request_id === "worker-request-1",
    );
    expect(workerRequest).toMatchObject({
      worker_target_id: DEDICATED_WORKER_TARGET_ID,
      body_shapes: { status: "included" },
    });
    expect(browser.commands).toContainEqual(
      expect.objectContaining({
        method: "Network.getResponseBody",
        sessionId: DEDICATED_WORKER_SESSION_ID,
        params: { requestId: "worker-request-1" },
      }),
    );
  } finally {
    await browser.close();
  }
});

it("retains worker requests after their worker terminates mid-capture", async () => {
  const browser = await startFakeCdpBrowser({
    dedicatedWorkerRequests: true,
    terminateDedicatedWorker: true,
  });
  try {
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 20,
        include_json_body_shapes: true,
      }),
    );
    if (!result.ok) throw result.error;

    expect(result.value.network.requests).toContainEqual(
      expect.objectContaining({
        request_id: "worker-request-1",
        worker_target_id: DEDICATED_WORKER_TARGET_ID,
      }),
    );
    // Events after the worker's detach are no longer admitted.
    expect(
      result.value.network.requests.some(
        ({ request_id }) => request_id === "worker-request-after-detach",
      ),
    ).toBe(false);
    // The detached worker's body is reported unavailable, not silently read.
    const workerRequest = result.value.network.requests.find(
      ({ request_id }) => request_id === "worker-request-1",
    );
    expect(workerRequest).toMatchObject({
      body_shapes: { status: "unavailable" },
    });
    expect(result.value.limitations).toContainEqual(
      expect.stringContaining("the issuing worker session detached"),
    );
    expect(
      browser.commands.some(
        ({ method, sessionId }) =>
          method === "Network.getResponseBody" &&
          sessionId === DEDICATED_WORKER_SESSION_ID,
      ),
    ).toBe(false);
  } finally {
    await browser.close();
  }
});

it("preserves the inspection when a worker exits while its enable is pending", async () => {
  const browser = await startFakeCdpBrowser({
    dedicatedWorkerRequests: true,
    hangOnCommand: (command) =>
      command.method === "Network.enable" &&
      command.sessionId === DEDICATED_WORKER_SESSION_ID,
  });
  try {
    const pending = inspect(browser);
    await waitForCommand(
      browser,
      (command) =>
        command.method === "Network.enable" &&
        command.sessionId === DEDICATED_WORKER_SESSION_ID,
    );
    detachDedicatedWorker(browser);
    const result = await pending;
    if (!result.ok) throw result.error;
    expect(
      result.value.network.requests.some(
        ({ request_id }) => request_id === "worker-request-1",
      ),
    ).toBe(false);
    expect(
      result.value.network.requests.some(
        ({ request_id }) => request_id === "request-1",
      ),
    ).toBe(true);
  } finally {
    await browser.close();
  }
});

it("reports the worker body unavailable when the worker exits during the read", async () => {
  const browser = await startFakeCdpBrowser({
    dedicatedWorkerRequests: true,
    hangOnCommand: (command) =>
      command.method === "Network.getResponseBody" &&
      command.sessionId === DEDICATED_WORKER_SESSION_ID,
  });
  try {
    const pending = new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 20,
        include_json_body_shapes: true,
      }),
    );
    await waitForCommand(
      browser,
      (command) =>
        command.method === "Network.getResponseBody" &&
        command.sessionId === DEDICATED_WORKER_SESSION_ID,
    );
    detachDedicatedWorker(browser);
    const result = await pending;
    if (!result.ok) throw result.error;
    const workerRequest = result.value.network.requests.find(
      ({ request_id }) => request_id === "worker-request-1",
    );
    expect(workerRequest).toMatchObject({
      body_shapes: { status: "unavailable" },
    });
    expect(result.value.limitations).toContainEqual(
      expect.stringContaining("the issuing worker session detached"),
    );
  } finally {
    await browser.close();
  }
});

it("bounds worker session cleanup when the browser stops replying", async () => {
  const browser = await startFakeCdpBrowser({
    dedicatedWorkerRequests: true,
    hangOnCommand: (command) =>
      (command.method === "Network.disable" &&
        command.sessionId === DEDICATED_WORKER_SESSION_ID) ||
      (command.method === "Target.detachFromTarget" &&
        command.params.sessionId === DEDICATED_WORKER_SESSION_ID) ||
      (command.method === "Target.setAutoAttach" &&
        command.params.autoAttach === false),
  });
  try {
    const startedAt = Date.now();
    const result = await inspect(browser);
    const elapsedMs = Date.now() - startedAt;
    if (!result.ok) throw result.error;
    expect(
      result.value.network.requests.find(
        ({ request_id }) => request_id === "worker-request-1",
      ),
    ).toMatchObject({ worker_target_id: DEDICATED_WORKER_TARGET_ID });
    expect(elapsedMs).toBeLessThan(10_000);
  } finally {
    await browser.close();
  }
});

it("does not wait on worker cleanup after cancellation", async () => {
  const browser = await startFakeCdpBrowser({
    dedicatedWorkerRequests: true,
    hangOnCommand: (command) =>
      (command.method === "Network.disable" &&
        command.sessionId === DEDICATED_WORKER_SESSION_ID) ||
      (command.method === "Target.detachFromTarget" &&
        command.params.sessionId === DEDICATED_WORKER_SESSION_ID) ||
      (command.method === "Target.setAutoAttach" &&
        command.params.autoAttach === false),
  });
  const cancel = new AbortController();
  try {
    const pending = new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 20,
      }),
      { signal: cancel.signal },
    );
    await waitForCommand(
      browser,
      (command) =>
        command.method === "Network.enable" &&
        command.sessionId === DEDICATED_WORKER_SESSION_ID,
    );
    const startedAt = Date.now();
    cancel.abort();
    const result = await pending;
    const elapsedMs = Date.now() - startedAt;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(elapsedMs).toBeLessThan(10_000);
  } finally {
    await browser.close();
  }
});

it("fails the inspection when a worker admitted during later reads fails to enable", async () => {
  const browser = await startFakeCdpBrowser({
    commandEvents: (command, origin) =>
      command.method === "Target.getTargets"
        ? [
            {
              method: "Target.attachedToTarget",
              sessionId: "session-1",
              params: {
                sessionId: "late-worker-session",
                targetInfo: {
                  targetId: "late-worker-attached-1",
                  type: "worker",
                  title: "Late dedicated worker",
                  url: `${origin}/late-worker.js`,
                  attached: true,
                },
                waitingForDebugger: false,
              },
            },
          ]
        : undefined,
    commandError: (command) =>
      command.method === "Network.enable" &&
      command.sessionId === "late-worker-session"
        ? { code: -32_000, message: "Worker network state unavailable" }
        : undefined,
  });
  try {
    const result = await inspect(browser);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      command: "Network.enable",
      code: -32_000,
    });
  } finally {
    await browser.close();
  }
});

it("keeps a worker's startup script request intact when its completion moves to the worker session", async () => {
  const browser = await startFakeCdpBrowser({
    workerStartsDuringCapture: true,
  });
  try {
    const result = await inspect(browser);
    if (!result.ok) throw result.error;
    const scriptRequest = result.value.network.requests.find(
      ({ request_id }) => request_id === WORKER_SCRIPT_REQUEST_ID,
    );
    expect(scriptRequest).toMatchObject({
      worker_target_id: null,
      encoded_data_length: null,
    });
    expect(result.value.completeness.unavailable_sections).not.toContain(
      "network_requests",
    );
    expect(result.value.completeness.excluded).not.toContainEqual(
      expect.objectContaining({
        section: "network_requests",
        reason: "invalid_protocol_value",
      }),
    );
  } finally {
    await browser.close();
  }
});

it("keeps page capture working when worker auto-attach is unavailable", async () => {
  const browser = await startFakeCdpBrowser({
    commandError(command) {
      if (command.method !== "Target.setAutoAttach") return undefined;
      return { code: -32_601, message: "Method not found" };
    },
  });
  try {
    const result = await inspect(browser);
    if (!result.ok) throw result.error;
    expect(result.value.network.requests).toContainEqual(
      expect.objectContaining({ request_id: "request-1" }),
    );
    expect(result.value.limitations).toContainEqual(
      "Target.setAutoAttach was unavailable from this browser target.",
    );
    expect(result.value.completeness.attach_limited_sections).toContain(
      "workers",
    );
  } finally {
    await browser.close();
  }
});

it("records nested worker requests through the parent worker's session", async () => {
  const browser = await startFakeCdpBrowser({
    nestedWorkerRequests: true,
  });
  try {
    const result = await inspect(browser);
    if (!result.ok) throw result.error;

    // The worker started by the dedicated worker contributes its own
    // attributed request instead of silently vanishing.
    const nestedRequest = result.value.network.requests.find(
      ({ request_id }) => request_id === "nested-worker-request-1",
    );
    expect(nestedRequest).toMatchObject({
      url: `${browser.allowedOrigin}/nested-worker-api?token=nested-worker-secret`,
      worker_target_id: NESTED_WORKER_TARGET_ID,
      status: 200,
      mime_type: "application/json",
    });
    const directRequest = result.value.network.requests.find(
      ({ request_id }) => request_id === "worker-request-1",
    );
    expect(directRequest?.worker_target_id).toBe(DEDICATED_WORKER_TARGET_ID);
    expect(result.value.workers).toContainEqual(
      expect.objectContaining({ target_id: NESTED_WORKER_TARGET_ID }),
    );
    // The parent worker session subscribes to its own children, and the
    // nested session is observed and released like its parent.
    expect(browser.commands).toContainEqual(
      expect.objectContaining({
        method: "Target.setAutoAttach",
        sessionId: DEDICATED_WORKER_SESSION_ID,
        params: expect.objectContaining({
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        }),
      }),
    );
    expect(
      browser.commands.filter(
        ({ method, sessionId }) =>
          method === "Network.enable" && sessionId === NESTED_WORKER_SESSION_ID,
      ),
    ).toHaveLength(1);
    expect(browser.commands).toContainEqual(
      expect.objectContaining({
        method: "Network.disable",
        sessionId: NESTED_WORKER_SESSION_ID,
      }),
    );
    expect(browser.commands).toContainEqual(
      expect.objectContaining({
        method: "Target.detachFromTarget",
        params: { sessionId: NESTED_WORKER_SESSION_ID },
      }),
    );
  } finally {
    await browser.close();
  }
});

it("bounds the worker settle when the page keeps starting workers", async () => {
  const churnSessionId = (index: number) => `worker-churn-${String(index)}`;
  const browser = await startFakeCdpBrowser({
    dedicatedWorkerRequests: true,
    hangOnCommand: (command) =>
      command.method === "Network.enable" &&
      (command.sessionId === DEDICATED_WORKER_SESSION_ID ||
        (command.sessionId?.startsWith("worker-churn-") ?? false)),
  });
  try {
    const startedAt = Date.now();
    const pending = inspect(browser);
    // Each newly admitted worker extends the pending enable drain while the
    // earlier enables stay unanswered.
    for (let index = 0; index < 8; index += 1) {
      await waitForCommand(
        browser,
        (command) =>
          command.method === "Network.enable" &&
          command.sessionId ===
            (index === 0 ? DEDICATED_WORKER_SESSION_ID : churnSessionId(index)),
      );
      browser.emitEvent({
        method: "Target.attachedToTarget",
        sessionId: "session-1",
        params: {
          sessionId: churnSessionId(index + 1),
          targetInfo: {
            targetId: `worker-churn-target-${String(index + 1)}`,
            type: "worker",
            title: `Churn worker ${String(index + 1)}`,
            url: `${browser.allowedOrigin}/churn-worker.js`,
            attached: true,
          },
          waitingForDebugger: false,
        },
      });
    }
    const result = await pending;
    const elapsedMs = Date.now() - startedAt;
    if (!result.ok) throw result.error;
    // The capture still returns its page evidence within a bounded wait.
    expect(elapsedMs).toBeLessThan(10_000);
    expect(
      result.value.network.requests.find(
        ({ request_id }) => request_id === "request-1",
      ),
    ).toBeDefined();
    expect(result.value.completeness.attach_limited_sections).toContain(
      "workers",
    );
    expect(result.value.limitations).toContainEqual(
      expect.stringContaining("did not settle"),
    );
  } finally {
    await browser.close();
  }
});

it("reports workers started after the admission cutoff as unobserved", async () => {
  const browser = await startFakeCdpBrowser({
    commandEvents: (command, origin) =>
      command.method === "Target.getTargets"
        ? [
            {
              method: "Target.attachedToTarget",
              sessionId: "session-1",
              params: {
                sessionId: "late-worker-session",
                targetInfo: {
                  targetId: "late-worker-attached-1",
                  type: "worker",
                  title: "Late dedicated worker",
                  url: `${origin}/late-worker.js`,
                  attached: true,
                },
                waitingForDebugger: false,
              },
            },
          ]
        : undefined,
    hangOnCommand: (command) =>
      command.method === "Network.enable" &&
      command.sessionId === "late-worker-session",
  });
  try {
    const pending = inspect(browser);
    // The late worker's unanswered enable parks the final settle after the
    // capture stopped admitting; a worker arriving then is counted, not
    // observed.
    await waitForCommand(
      browser,
      (command) =>
        command.method === "Network.enable" &&
        command.sessionId === "late-worker-session",
    );
    await waitForFrameTreeReads(browser, 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    browser.emitEvent({
      method: "Target.attachedToTarget",
      sessionId: "session-1",
      params: {
        sessionId: "worker-after-cutoff",
        targetInfo: {
          targetId: "worker-after-cutoff-target",
          type: "worker",
          title: "Worker after cutoff",
          url: `${browser.allowedOrigin}/after-cutoff-worker.js`,
          attached: true,
        },
        waitingForDebugger: false,
      },
    });
    const result = await pending;
    if (!result.ok) throw result.error;
    expect(
      browser.commands.some(
        ({ method, sessionId }) =>
          method === "Network.enable" && sessionId === "worker-after-cutoff",
      ),
    ).toBe(false);
    expect(result.value.limitations).toContainEqual(
      expect.stringContaining("stopped admitting worker sessions"),
    );
    expect(result.value.completeness.attach_limited_sections).toContain(
      "workers",
    );
  } finally {
    await browser.close();
  }
});

it("fails the inspection when the page navigates during the final worker settle", async () => {
  const browser = await startFakeCdpBrowser({
    commandEvents: (command, origin) =>
      command.method === "Target.getTargets"
        ? [
            {
              method: "Target.attachedToTarget",
              sessionId: "session-1",
              params: {
                sessionId: "late-worker-session",
                targetInfo: {
                  targetId: "late-worker-attached-1",
                  type: "worker",
                  title: "Late dedicated worker",
                  url: `${origin}/late-worker.js`,
                  attached: true,
                },
                waitingForDebugger: false,
              },
            },
          ]
        : undefined,
    hangOnCommand: (command) =>
      command.method === "Network.enable" &&
      command.sessionId === "late-worker-session",
  });
  try {
    const pending = inspect(browser);
    await waitForCommand(
      browser,
      (command) =>
        command.method === "Network.enable" &&
        command.sessionId === "late-worker-session",
    );
    // The late enable keeps the final settle open after the page checks have
    // already passed; park there before navigating the main frame.
    await waitForFrameTreeReads(browser, 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    browser.emitEvent({
      method: "Page.frameNavigated",
      sessionId: "session-1",
      params: {
        frame: {
          id: "frame-main",
          loaderId: "loader-during-settle",
          url: `${browser.allowedOrigin}/moved-during-settle`,
        },
      },
    });
    browser.emitEvent({
      method: "Target.detachedFromTarget",
      sessionId: "session-1",
      params: {
        sessionId: "late-worker-session",
        targetId: "late-worker-attached-1",
      },
    });
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ reason: "target_changed" });
  } finally {
    await browser.close();
  }
});
