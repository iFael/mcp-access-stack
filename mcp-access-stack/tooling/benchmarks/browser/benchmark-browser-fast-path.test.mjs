import assert from "node:assert/strict";
import test from "node:test";
import {
  browserFastPathDefaults,
  evaluateBrowserPerformanceGates,
  summarizeFastPathBenchmark,
  summarizeOperationBenchmark,
} from "./benchmark-browser-fast-path.mjs";

test("uses bounded local qualification defaults", () => {
  assert.deepEqual(browserFastPathDefaults, {
    iterations: 10,
    warmupIterations: 3,
    flowIterations: 10,
    unitsPerRun: 10,
  });
});

test("summarizes browser sequence speedup per effective action", () => {
  assert.deepEqual(
    summarizeFastPathBenchmark([100, 120, 110], [25, 30, 20], 10),
    {
      iterations: 3,
      unitsPerRun: 10,
      individual: {
        p50Ms: 110,
        p95Ms: 120,
        p99Ms: 120,
        p50MsPerUnit: 11,
        toolCallsPerFlow: 10,
      },
      sequence: {
        p50Ms: 25,
        p95Ms: 30,
        p99Ms: 30,
        p50MsPerUnit: 2.5,
        toolCallsPerFlow: 1,
      },
      speedup: 4.4,
      roundTripReductionPercent: 90,
      toolCallsPerFlow: 1,
    },
  );
});

test("summarizes action plus state latency and response size", () => {
  assert.deepEqual(
    summarizeOperationBenchmark(
      [10, 20, 30, 40, 50],
      [100, 200, 300, 400, 500],
      30,
    ),
    {
      samples: 5,
      warmupIterations: 30,
      p50Ms: 30,
      p95Ms: 50,
      p99Ms: 50,
      responseBytes: { p50: 300, p95: 500, p99: 500 },
    },
  );
});

test("enforces mandatory browser release gates separately from the extended target", () => {
  assert.deepEqual(
    evaluateBrowserPerformanceGates(
      {
        actionState: { p95Ms: 60 },
        flows: { toolCallsPerFlow: 1 },
        gatewayOverheadPercent: 4,
        soakSuccessRate: 1,
        duplicateMutations: 0,
        crossTabBlockingIncidents: 0,
      },
      {
        current: { actionStateP95Ms: 100, toolCallsPerFlow: 4 },
        vscode: { actionStateP95Ms: 70 },
      },
    ),
    {
      checks: {
        vscodeParity: true,
        vscodeExtendedTarget: false,
        currentEngineImprovement: true,
        toolCallReduction: true,
        gatewayOverhead: true,
        soakSuccessRate: true,
        duplicateMutations: true,
        crossTabBlocking: true,
      },
      passed: true,
      extendedTargetPassed: false,
    },
  );
});
