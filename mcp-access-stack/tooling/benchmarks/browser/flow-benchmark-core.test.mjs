import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDevOperationAllowed,
  buildExecutionSchedule,
  calculatePairedComparisons,
  calculatePairedTransport,
  classifyDevStability,
  coefficientOfVariation,
  evaluateLocalFlowGates,
  latinSquareOrder,
  sanitizeBenchmarkValue,
  sanitizedGridSignature,
  sanitizedRowSignature,
  summarizeFlowSamples,
  validateDevConfig,
  validateFlowPostcondition,
} from "./flow-benchmark-core.mjs";

const LOCAL_FLOW_IDS = [
  "legacy-menu-cold",
  "legacy-menu-warm",
  "large-menu",
  "multi-frame-form",
  "controlled-postback",
];

test("alternates the three engines in a Latin square", () => {
  assert.deepEqual(latinSquareOrder(0), ["previous", "candidate", "vscode"]);
  assert.deepEqual(latinSquareOrder(1), ["candidate", "vscode", "previous"]);
  assert.deepEqual(latinSquareOrder(2), ["vscode", "previous", "candidate"]);
  assert.deepEqual(latinSquareOrder(3), ["previous", "candidate", "vscode"]);
  assert.deepEqual(buildExecutionSchedule({ warmups: 1, iterations: 3 }), [
    { index: 0, phase: "warmup", sample: 0, order: ["previous", "candidate", "vscode"] },
    { index: 1, phase: "measured", sample: 0, order: ["candidate", "vscode", "previous"] },
    { index: 2, phase: "measured", sample: 1, order: ["vscode", "previous", "candidate"] },
    { index: 3, phase: "measured", sample: 2, order: ["previous", "candidate", "vscode"] },
  ]);
});

test("summarizes comparison latency, bytes and dispersion without discarding failures", () => {
  const summary = summarizeFlowSamples([
    { phase: "warmup", success: true, durationMs: 999, responseBytes: 1, toolCalls: 1 },
    {
      phase: "measured",
      success: true,
      durationMs: 10,
      requestBytes: 50,
      responseBytes: 100,
      toolCalls: 1,
    },
    { phase: "measured", success: false, durationMs: 20, responseBytes: 200, toolCalls: 2 },
    {
      phase: "measured",
      success: true,
      durationMs: 30,
      comparisonDurationMs: 15,
      protocolDurationMs: 40,
      executionDurationMs: 15,
      transportMs: 12,
      toolRoundTripMs: 28,
      engineMs: 16,
      requestBytes: 150,
      responseBytes: 300,
      toolCalls: 1,
    },
  ], 1);
  assert.equal(summary.samples, 3);
  assert.equal(summary.successes, 2);
  assert.equal(summary.failures, 1);
  assert.equal(summary.successRate, 0.666667);
  assert.equal(summary.latencyMs.p95, 30);
  assert.equal(summary.comparisonLatencyMs.p95, 15);
  assert.equal(summary.requestBytes.p50, 50);
  assert.equal(summary.responseBytes.p50, 100);
  assert.equal(summary.protocolLatencyMs.p50, 40);
  assert.equal(summary.executionAfterConfirmationMs.p50, 15);
  assert.equal(summary.transportLatencyMs.p50, 12);
  assert.equal(summary.toolRoundTripLatencyMs.p50, 28);
  assert.equal(summary.engineLatencyMs.p50, 16);
  assert.equal(typeof summary.latencyMs.standardDeviation, "number");
});

test("sanitizes credentials and uses one canonical SHA-256 grid algorithm", () => {
  assert.deepEqual(sanitizeBenchmarkValue({
    token: "private-token",
    nested: { authorization: "Bearer abc.def.ghi", value: "safe" },
  }), {
    token: "[redacted]",
    nested: { authorization: "[redacted]", value: "safe" },
  });
  assert.deepEqual(sanitizedRowSignature([["Conta A", "100"], ["Conta B", "200"]]), {
    count: 2,
    sha256: "7cd0f2f1c18682f10213f59f8289e6af945172e6d0630cb76386d1e51fac42b8",
  });
  assert.deepEqual(
    sanitizedGridSignature("Conta Á   100\nConta B 200", 2),
    sanitizedGridSignature("conta a 100 conta b 200", 2),
  );
});

test("validates cache and confirmation evidence without inventing VS Code capabilities", () => {
  assert.equal(validateFlowPostcondition("legacy-menu-cold", {
    destinationReady: true,
    heading: "Histórico",
    cache: { hit: false },
  }), true);
  assert.equal(validateFlowPostcondition("legacy-menu-warm", {
    destinationReady: true,
    heading: "Histórico",
    executionPhase: "repeat",
    cache: { applicable: false },
  }), true);
  assert.equal(validateFlowPostcondition("cpx-finance-open", {
    environment: "dev",
    header: true,
    filters: true,
    resultsArea: false,
  }), true);
  assert.equal(validateFlowPostcondition("controlled-postback", {
    confirmation: { applicable: false },
    documentReplaced: true,
    postCount: 1,
  }), true);
  assert.equal(validateFlowPostcondition("controlled-postback", {
    confirmation: { challenged: true },
    documentReplaced: true,
    postCount: 2,
  }), false);
});

