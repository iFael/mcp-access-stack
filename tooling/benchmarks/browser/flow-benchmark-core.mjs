import { createHash } from "node:crypto";

export const FLOW_ENGINES = Object.freeze(["previous", "candidate", "vscode"]);
export const LOCAL_FLOW_IDS = Object.freeze([
  "legacy-menu-cold",
  "legacy-menu-warm",
  "large-menu",
  "multi-frame-form",
  "controlled-postback",
]);
export const DEV_FLOW_IDS = Object.freeze([
  "cpx-finance-open",
  "cpx-finance-refresh",
  "cpx-finance-navigation",
  "cpx-finance-grid",
]);

const FORBIDDEN_DEV_ACTIONS = Object.freeze([
  "analisar selecionados",
  "registrar acoes selecionadas",
  "registrar ações selecionadas",
  "exportar",
  "download",
  "configuracao",
  "configuração",
  "laboratorio",
  "laboratório",
  "producao",
  "produção",
]);
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token)/iu;
const SENSITIVE_VALUE = /(?:bearer\s+[A-Za-z0-9._~+/-]+=*|session(?:id)?=|password=)/iu;

export function latinSquareOrder(index) {
  const offset = nonNegativeInteger(index, "index") % FLOW_ENGINES.length;
  return [
    FLOW_ENGINES[offset],
    FLOW_ENGINES[(offset + 1) % FLOW_ENGINES.length],
    FLOW_ENGINES[(offset + 2) % FLOW_ENGINES.length],
  ];
}

export function buildExecutionSchedule({ warmups, iterations }) {
  const warmupCount = positiveInteger(warmups, "warmups", 200);
  const measuredCount = positiveInteger(iterations, "iterations", 1_000);
  return Array.from({ length: warmupCount + measuredCount }, (_, index) => ({
    index,
    phase: index < warmupCount ? "warmup" : "measured",
    sample: index < warmupCount ? index : index - warmupCount,
    order: latinSquareOrder(index),
  }));
}

export function summarizeFlowSamples(samples, warmupIterations = 0) {
  const measured = samples.filter((sample) => sample.phase !== "warmup");
  const successful = measured.filter((sample) => sample.success === true);
  const durations = successful.map((sample) => finiteNumber(sample.durationMs));
  const comparisonDurations = successful.map((sample) =>
    finiteNumber(sample.comparisonDurationMs ?? sample.durationMs)
  );
  const protocolDurations = successful
    .map((sample) => sample.protocolDurationMs)
    .filter(Number.isFinite)
    .map(Number);
  const executionDurations = successful
    .map((sample) => sample.executionDurationMs)
    .filter(Number.isFinite)
    .map(Number);
  const transportDurations = successful
    .map((sample) => sample.transportMs)
    .filter(Number.isFinite)
    .map(Number);
  const toolRoundTripDurations = successful
    .map((sample) => sample.toolRoundTripMs)
    .filter(Number.isFinite)
    .map(Number);
  const engineDurations = successful
    .map((sample) => sample.engineMs)
    .filter(Number.isFinite)
    .map(Number);
  const requestBytes = successful.map((sample) => finiteNumber(sample.requestBytes, 0));
  const responseBytes = successful.map((sample) => finiteNumber(sample.responseBytes, 0));
  const toolCalls = successful.map((sample) => finiteNumber(sample.toolCalls, 0));
  return {
    samples: measured.length,
    successes: successful.length,
    failures: measured.length - successful.length,
    successRate: measured.length === 0 ? 0 : round(successful.length / measured.length, 6),
    warmupIterations,
    latencyMs: distribution(durations),
    comparisonLatencyMs: distribution(comparisonDurations),
    ...(protocolDurations.length > 0
      ? { protocolLatencyMs: distribution(protocolDurations) }
      : {}),
    ...(executionDurations.length > 0
      ? { executionAfterConfirmationMs: distribution(executionDurations) }
      : {}),
    ...(transportDurations.length > 0
      ? { transportLatencyMs: distribution(transportDurations) }
      : {}),
    ...(toolRoundTripDurations.length > 0
      ? { toolRoundTripLatencyMs: distribution(toolRoundTripDurations) }
      : {}),
    ...(engineDurations.length > 0
      ? { engineLatencyMs: distribution(engineDurations) }
      : {}),
    requestBytes: distribution(requestBytes, 0),
    responseBytes: distribution(responseBytes, 0),
    toolCalls: {
      p50: percentile(toolCalls, 0.5, 0),
      p95: percentile(toolCalls, 0.95, 0),
      total: round(toolCalls.reduce((sum, value) => sum + value, 0), 3),
    },
  };
}

export function coefficientOfVariation(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (finite.length < 2) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  if (mean === 0) return finite.every((value) => value === 0) ? 0 : null;
  const variance = finite.reduce((sum, value) => sum + ((value - mean) ** 2), 0) /
    (finite.length - 1);
  return round(Math.sqrt(variance) / mean, 6);
}

