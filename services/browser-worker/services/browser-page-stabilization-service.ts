import { abortSignalError, AppError } from "@vs-code-gpt/shared";

export type BrowserDocumentReadyState = "loading" | "interactive" | "complete";

export interface BrowserPageStabilitySample {
  readyState: BrowserDocumentReadyState;
  signature: string;
  navigationEpoch: number;
  frameCount: number;
  unreadyFrames: number;
  pendingRelevantRequests: number;
}

export interface BrowserPageStabilizationResult {
  status: "stable" | "mutable";
  elapsedMs: number;
  samples: number;
  readyState: BrowserDocumentReadyState;
  pendingRelevantRequests: number;
  unreadyFrames: number;
}

export interface BrowserPageStabilizationOptions {
  probe(): Promise<BrowserPageStabilitySample>;
  pollIntervalMs?: number;
  quietWindowMs?: number;
  minimumObservationMs?: number;
  busyGraceMs?: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}

export interface BrowserPageStabilizationRequest {
  timeoutMs: number;
  signal?: AbortSignal;
}

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_QUIET_WINDOW_MS = 300;
const DEFAULT_MINIMUM_OBSERVATION_MS = 450;
const DEFAULT_BUSY_GRACE_MS = 750;

export class BrowserPageStabilizationService {
  private readonly pollIntervalMs: number;
  private readonly quietWindowMs: number;
  private readonly minimumObservationMs: number;
  private readonly busyGraceMs: number;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;

  constructor(private readonly options: BrowserPageStabilizationOptions) {
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
    );
    this.quietWindowMs = nonnegativeInteger(
      options.quietWindowMs,
      DEFAULT_QUIET_WINDOW_MS,
    );
    this.minimumObservationMs = nonnegativeInteger(
      options.minimumObservationMs,
      DEFAULT_MINIMUM_OBSERVATION_MS,
    );
    this.busyGraceMs = Math.max(
      this.quietWindowMs,
      nonnegativeInteger(options.busyGraceMs, DEFAULT_BUSY_GRACE_MS),
    );
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? sleep;
  }

  async stabilize(
    request: BrowserPageStabilizationRequest,
  ): Promise<BrowserPageStabilizationResult> {
    const timeoutMs = Math.max(1, Math.trunc(request.timeoutMs));
    const startedAt = this.now();
    const deadline = startedAt + timeoutMs;
    let candidateKey: string | undefined;
    let candidateSince: number | undefined;
    let lastSample: BrowserPageStabilitySample | undefined;
    let samples = 0;

    while (true) {
      assertNotAborted(request.signal);
      const sample = await this.options.probe();
      assertNotAborted(request.signal);
      samples += 1;
      lastSample = sample;
      const observedAt = this.now();
      const readable = sample.readyState !== "loading";

      if (readable) {
        const key = stabilityKey(sample);
        if (candidateKey !== key) {
          candidateKey = key;
          candidateSince = observedAt;
        }
        const quietForMs = Math.max(0, observedAt - (candidateSince ?? observedAt));
        const elapsedMs = Math.max(0, observedAt - startedAt);
        const hasBackgroundActivity =
          sample.pendingRelevantRequests > 0 || sample.unreadyFrames > 0;
        const requiredQuietMs = hasBackgroundActivity
          ? this.busyGraceMs
          : this.quietWindowMs;
        if (
          elapsedMs >= this.minimumObservationMs &&
          quietForMs >= requiredQuietMs
        ) {
          return result("stable", elapsedMs, samples, sample);
        }
      } else {
        candidateKey = undefined;
        candidateSince = undefined;
      }

      if (observedAt >= deadline) {
        if (lastSample.readyState !== "loading") {
          return result(
            "mutable",
            Math.max(0, observedAt - startedAt),
            samples,
            lastSample,
          );
        }
        throw new AppError(
          "BROWSER_WORKER_TIMEOUT",
          "The browser page did not reach a readable state within the stabilization budget.",
        );
      }

      await this.delay(Math.min(this.pollIntervalMs, deadline - observedAt));
    }
  }
}

function stabilityKey(sample: BrowserPageStabilitySample): string {
  return [
    sample.navigationEpoch,
    sample.signature,
    sample.frameCount,
    sample.unreadyFrames,
    sample.pendingRelevantRequests,
  ].join(":");
}

function result(
  status: BrowserPageStabilizationResult["status"],
  elapsedMs: number,
  samples: number,
  sample: BrowserPageStabilitySample,
): BrowserPageStabilizationResult {
  return {
    status,
    elapsedMs,
    samples,
    readyState: sample.readyState,
    pendingRelevantRequests: sample.pendingRelevantRequests,
    unreadyFrames: sample.unreadyFrames,
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortSignalError(signal, "Browser page stabilization was cancelled.");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function nonnegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