test("rejects unsafe Dev configuration and forbidden actions", () => {
  const valid = validateDevConfig({
    url: "https://dev-private.example.test/app",
    profiles: {
      candidate: "C:/bench/candidate",
      previous: "C:/bench/previous",
      vscode: "C:/bench/vscode",
    },
    windowDays: 7,
    rowLimit: 20,
  });
  assert.equal(valid.windowDays, 7);
  assert.throws(() => validateDevConfig({ ...valid, token: "secret" }), /sensitive key/iu);
  assert.throws(() => validateDevConfig({
    ...valid,
    url: "https://private.example.test/",
  }), /Dev domain/iu);
  assert.throws(() => assertDevOperationAllowed("Analisar selecionados"), /forbidden/iu);
});

test("classifies Dev as observational until three stable independent reports", () => {
  const base = {
    runId: "run-3",
    capturedAt: "2026-07-29T12:00:00.000Z",
    suite: "dev",
    source: { candidate: { commit: "abc", sourceTreeSha256: "tree" } },
    safety: {},
    flows: Object.fromEntries([
      "cpx-finance-open",
      "cpx-finance-refresh",
      "cpx-finance-navigation",
      "cpx-finance-grid",
    ].map((id) => [id, { candidate: { optimized: { latencyMs: { p95: 100 } } } }])),
  };
  assert.equal(classifyDevStability(base, []).mode, "observational");
  const result = classifyDevStability(base, [
    { ...structuredClone(base), runId: "run-1", capturedAt: "2026-07-27T12:00:00.000Z" },
    { ...structuredClone(base), runId: "run-2", capturedAt: "2026-07-28T12:00:00.000Z" },
  ]);
  assert.equal(result.mode, "gate");
  assert.equal(result.stable, true);
  assert.equal(coefficientOfVariation([100, 100, 100]), 0);
  assert.equal(classifyDevStability(base, [
    { ...structuredClone(base), runId: "duplicate-1" },
    { ...structuredClone(base), runId: "duplicate-2" },
  ]).mode, "observational");
});

test("calculates paired transport layers and paired engine comparisons", () => {
  const flows = createGateFlows();
  const transport = calculatePairedTransport(flows);
  const comparisons = calculatePairedComparisons(flows);

  assert.equal(transport.pairedSamples, 2);
  assert.equal(transport.gatewayOverheadPercent, 4);
  assert.equal(transport.gatewayOwnedOverheadPercent, 4);
  assert.equal(transport.paired.directWorkerBoundaryMs.p50, 50);
  assert.equal(transport.paired.gatewayTotalBoundaryMs.p50, 60);
  assert.equal(transport.paired.incrementalPerToolCallMs.p50, 2);
  assert.equal(transport.paired.gatewayTimingCoverage.p50, 1);
  assert.equal(transport.paired.gatewayHeaderTimingCoverage.p50, 1);
  assert.equal(transport.paired.gatewayTimingCalls.p50, 5);
  assert.equal(transport.paired.gatewayToolCalls.p50, 5);
  assert.equal(transport.paired.gatewayRequestBytes.p50, 500);
  assert.equal(transport.paired.gatewayResponseBytes.p50, 1_000);
  assert.equal(transport.paired.gatewayStages.requestToFastPathMs.p50, 5);
  assert.equal(transport.gatewayClientInclusiveOwnedOverheadPercent, 14);
  assert.equal(transport.paired.gatewayStages["worker.totalMs"].p50, 25);
  assert.equal(
    transport.paired.gatewayStages["derived.serverNonWorkerBeforeWriteMs"].p50,
    5,
  );
  assert.equal(comparisons.pairedSamples, 2);
  assert.equal(comparisons.previousImprovementPercent.p50, 50);
  assert.equal(comparisons.vscodeImprovementPercent.p50, 28.571);
});