export function evaluateLocalFlowGates(report) {
  const flows = report?.flows ?? {};
  const localFlowIds = LOCAL_FLOW_IDS.filter((flowId) => flows[flowId]);
  const incorrectPostconditions = sumSamples(flows, localFlowIds, "incorrectPostconditions");
  const duplicateMutations = sumSamples(flows, localFlowIds, "duplicateMutations");
  const candidateP95 = aggregateP95(
    flows,
    localFlowIds,
    "candidate",
    "optimized",
    "comparisonLatencyMs",
  );
  const previousP95 = aggregateP95(
    flows,
    localFlowIds,
    "previous",
    "optimized",
    "comparisonLatencyMs",
  );
  const vscodeP95 = aggregateBestVsCodeP95(flows, localFlowIds, "comparisonLatencyMs");
  const individualCalls = aggregateCalls(flows, localFlowIds, "vscode", "individual");
  const candidateCalls = aggregateCalls(flows, localFlowIds, "candidate", "optimized");
  const candidateSuccessRate = aggregateSuccessRate(
    flows,
    localFlowIds,
    "candidate",
    "optimized",
  );
  const gatewaySuccessRate = aggregateSuccessRate(
    flows,
    localFlowIds,
    "candidate",
    "gateway",
  );
  const confirmationCoverage = confirmationProtocolCoverage(flows);
  const gatewayPairedOverheadPercent = Number(
    report?.transport?.gatewayOverheadPercent,
  );
  const gatewayOwnedOverheadPercent = Number(
    report?.transport?.gatewayOwnedOverheadPercent,
  );
  const gatewayTimingCoverageMin = Number(
    report?.transport?.paired?.gatewayTimingCoverage?.min,
  );
  const gatewayHeaderTimingCoverageMin = Number(
    report?.transport?.paired?.gatewayHeaderTimingCoverage?.min,
  );
  const usesOwnedGatewayOverhead =
    gatewayTimingCoverageMin === 1 &&
    gatewayHeaderTimingCoverageMin === 1 &&
    Number.isFinite(gatewayOwnedOverheadPercent);
  const gatewayOverheadPercent = usesOwnedGatewayOverhead
    ? gatewayOwnedOverheadPercent
    : gatewayPairedOverheadPercent;
  const previousImprovementPercent = improvement(candidateP95, previousP95);
  const vscodeImprovementPercent = improvement(candidateP95, vscodeP95);
  const callReductionPercent = improvement(candidateCalls, individualCalls);
  const expectedPairs = Number(report?.methodology?.measuredIterations);
  const transportPairs = Number(report?.transport?.pairedSamples ?? 0);
  const comparisonPairs = Number(report?.comparisons?.pairedSamples ?? 0);
  const pairedPreviousP50 = Number(
    report?.comparisons?.previousImprovementPercent?.p50,
  );
  const pairedVsCodeP50 = Number(
    report?.comparisons?.vscodeImprovementPercent?.p50,
  );
  const checks = {
    exactPostconditions: incorrectPostconditions === 0,
    duplicateMutations: duplicateMutations === 0,
    candidateSuccessRate: candidateSuccessRate >= 0.995,
    gatewaySuccessRate: gatewaySuccessRate >= 0.995,
    candidateConfirmationProtocol: confirmationCoverage.rate === 1,
    pairedCoverage:
      Number.isInteger(expectedPairs) &&
      expectedPairs > 0 &&
      transportPairs === expectedPairs &&
      comparisonPairs === expectedPairs,
    pairedVsCodeParity: Number.isFinite(pairedVsCodeP50) && pairedVsCodeP50 >= 0,
    pairedPreviousImprovement:
      Number.isFinite(pairedPreviousP50) && pairedPreviousP50 >= 35,
    vscodeParity: Number.isFinite(candidateP95) && candidateP95 <= vscodeP95,
    previousImprovement: previousImprovementPercent >= 35,
    toolCallReduction: callReductionPercent >= 50,
    gatewayOverhead:
      Number.isFinite(gatewayOverheadPercent) && gatewayOverheadPercent <= 5,
  };
  return {
    checks,
    passed: Object.values(checks).every(Boolean),
    extendedTargetPassed: vscodeImprovementPercent >= 20,
    metrics: {
      candidateAggregateP95Ms: candidateP95,
      previousAggregateP95Ms: previousP95,
      vscodeBestAggregateP95Ms: vscodeP95,
      previousImprovementPercent,
      vscodeImprovementPercent,
      pairedPreviousImprovementP50Percent:
        Number.isFinite(pairedPreviousP50) ? round(pairedPreviousP50, 3) : null,
      pairedVsCodeImprovementP50Percent:
        Number.isFinite(pairedVsCodeP50) ? round(pairedVsCodeP50, 3) : null,
      toolCallReductionPercent: callReductionPercent,
      candidateSuccessRate,
      gatewaySuccessRate,
      candidateConfirmationProtocolCoverage: confirmationCoverage,
      pairedTransportSamples: transportPairs,
      pairedComparisonSamples: comparisonPairs,
      expectedPairedSamples: Number.isFinite(expectedPairs) ? expectedPairs : null,
      gatewayOverheadPercent:
        Number.isFinite(gatewayOverheadPercent) ? round(gatewayOverheadPercent, 3) : null,
      gatewayOverheadMetric: usesOwnedGatewayOverhead
        ? "owned-headers-instrumented"
        : "paired-boundary-fallback",
      gatewayOwnedOverheadPercent:
        Number.isFinite(gatewayOwnedOverheadPercent)
          ? round(gatewayOwnedOverheadPercent, 3)
          : null,
      gatewayClientInclusiveOwnedOverheadPercent:
        Number.isFinite(report?.transport?.gatewayClientInclusiveOwnedOverheadPercent)
          ? round(Number(report.transport.gatewayClientInclusiveOwnedOverheadPercent), 3)
          : null,
      gatewayPairedOverheadPercent:
        Number.isFinite(gatewayPairedOverheadPercent)
          ? round(gatewayPairedOverheadPercent, 3)
          : null,
      gatewayTimingCoverageMin:
        Number.isFinite(gatewayTimingCoverageMin)
          ? round(gatewayTimingCoverageMin, 3)
          : null,
      gatewayHeaderTimingCoverageMin:
        Number.isFinite(gatewayHeaderTimingCoverageMin)
          ? round(gatewayHeaderTimingCoverageMin, 3)
          : null,
      incorrectPostconditions,
      duplicateMutations,
    },
  };
}

