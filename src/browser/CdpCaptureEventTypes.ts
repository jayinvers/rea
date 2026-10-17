import type { WebPageInspection } from "../domain/browserObservationSchemas.js";

export interface CapturedScript {
  readonly scriptId: string;
  readonly rawUrl: string;
  readonly url: string;
  readonly origin: string | null;
  readonly hash: string | null;
  readonly length: number | null;
  readonly isModule: boolean | null;
  readonly language: string | null;
  readonly sourceMapUrl: string | null;
  readonly sourceMapRawUrl: string | null;
  readonly executionContextKey: string | null;
  /** Frame observed when this script was parsed. Later context reuse does not move it. */
  readonly frameId: string | null;
}

export type NetworkState = WebPageInspection["network"]["requests"][number];

/**
 * Session attribution for events observed on an admitted worker session.
 * Multiplexed ingest attaches it so requests retain their issuing worker.
 */
export interface CdpNetworkEventSource {
  readonly worker_target_id: string;
}

/** Bounds retained CDP script identities independently from source text capture. */
export const CDP_CAPTURE_SCRIPT_METADATA_LIMITS = {
  retainedBytes: 8 * 1024 * 1024,
  scripts: 50_000,
} as const;
