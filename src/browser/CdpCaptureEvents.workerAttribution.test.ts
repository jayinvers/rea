import { expect, it } from "vitest";

import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import { inspectWebPageInputSchema } from "../domain/browserObservation.js";

const origin = "http://127.0.0.1:43127";

const events = () =>
  new CdpCaptureEvents(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: origin,
      allowed_origins: [origin],
      target_id: "allowed-page",
    }),
    new Set([origin]),
  );

it("attributes requests ingested from an admitted worker session", () => {
  const state = events();
  state.ingest(
    {
      method: "Network.requestWillBeSent",
      params: {
        requestId: "worker-1",
        request: { url: `${origin}/worker.json`, method: "GET" },
        initiator: { type: "script" },
        timestamp: 1,
      },
    },
    { worker_target_id: "worker-target-1" },
  );
  state.ingest({
    method: "Network.requestWillBeSent",
    params: {
      requestId: "page-1",
      request: { url: `${origin}/page.json`, method: "GET" },
      initiator: { type: "other" },
      timestamp: 1,
    },
  });

  expect(state.network.get("worker-1")?.worker_target_id).toBe(
    "worker-target-1",
  );
  expect(state.network.get("page-1")?.worker_target_id).toBe(null);
});

it("preserves worker attribution across redirect continuations and responses", () => {
  const state = events();
  const source = { worker_target_id: "worker-target-1" };
  state.ingest(
    {
      method: "Network.requestWillBeSent",
      params: {
        requestId: "worker-1",
        request: { url: `${origin}/before.json`, method: "GET" },
        initiator: { type: "script" },
        timestamp: 1,
      },
    },
    source,
  );
  state.ingest(
    {
      method: "Network.requestWillBeSent",
      params: {
        requestId: "worker-1",
        request: { url: `${origin}/after.json`, method: "GET" },
        initiator: { type: "script" },
        redirectResponse: {
          url: `${origin}/before.json`,
          status: 302,
          mimeType: "application/json",
          encodedDataLength: 12,
        },
        timestamp: 2,
      },
    },
    source,
  );
  state.ingest(
    {
      method: "Network.responseReceived",
      params: {
        requestId: "worker-1",
        response: {
          url: `${origin}/after.json`,
          status: 200,
          mimeType: "application/json",
        },
      },
    },
    source,
  );
  state.ingest(
    {
      method: "Network.loadingFinished",
      params: { requestId: "worker-1", encodedDataLength: 14 },
    },
    source,
  );

  const request = state.network.get("worker-1");
  expect(request).toMatchObject({
    url: `${origin}/after.json`,
    worker_target_id: "worker-target-1",
    redirects: [{ url: `${origin}/before.json` }],
    status: 200,
    encoded_data_length: 14,
  });
});

it("keeps another session's completion off a request it did not start", () => {
  const state = events();
  state.ingest({
    method: "Network.requestWillBeSent",
    params: {
      requestId: "worker-script",
      request: { url: `${origin}/dedicated-worker.js`, method: "GET" },
      initiator: { type: "script" },
      timestamp: 1,
    },
  });
  // Chromium hands a starting worker's script request to the flattened
  // worker session and finishes it there with no usable encoded length.
  state.ingest(
    {
      method: "Network.loadingFinished",
      params: { requestId: "worker-script", encodedDataLength: -1 },
    },
    { worker_target_id: "worker-target-1" },
  );

  expect(state.network.get("worker-script")?.encoded_data_length).toBe(null);
  expect(state.completeness.snapshot().unavailable_sections).not.toContain(
    "network_requests",
  );
});