export function calculatePairedTransport(flows) {
  const flowIds = LOCAL_FLOW_IDS.filter((flowId) => flows?.[flowId]);
  const indexes = commonMeasuredSampleIndexes(flows, flowIds, [
    ["candidate", "optimized"],
    ["candidate", "gateway"],
  ]);
  const samples = indexes.map((sampleIndex) => {
    let directComparisonMs = 0;
    let gatewayComparisonMs = 0;
    let directBoundaryMs = 0;
    let gatewayBoundaryMs = 0;
    let directEngineMs = 0;
    let gatewayEngineMs = 0;
    let directRequestBytes = 0;
    let gatewayRequestBytes = 0;
    let directResponseBytes = 0;
    let gatewayResponseBytes = 0;
    let directToolCalls = 0;
    let gatewayToolCalls = 0;
    let gatewayFastPathCalls = 0;
    const gatewayTimingCalls = [];
    for (const flowId of flowIds) {
      const direct = measuredSample(flows, flowId, "candidate", "optimized", sampleIndex);
      const gateway = measuredSample(flows, flowId, "candidate", "gateway", sampleIndex);
      directComparisonMs += comparisonDuration(direct);
      gatewayComparisonMs += comparisonDuration(gateway);
      directBoundaryMs += comparisonMetric(direct, "transportMs");
      gatewayBoundaryMs += comparisonMetric(gateway, "transportMs");
      directEngineMs += comparisonMetric(direct, "engineMs");
      gatewayEngineMs += comparisonMetric(gateway, "engineMs");
      directRequestBytes += comparisonMetric(direct, "requestBytes");
      gatewayRequestBytes += comparisonMetric(gateway, "requestBytes");
      directResponseBytes += comparisonMetric(direct, "responseBytes");
      gatewayResponseBytes += comparisonMetric(gateway, "responseBytes");
      directToolCalls += comparisonMetric(direct, "toolCalls");
      gatewayToolCalls += comparisonMetric(gateway, "toolCalls");
      gatewayFastPathCalls += comparisonMetric(gateway, "fastPathCalls");
      gatewayTimingCalls.push(...comparisonGatewayTimings(gateway));
    }
    const gatewayStageTotals = aggregateGatewayTimings(gatewayTimingCalls);
    const gatewayHeaderTimingCalls = gatewayTimingCalls.filter((call) =>
      Number.isFinite(Number(call.clientHeadersResidualMs))
    ).length;
    const gatewayHeaderTimingCoverage = gatewayTimingCalls.length > 0
      ? gatewayHeaderTimingCalls / gatewayTimingCalls.length
      : 0;
    const incrementalGatewayBoundaryMs = gatewayBoundaryMs - directBoundaryMs;
    const serverNonWorkerBoundaryMs = finiteNumber(
      gatewayStageTotals["derived.serverNonWorkerBeforeWriteMs"],
      0,
    );
    const gatewayClientInclusiveOwnedBoundaryMs =
      finiteNumber(gatewayStageTotals.clientResidualMs, 0) +
      serverNonWorkerBoundaryMs;
    const gatewayOwnedClientResidualMs = gatewayHeaderTimingCoverage === 1
      ? finiteNumber(gatewayStageTotals.clientHeadersResidualMs, 0)
      : finiteNumber(gatewayStageTotals.clientResidualMs, 0);
    const gatewayOwnedBoundaryMs =
      gatewayOwnedClientResidualMs + serverNonWorkerBoundaryMs;
    return {
      sample: sampleIndex,
      directComparisonMs: round(directComparisonMs),
      gatewayComparisonMs: round(gatewayComparisonMs),
      directWorkerBoundaryMs: round(directBoundaryMs),
      gatewayTotalBoundaryMs: round(gatewayBoundaryMs),
      incrementalGatewayBoundaryMs: round(incrementalGatewayBoundaryMs),
      gatewayOwnedBoundaryMs: round(gatewayOwnedBoundaryMs),
      gatewayClientInclusiveOwnedBoundaryMs:
        round(gatewayClientInclusiveOwnedBoundaryMs),
      gatewayOwnedBoundaryMetric: gatewayHeaderTimingCoverage === 1
        ? "headers-instrumented"
        : "client-inclusive-fallback",
      gatewayHeaderTimingCalls,
      gatewayHeaderTimingCoverage: round(gatewayHeaderTimingCoverage),
      directEngineMs: round(directEngineMs),
      gatewayEngineMs: round(gatewayEngineMs),
      directRequestBytes: round(directRequestBytes),
      gatewayRequestBytes: round(gatewayRequestBytes),
      directResponseBytes: round(directResponseBytes),
      gatewayResponseBytes: round(gatewayResponseBytes),
      directToolCalls: round(directToolCalls),
      gatewayToolCalls: round(gatewayToolCalls),
      gatewayFastPathCalls: round(gatewayFastPathCalls),
      gatewayFastPathCoverage: gatewayToolCalls > 0
        ? round(gatewayFastPathCalls / gatewayToolCalls)
        : null,
      gatewayTimingCalls: gatewayTimingCalls.length,
      gatewayTimingCoverage: gatewayToolCalls > 0
        ? round(gatewayTimingCalls.length / gatewayToolCalls)
        : null,
      gatewayStageTotals,
      incrementalPerToolCallMs: gatewayToolCalls > 0
        ? round(incrementalGatewayBoundaryMs / gatewayToolCalls)
        : null,
      gatewayOverheadPercent: directComparisonMs > 0
        ? round((incrementalGatewayBoundaryMs / directComparisonMs) * 100)
        : null,
      gatewayOwnedOverheadPercent: directComparisonMs > 0
        ? round((gatewayOwnedBoundaryMs / directComparisonMs) * 100)
        : null,
      gatewayClientInclusiveOwnedOverheadPercent: directComparisonMs > 0
        ? round((gatewayClientInclusiveOwnedBoundaryMs / directComparisonMs) * 100)
        : null,
      endToEndDeltaPercent: directComparisonMs > 0
        ? round((gatewayComparisonMs / directComparisonMs - 1) * 100)
        : null,
    };
  });
  const finiteValues = (key) => samples.map((sample) => Number(sample[key])).filter(Number.isFinite);
  const gatewayOverhead = distribution(finiteValues("gatewayOverheadPercent"));
  const gatewayOwnedOverhead = distribution(
    finiteValues("gatewayOwnedOverheadPercent"),
  );
  const gatewayClientInclusiveOwnedOverhead = distribution(
    finiteValues("gatewayClientInclusiveOwnedOverheadPercent"),
  );
  const endToEndDelta = distribution(finiteValues("endToEndDeltaPercent"));
  const gatewayStageDistributions = Object.fromEntries(
    GATEWAY_TIMING_STAGE_KEYS.map((key) => [
      key,
      distribution(
        samples
          .map((sample) => Number(sample.gatewayStageTotals?.[key]))
          .filter(Number.isFinite),
      ),
    ]),
  );
  return {
    pairedSamples: samples.length,
    directAggregateP95Ms: distribution(finiteValues("directComparisonMs")).p95,
    gatewayAggregateP95Ms: distribution(finiteValues("gatewayComparisonMs")).p95,
    directBoundaryAggregateP95Ms: distribution(finiteValues("directWorkerBoundaryMs")).p95,
    gatewayBoundaryAggregateP95Ms: distribution(finiteValues("gatewayTotalBoundaryMs")).p95,
    incrementalGatewayBoundaryP95Ms:
      distribution(finiteValues("incrementalGatewayBoundaryMs")).p95,
    gatewayOwnedBoundaryP95Ms:
      distribution(finiteValues("gatewayOwnedBoundaryMs")).p95,
    gatewayClientInclusiveOwnedBoundaryP95Ms:
      distribution(finiteValues("gatewayClientInclusiveOwnedBoundaryMs")).p95,
    gatewayOverheadPercent: gatewayOverhead.p95,
    gatewayOwnedOverheadPercent: gatewayOwnedOverhead.p95,
    gatewayClientInclusiveOwnedOverheadPercent:
      gatewayClientInclusiveOwnedOverhead.p95,
    endToEndDeltaPercent: endToEndDelta.p95,
    paired: {
      directComparisonMs: distribution(finiteValues("directComparisonMs")),
      gatewayComparisonMs: distribution(finiteValues("gatewayComparisonMs")),
      directWorkerBoundaryMs: distribution(finiteValues("directWorkerBoundaryMs")),
      gatewayTotalBoundaryMs: distribution(finiteValues("gatewayTotalBoundaryMs")),
      incrementalGatewayBoundaryMs:
        distribution(finiteValues("incrementalGatewayBoundaryMs")),
      gatewayOwnedBoundaryMs:
        distribution(finiteValues("gatewayOwnedBoundaryMs")),
      gatewayClientInclusiveOwnedBoundaryMs:
        distribution(finiteValues("gatewayClientInclusiveOwnedBoundaryMs")),
      gatewayOverheadPercent: gatewayOverhead,
      gatewayOwnedOverheadPercent: gatewayOwnedOverhead,
      gatewayClientInclusiveOwnedOverheadPercent:
        gatewayClientInclusiveOwnedOverhead,
      endToEndDeltaPercent: endToEndDelta,
      directEngineMs: distribution(finiteValues("directEngineMs")),
      gatewayEngineMs: distribution(finiteValues("gatewayEngineMs")),
      directRequestBytes: distribution(finiteValues("directRequestBytes"), 0),
      gatewayRequestBytes: distribution(finiteValues("gatewayRequestBytes"), 0),
      directResponseBytes: distribution(finiteValues("directResponseBytes"), 0),
      gatewayResponseBytes: distribution(finiteValues("gatewayResponseBytes"), 0),
      directToolCalls: distribution(finiteValues("directToolCalls"), 0),
      gatewayToolCalls: distribution(finiteValues("gatewayToolCalls"), 0),
      gatewayFastPathCalls: distribution(finiteValues("gatewayFastPathCalls"), 0),
      gatewayFastPathCoverage:
        distribution(finiteValues("gatewayFastPathCoverage"), 0),
      gatewayTimingCalls: distribution(finiteValues("gatewayTimingCalls"), 0),
      gatewayTimingCoverage:
        distribution(finiteValues("gatewayTimingCoverage"), 0),
      gatewayHeaderTimingCalls:
        distribution(finiteValues("gatewayHeaderTimingCalls"), 0),
      gatewayHeaderTimingCoverage:
        distribution(finiteValues("gatewayHeaderTimingCoverage"), 0),
      gatewayStages: gatewayStageDistributions,
      incrementalPerToolCallMs:
        distribution(finiteValues("incrementalPerToolCallMs")),
      samples,
    },
  };
}