test("evaluates p95 and paired local release checks with success and protocol coverage", () => {
  const flows = createGateFlows();
  const transport = calculatePairedTransport(flows);
  const comparisons = calculatePairedComparisons(flows);
  const result = evaluateLocalFlowGates({
    flows,
    methodology: { measuredIterations: 2 },
    transport,
    comparisons,
  });

  assert.equal(result.passed, true);
  assert.equal(result.extendedTargetPassed, true);
  assert.equal(result.metrics.previousImprovementPercent, 50);
  assert.equal(result.metrics.candidateSuccessRate, 1);
  assert.equal(result.metrics.candidateConfirmationProtocolCoverage.rate, 1);
  assert.equal(result.metrics.gatewayOverheadPercent, 4);
  assert.equal(result.metrics.gatewayOverheadMetric, "owned-headers-instrumented");
  assert.equal(result.metrics.gatewayClientInclusiveOwnedOverheadPercent, 14);
  assert.equal(result.metrics.gatewayHeaderTimingCoverageMin, 1);
  assert.equal(result.metrics.gatewayPairedOverheadPercent, 4);
  assert.equal(result.checks.pairedCoverage, true);
});

function createGateFlows() {
  return Object.fromEntries(LOCAL_FLOW_IDS.map((flowId) => [
    flowId,
    createFlow(flowId),
  ]));
}

function createFlow(flowId) {
  const previousSamples = [0, 1].map((sample) => benchmarkSample(sample, 100, 20));
  const candidateSamples = [0, 1].map((sample) => benchmarkSample(
    sample,
    50,
    10,
    flowId === "controlled-postback"
      ? { confirmation: { applicable: true, supported: true, challenged: true } }
      : {},
  ));
  const gatewaySamples = [0, 1].map((sample) => {
    const controlled = flowId === "controlled-postback";
    const authorizedTiming = gatewayTiming();
    const protocolChallengeTiming = gatewayTiming({
      requestToFastPathMs: 10,
      serverBeforeWriteMs: 60,
      clientElapsedMs: 100,
      clientResidualMs: 40,
    });
    return {
      ...benchmarkSample(
        sample,
        55,
        controlled ? 112 : 12,
        controlled
          ? { confirmation: { applicable: true, supported: true, challenged: true } }
          : {},
      ),
      requestBytes: controlled ? 200 : 100,
      responseBytes: controlled ? 400 : 200,
      toolCalls: controlled ? 2 : 1,
      fastPathCalls: controlled ? 2 : 1,
      gatewayTimings: controlled
        ? [protocolChallengeTiming, authorizedTiming]
        : [authorizedTiming],
      ...(controlled
        ? {
            comparisonRequestBytes: 100,
            comparisonResponseBytes: 200,
            comparisonToolCalls: 1,
            comparisonTransportMs: 12,
            comparisonEngineMs: 43,
            comparisonFastPathCalls: 1,
            comparisonGatewayTimings: [authorizedTiming],
          }
        : {}),
    };
  });
  const individualSamples = [0, 1].map((sample) => benchmarkSample(sample, 100, 100));
  const batchSamples = [0, 1].map((sample) => benchmarkSample(sample, 70, 70));
  return {
    safety: { incorrectPostconditions: 0, duplicateMutations: 0 },
    previous: {
      optimized: benchmarkSummary(100, 1),
      samples: previousSamples,
    },
    candidate: {
      optimized: benchmarkSummary(50, 1),
      gateway: benchmarkSummary(55, 1),
      samples: { optimized: candidateSamples, gateway: gatewaySamples },
    },
    vscode: {
      batch: benchmarkSummary(70, 1),
      individual: benchmarkSummary(100, 3),
      samples: { individual: individualSamples, batch: batchSamples },
    },
  };
}

function gatewayTiming(overrides = {}) {
  return {
    requestToFastPathMs: 1,
    dispatchMs: 1,
    inputValidationMs: 1,
    operationMs: 6,
    outputValidationMs: 1,
    serializationProbeMs: 1,
    serverBeforeWriteMs: 6,
    clientElapsedMs: 12,
    clientResidualMs: 6,
    clientHeadersElapsedMs: 7,
    clientHeadersResidualMs: 1,
    clientSdkResidualMs: 5,
    worker: {
      requestSerializeMs: 0.1,
      fetchHeadersMs: 4,
      responseReadMs: 0.2,
      jsonParseMs: 0.1,
      envelopeValidationMs: 0.2,
      resultValidationMs: 0.4,
      totalMs: 5,
      requestBytes: 100,
      responseBytes: 200,
    },
    ...overrides,
  };
}

function benchmarkSummary(p95, calls) {
  return {
    samples: 2,
    successes: 2,
    failures: 0,
    successRate: 1,
    latencyMs: { p95 },
    comparisonLatencyMs: { p95 },
    toolCalls: { p50: calls },
  };
}

function benchmarkSample(sample, durationMs, transportMs, observation = {}) {
  return {
    phase: "measured",
    sample,
    success: true,
    postcondition: true,
    durationMs,
    comparisonDurationMs: durationMs,
    transportMs,
    engineMs: Math.max(0, durationMs - transportMs),
    requestBytes: 100,
    responseBytes: 200,
    toolCalls: 1,
    observation,
  };
}
