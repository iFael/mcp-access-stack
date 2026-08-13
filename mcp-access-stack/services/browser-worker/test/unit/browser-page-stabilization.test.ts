import { describe, expect, it } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import {
  BrowserPageStabilizationService,
  type BrowserPageStabilitySample,
} from "../../services/browser-page-stabilization-service.js";

describe("BrowserPageStabilizationService", () => {
  it("waits until a delayed hydration change remains quiet", async () => {
    let now = 0;
    const samples: BrowserPageStabilitySample[] = [
      sample("loading", "initial"),
      sample("interactive", "initial"),
      sample("interactive", "hydrated"),
      sample("interactive", "hydrated"),
      sample("complete", "hydrated"),
      sample("complete", "hydrated"),
    ];
    let index = 0;
    const service = new BrowserPageStabilizationService({
      probe: async () => samples[Math.min(index++, samples.length - 1)]!,
      now: () => now,
      delay: async (ms) => {
        now += ms;
      },
      pollIntervalMs: 100,
      quietWindowMs: 200,
      minimumObservationMs: 300,
      busyGraceMs: 500,
    });

    await expect(service.stabilize({ timeoutMs: 1_500 })).resolves.toMatchObject({
      status: "stable",
      readyState: "complete",
      samples: 5,
    });
    expect(now).toBeGreaterThanOrEqual(400);
  });

  it("does not wait forever for background requests when the DOM is stable", async () => {
    let now = 0;
    const service = new BrowserPageStabilizationService({
      probe: async () => sample("complete", "stable", {
        pendingRelevantRequests: 2,
      }),
      now: () => now,
      delay: async (ms) => {
        now += ms;
      },
      pollIntervalMs: 100,
      quietWindowMs: 200,
      minimumObservationMs: 200,
      busyGraceMs: 500,
    });

    await expect(service.stabilize({ timeoutMs: 1_500 })).resolves.toMatchObject({
      status: "stable",
      pendingRelevantRequests: 2,
    });
    expect(now).toBeGreaterThanOrEqual(500);
    expect(now).toBeLessThan(1_500);
  });

  it("restarts the quiet window when relevant network activity settles", async () => {
    let now = 0;
    let index = 0;
    const samples = [
      sample("complete", "stable", { pendingRelevantRequests: 1 }),
      sample("complete", "stable", { pendingRelevantRequests: 1 }),
      sample("complete", "stable", { pendingRelevantRequests: 0 }),
      sample("complete", "stable", { pendingRelevantRequests: 0 }),
      sample("complete", "stable", { pendingRelevantRequests: 0 }),
    ];
    const service = new BrowserPageStabilizationService({
      probe: async () => samples[Math.min(index++, samples.length - 1)]!,
      now: () => now,
      delay: async (ms) => { now += ms; },
      pollIntervalMs: 100,
      quietWindowMs: 200,
      minimumObservationMs: 200,
      busyGraceMs: 500,
    });

    await expect(service.stabilize({ timeoutMs: 1_000 })).resolves.toMatchObject({
      status: "stable",
      pendingRelevantRequests: 0,
    });
    expect(now).toBeGreaterThanOrEqual(400);
  });

  it("returns mutable when a readable DOM keeps changing until the bounded budget ends", async () => {
    let now = 0;
    let revision = 0;
    const service = new BrowserPageStabilizationService({
      probe: async () => sample("complete", `revision-${revision++}`),
      now: () => now,
      delay: async (ms) => {
        now += ms;
      },
      pollIntervalMs: 100,
      quietWindowMs: 200,
      minimumObservationMs: 200,
      busyGraceMs: 500,
    });

    await expect(service.stabilize({ timeoutMs: 550 })).resolves.toMatchObject({
      status: "mutable",
      readyState: "complete",
    });
    expect(now).toBeGreaterThanOrEqual(550);
  });

  it("fails when the document never becomes readable", async () => {
    let now = 0;
    const service = new BrowserPageStabilizationService({
      probe: async () => sample("loading", "loading"),
      now: () => now,
      delay: async (ms) => {
        now += ms;
      },
      pollIntervalMs: 100,
    });

    await expect(service.stabilize({ timeoutMs: 350 })).rejects.toMatchObject({
      code: "BROWSER_WORKER_TIMEOUT",
    });
  });

  it("propagates cancellation while stabilizing", async () => {
    let now = 0;
    const controller = new AbortController();
    const service = new BrowserPageStabilizationService({
      probe: async () => sample("interactive", "changing"),
      now: () => now,
      delay: async (ms) => {
        now += ms;
        controller.abort(new AppError("OPERATION_CANCELLED", "cancelled"));
      },
      pollIntervalMs: 100,
    });

    await expect(service.stabilize({
      timeoutMs: 1_000,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
  });
});

function sample(
  readyState: BrowserPageStabilitySample["readyState"],
  signature: string,
  overrides: Partial<BrowserPageStabilitySample> = {},
): BrowserPageStabilitySample {
  return {
    readyState,
    signature,
    navigationEpoch: 1,
    frameCount: 1,
    unreadyFrames: 0,
    pendingRelevantRequests: 0,
    ...overrides,
  };
}