function comparisonMetric(sample, key) {
  const comparisonKey = `comparison${key[0].toUpperCase()}${key.slice(1)}`;
  return finiteNumber(sample?.[comparisonKey], finiteNumber(sample?.[key], 0));
}

function comparisonGatewayTimings(sample) {
  const timings = Array.isArray(sample?.comparisonGatewayTimings)
    ? sample.comparisonGatewayTimings
    : sample?.gatewayTimings;
  return Array.isArray(timings) ? timings.filter(isPlainObject) : [];
}

const GATEWAY_TIMING_STAGE_KEYS = [
  "requestToFastPathMs",
  "dispatchMs",
  "inputValidationMs",
  "operationMs",
  "outputValidationMs",
  "serializationProbeMs",
  "serverBeforeWriteMs",
  "clientElapsedMs",
  "clientResidualMs",
  "clientHeadersElapsedMs",
  "clientHeadersResidualMs",
  "clientSdkResidualMs",
  "worker.requestSerializeMs",
  "worker.fetchHeadersMs",
  "worker.responseReadMs",
  "worker.jsonParseMs",
  "worker.envelopeValidationMs",
  "worker.resultValidationMs",
  "worker.totalMs",
  "derived.serverNonWorkerBeforeWriteMs",
];

function aggregateGatewayTimings(calls) {
  const totals = Object.fromEntries(
    GATEWAY_TIMING_STAGE_KEYS.map((key) => [key, 0]),
  );
  for (const call of calls) {
    for (const key of GATEWAY_TIMING_STAGE_KEYS) {
      if (key === "derived.serverNonWorkerBeforeWriteMs") continue;
      totals[key] += finiteNumber(valueAtPath(call, key), 0);
    }
    totals["derived.serverNonWorkerBeforeWriteMs"] += Math.max(
      0,
      finiteNumber(call.serverBeforeWriteMs, 0) -
        finiteNumber(call.worker?.totalMs, 0),
    );
  }
  return Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [key, round(value)]),
  );
}

