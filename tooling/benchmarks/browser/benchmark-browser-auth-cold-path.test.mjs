import test from "node:test";
import assert from "node:assert/strict";
import {
  buildColdPathReport,
  distribution,
  summarizeScenario,
} from "./benchmark-browser-auth-cold-path.mjs";

test("summarizes deterministic cold-path percentiles and rates", () => {
  assert.deepEqual(distribution([40, 10, 30, 20]), {
    count: 4,
    minMs: 10,
    p50Ms: 20,
    p95Ms: 40,
    maxMs: 40,
    meanMs: 25,
  });

  const summary = summarizeScenario([
    { phase: "warmup", sample: 0, durationMs: 100, status: "failed" },
    { phase: "measured", sample: 0, durationMs: 10, status: "performed" },
    { phase: "measured", sample: 1, durationMs: 20, status: "performed" },
  ], ["performed"]);
  assert.equal(summary.successRate, 1);
  assert.equal(summary.interactionRate, 0);
  assert.deepEqual(summary.statuses, { performed: 2 });
  assert.equal(summary.latencyMs.p95Ms, 20);
});

test("keeps authentication cold-path evidence observational and outside hot gates", () => {
  const makeScenario = (status, interactionRate = 0) => ({
    expectedStatuses: [status],
    latencyMs: distribution([5, 10]),
    successRate: 1,
    interactionRate,
    statuses: { [status]: 2 },
    reasons: {},
    samples: [],
  });
  const report = buildColdPathReport({
    runId: "fixture",
    samples: 2,
    warmups: 1,
    scenarios: {
      confirmation: makeScenario("granted"),
      brokerStartupUnavailable: makeScenario("unavailable"),
      sessionReused: makeScenario("session-reused"),
      loginPerformed: makeScenario("performed"),
      interactionRequired: makeScenario("interaction-required", 1),
      sanitizedFailure: makeScenario("failed"),
    },
  });

  assert.equal(report.passed, true);
  assert.equal(report.classification, "observational-only");
  assert.equal(report.hotPathGateImpact, "excluded");
  assert.equal(report.configuration.realCredentialUsed, false);
  assert.equal(report.configuration.realLegacySiteAccessed, false);
  assert.equal(report.summary.loginPerformedP95Ms, 10);
  assert.equal(report.summary.brokerStartupP95Ms, 10);
  assert.equal(JSON.stringify(report).includes("benchmark-password-not-a-real-secret"), false);
});