function valueAtPath(value, path) {
  return path.split(".").reduce(
    (current, segment) => current?.[segment],
    value,
  );
}

export function calculatePairedComparisons(flows) {
  const flowIds = LOCAL_FLOW_IDS.filter((flowId) => flows?.[flowId]);
  const indexes = commonMeasuredSampleIndexes(flows, flowIds, [
    ["previous", "optimized"],
    ["candidate", "optimized"],
    ["vscode", "individual"],
    ["vscode", "batch"],
  ]);
  const samples = indexes.map((sampleIndex) => {
    let previousMs = 0;
    let candidateMs = 0;
    let vscodeBestMs = 0;
    for (const flowId of flowIds) {
      previousMs += comparisonDuration(
        measuredSample(flows, flowId, "previous", "optimized", sampleIndex),
      );
      candidateMs += comparisonDuration(
        measuredSample(flows, flowId, "candidate", "optimized", sampleIndex),
      );
      const individual = comparisonDuration(
        measuredSample(flows, flowId, "vscode", "individual", sampleIndex),
      );
      const batch = comparisonDuration(
        measuredSample(flows, flowId, "vscode", "batch", sampleIndex),
      );
      vscodeBestMs += Math.min(individual, batch);
    }
    return {
      sample: sampleIndex,
      previousMs: round(previousMs),
      candidateMs: round(candidateMs),
      vscodeBestMs: round(vscodeBestMs),
      previousImprovementPercent: improvement(candidateMs, previousMs),
      vscodeImprovementPercent: improvement(candidateMs, vscodeBestMs),
    };
  });
  const finiteValues = (key) => samples.map((sample) => Number(sample[key])).filter(Number.isFinite);
  return {
    pairedSamples: samples.length,
    previousMs: distribution(finiteValues("previousMs")),
    candidateMs: distribution(finiteValues("candidateMs")),
    vscodeBestMs: distribution(finiteValues("vscodeBestMs")),
    previousImprovementPercent:
      distribution(finiteValues("previousImprovementPercent")),
    vscodeImprovementPercent:
      distribution(finiteValues("vscodeImprovementPercent")),
    samples,
  };
}
export function classifyDevStability(currentReport, history = []) {
  const comparableByMoment = new Map();
  for (const report of [...history, currentReport].filter((report) =>
    report?.suite === "dev" &&
    report?.source?.candidate?.commit === currentReport?.source?.candidate?.commit &&
    report?.source?.candidate?.sourceTreeSha256 ===
      currentReport?.source?.candidate?.sourceTreeSha256
  )) {
    const capturedAt = String(report?.capturedAt ?? "");
    if (!Number.isFinite(Date.parse(capturedAt))) continue;
    comparableByMoment.set(capturedAt, report);
  }
  const runs = [...comparableByMoment.values()]
    .sort((left, right) =>
      String(left.capturedAt).localeCompare(String(right.capturedAt))
    )
    .slice(-3);
  const functionalStop = runs.some((report) =>
    Number(report?.safety?.functionalErrors ?? 0) > 0 ||
    Number(report?.safety?.writeAttempts ?? 0) > 0 ||
    Number(report?.safety?.authenticationBreaks ?? 0) > 0
  );
  const flowVariation = Object.fromEntries(DEV_FLOW_IDS.map((flowId) => {
    const values = runs.map((report) =>
      Number(report?.flows?.[flowId]?.candidate?.optimized?.latencyMs?.p95)
    );
    return [flowId, coefficientOfVariation(values)];
  }));
  const stable = runs.length === 3 &&
    Object.values(flowVariation).every((value) => value !== null && value <= 0.15);
  return {
    mode: stable ? "gate" : "observational",
    passed: !functionalStop && (!stable || Object.values(flowVariation).every((value) => value <= 0.15)),
    comparableRuns: runs.length,
    stable,
    functionalStop,
    coefficientOfVariation: flowVariation,
  };
}

export function validateDevConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) {
    throw new Error("Dev configuration must be a JSON object.");
  }
  rejectSensitiveConfiguration(rawConfig);
  const allowedKeys = new Set(["url", "profiles", "windowDays", "rowLimit"]);
  for (const key of Object.keys(rawConfig)) {
    if (!allowedKeys.has(key)) throw new Error(`Dev configuration contains unsupported key: ${key}.`);
  }
  const url = new URL(requiredString(rawConfig.url, "url"));
  if (url.protocol !== "https:") throw new Error("Dev URL must use HTTPS.");
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  if (hostname !== "dev-private.example.test") {
    throw new Error("Dev URL must point to the allowed LegacySite Dev domain.");
  }
  if (containsForbiddenDevAction(url.href)) {
    throw new Error("Dev URL contains a forbidden action or Production marker.");
  }
  if (!isPlainObject(rawConfig.profiles)) {
    throw new Error("Dev configuration requires profiles for candidate, previous and vscode.");
  }
  const profileKeys = Object.keys(rawConfig.profiles);
  if (
    profileKeys.length !== FLOW_ENGINES.length ||
    !FLOW_ENGINES.every((engine) => profileKeys.includes(engine))
  ) {
    throw new Error("Dev profiles must contain exactly candidate, previous and vscode.");
  }
  const profiles = Object.fromEntries(FLOW_ENGINES.map((engine) => [
    engine,
    requiredString(rawConfig.profiles[engine], `profiles.${engine}`),
  ]));
  if (new Set(Object.values(profiles).map(normalizePath)).size !== FLOW_ENGINES.length) {
    throw new Error("Dev benchmark profiles must be three distinct directories.");
  }
  for (const profilePath of Object.values(profiles)) {
    const normalized = normalizePath(profilePath);
    if (
      /\\google\\chrome\\user data(?:\\|$)/iu.test(normalized) ||
      /\\microsoft\\edge\\user data(?:\\|$)/iu.test(normalized)
    ) {
      throw new Error("Personal Chrome or Edge profiles cannot be used for Dev benchmarks.");
    }
  }
  const windowDays = positiveInteger(rawConfig.windowDays, "windowDays", 7);
  const rowLimit = positiveInteger(rawConfig.rowLimit, "rowLimit", 20);
  if (windowDays !== 7) throw new Error("Dev benchmark windowDays must be exactly 7.");
  if (rowLimit !== 20) throw new Error("Dev benchmark rowLimit must be exactly 20.");
  return {
    url: url.href,
    profiles,
    windowDays,
    rowLimit,
  };
}

export function assertDevOperationAllowed(operation) {
  const serialized = normalizeText(
    typeof operation === "string" ? operation : JSON.stringify(operation),
  );
  if (FORBIDDEN_DEV_ACTIONS.some((forbidden) => serialized.includes(normalizeText(forbidden)))) {
    throw new Error("Dev benchmark attempted a forbidden action.");
  }
  return true;
}

export function containsForbiddenDevAction(value) {
  const normalized = normalizeText(String(value));
  return FORBIDDEN_DEV_ACTIONS.some((forbidden) => normalized.includes(normalizeText(forbidden)));
}

export function sanitizeBenchmarkValue(value) {
  return sanitizeValue(value, new WeakSet());
}

export function sanitizedRowSignature(rows) {
  const normalized = rows.map((row) =>
    Array.isArray(row)
      ? row.map((cell) => normalizeText(String(cell))).join("\u001f")
      : normalizeText(JSON.stringify(row))
  );
  return {
    count: rows.length,
    sha256: createHash("sha256").update(normalized.join("\u001e")).digest("hex"),
  };
}

export function sanitizedGridSignature(tableText, rowCount) {
  const count = Math.max(0, Math.trunc(Number(rowCount) || 0));
  const canonicalText = normalizeText(String(tableText ?? ""))
    .replace(/\s+/gu, " ")
    .trim();
  return {
    count,
    sha256: createHash("sha256")
      .update(`${count}\u001f${canonicalText}`)
      .digest("hex"),
  };
}

export function validateFlowPostcondition(flowId, observation) {
  switch (flowId) {
    case "legacy-menu-cold":
      return exactBoolean(observation?.destinationReady) &&
        observation?.heading === "Histórico" &&
        (observation?.cache?.applicable === false
          ? observation?.executionPhase === "first"
          : observation?.cache?.hit === false);
    case "legacy-menu-warm":
      return exactBoolean(observation?.destinationReady) &&
        observation?.heading === "Histórico" &&
        (observation?.cache?.applicable === false
          ? observation?.executionPhase === "repeat"
          : observation?.cache?.hit === true &&
            observation?.cache?.revalidated === true);
    case "large-menu":
      return Number(observation?.indexedItems) >= 2_500 &&
        observation?.heading === "Conferências" &&
        exactBoolean(observation?.destinationReady);
    case "multi-frame-form":
      return observation?.query === "consulta legacy" &&
        observation?.category === "recent" &&
        observation?.asserted === true;
    case "controlled-postback":
      return (
        observation?.confirmation?.challenged === true ||
        observation?.confirmation?.applicable === false ||
        observation?.confirmationRequired === true
      ) &&
        observation?.documentReplaced === true &&
        Number(observation?.postCount) === 1;
    case "cpx-finance-open":
      return observation?.environment === "dev" &&
        observation?.header === true &&
        observation?.filters === true;
    case "cpx-finance-refresh":
      return observation?.environment === "dev" &&
        observation?.windowDays === 7 &&
        Number(observation?.rowCount) <= 20 &&
        observation?.accountPreserved === true;
    case "cpx-finance-navigation":
      return ["Conferências", "Pendências", "Histórico"].every((panel) =>
        observation?.panels?.includes(panel)
      );
    case "cpx-finance-grid":
      return observation?.empty === true ||
        (Number(observation?.rowCount) <= 20 && /^[a-f0-9]{64}$/u.test(observation?.sha256 ?? ""));
    default:
      throw new Error(`Unknown benchmark flow: ${flowId}.`);
  }
}

function aggregateP95(
  flows,
  flowIds,
  engine,
  pathName,
  distributionName = "latencyMs",
) {
  const values = flowIds.map((flowId) =>
    Number(flows?.[flowId]?.[engine]?.[pathName]?.[distributionName]?.p95)
  );
  return values.every(Number.isFinite)
    ? round(values.reduce((sum, value) => sum + value, 0), 3)
    : Number.NaN;
}

function aggregateBestVsCodeP95(
  flows,
  flowIds,
  distributionName = "latencyMs",
) {
  const values = flowIds.map((flowId) => {
    const individual = Number(
      flows?.[flowId]?.vscode?.individual?.[distributionName]?.p95,
    );
    const batch = Number(
      flows?.[flowId]?.vscode?.batch?.[distributionName]?.p95,
    );
    return Math.min(individual, batch);
  });
  return values.every(Number.isFinite)
    ? round(values.reduce((sum, value) => sum + value, 0), 3)
    : Number.NaN;
}

function aggregateCalls(flows, flowIds, engine, pathName) {
  const values = flowIds.map((flowId) =>
    Number(flows?.[flowId]?.[engine]?.[pathName]?.toolCalls?.p50)
  );
  return values.every(Number.isFinite)
    ? round(values.reduce((sum, value) => sum + value, 0), 3)
    : Number.NaN;
}

function aggregateSuccessRate(flows, flowIds, engine, pathName) {
  let samples = 0;
  let successes = 0;
  for (const flowId of flowIds) {
    samples += Number(flows?.[flowId]?.[engine]?.[pathName]?.samples ?? 0);
    successes += Number(flows?.[flowId]?.[engine]?.[pathName]?.successes ?? 0);
  }
  return samples > 0 ? round(successes / samples, 6) : 0;
}

function confirmationProtocolCoverage(flows) {
  const paths = [
    ["candidate", "optimized"],
    ["candidate", "gateway"],
  ];
  let samples = 0;
  let challenged = 0;
  for (const [engine, pathName] of paths) {
    const source = flows?.["controlled-postback"]?.[engine]?.samples?.[pathName] ?? [];
    for (const sample of source) {
      if (sample.phase !== "measured") continue;
      samples += 1;
      if (sample?.observation?.confirmation?.challenged === true) challenged += 1;
    }
  }
  return {
    samples,
    challenged,
    rate: samples > 0 ? round(challenged / samples, 6) : 0,
  };
}

function commonMeasuredSampleIndexes(flows, flowIds, descriptors) {
  if (flowIds.length === 0) return [];
  let common;
  for (const flowId of flowIds) {
    for (const [engine, pathName] of descriptors) {
      const indexes = new Set(
        flowSamples(flows, flowId, engine, pathName)
          .filter((sample) => sample.phase === "measured" && sample.success === true)
          .map((sample) => Number(sample.sample))
          .filter(Number.isInteger),
      );
      common = common === undefined
        ? indexes
        : new Set([...common].filter((index) => indexes.has(index)));
    }
  }
  return [...(common ?? [])].sort((left, right) => left - right);
}

function flowSamples(flows, flowId, engine, pathName) {
  const samples = flows?.[flowId]?.[engine]?.samples;
  if (Array.isArray(samples)) {
    return pathName === "optimized" ? samples : [];
  }
  return samples?.[pathName] ?? [];
}

function measuredSample(flows, flowId, engine, pathName, sampleIndex) {
  const sample = flowSamples(flows, flowId, engine, pathName).find(
    (candidate) =>
      candidate.phase === "measured" &&
      candidate.success === true &&
      Number(candidate.sample) === sampleIndex,
  );
  if (!sample) {
    throw new Error(
      `Missing successful paired sample: ${flowId}/${engine}/${pathName}/${sampleIndex}.`,
    );
  }
  return sample;
}

function comparisonDuration(sample) {
  return finiteNumber(sample?.comparisonDurationMs ?? sample?.durationMs);
}
function sumSamples(flows, flowIds, key) {
  return flowIds.reduce((sum, flowId) =>
    sum + Number(flows?.[flowId]?.safety?.[key] ?? 0), 0);
}

function improvement(candidate, reference) {
  if (!Number.isFinite(candidate) || !Number.isFinite(reference) || reference <= 0) {
    return Number.NaN;
  }
  return round((1 - candidate / reference) * 100, 3);
}

function distribution(values, emptyValue = null) {
  const mean = values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
  const standardDeviation = values.length > 1 && mean !== null
    ? Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) /
      (values.length - 1))
    : null;
  return {
    p50: percentile(values, 0.5, emptyValue),
    p95: percentile(values, 0.95, emptyValue),
    p99: percentile(values, 0.99, emptyValue),
    min: values.length > 0 ? round(Math.min(...values), 3) : emptyValue,
    max: values.length > 0 ? round(Math.max(...values), 3) : emptyValue,
    mean: mean === null ? emptyValue : round(mean, 3),
    standardDeviation: standardDeviation === null ? emptyValue : round(standardDeviation, 3),
    coefficientOfVariation: coefficientOfVariation(values) ?? emptyValue,
  };
}

function percentile(values, ratio, emptyValue = null) {
  if (values.length === 0) return emptyValue;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return round(sorted[index], 3);
}

function sanitizeValue(value, seen) {
  if (typeof value === "string") {
    if (SENSITIVE_VALUE.test(value)) return "[redacted]";
    return value.length > 4_000 ? `${value.slice(0, 4_000)}[truncated]` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeValue(entry, seen),
  ]));
}

function rejectSensitiveConfiguration(value, path = "config") {
  if (typeof value === "string") {
    if (SENSITIVE_VALUE.test(value)) throw new Error(`${path} appears to contain credentials.`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      throw new Error(`Dev configuration cannot contain sensitive key: ${path}.${key}.`);
    }
    rejectSensitiveConfiguration(entry, `${path}.${key}`);
  }
}

function normalizeText(value) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
}

function normalizePath(value) {
  return value.replaceAll("/", "\\").replace(/[\\]+$/u, "").toLocaleLowerCase("en-US");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactBoolean(value) {
  return value === true;
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  if (fallback !== undefined) return fallback;
  throw new Error(`Expected a finite benchmark value, received ${String(value)}.`);
}

function positiveInteger(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
