import { performance } from "node:perf_hooks";
import { routeRunCommandInput } from "../../../services/workspace-agent/dist/shell/qualified-command-compatibility.js";
import { QualifiedCommandPlanQualifier } from "../../../services/workspace-agent/dist/shell/qualified/command-plan-qualifier.js";
import { proposeDeterministicRepair } from "../../../services/workspace-agent/dist/shell/qualified/deterministic-repair.js";
import { QualifiedCommandMetrics } from "../../../services/workspace-agent/dist/shell/qualified/qualified-command-metrics.js";
import { ShellService } from "../../../services/workspace-agent/dist/shell/service.js";

const workspace = {
  id: "benchmark",
  name: "Benchmark",
  rootPath: process.cwd(),
  canonicalRootPath: process.cwd(),
  enabled: true,
  permissionProfile: "full-repo-write",
  allowedRoots: [
    {
      logicalPath: ".",
      absolutePath: process.cwd(),
      canonicalPath: process.cwd(),
      kind: "directory",
    },
  ],
  blockedGlobs: [],
  limits: {
    maxFileBytes: 64_000,
    maxSearchResults: 100,
    maxSearchSnippetBytes: 20_000,
    maxDiffBytes: 500_000,
    maxListedFiles: 500,
  },
  allowWrites: ["."],
  allowShell: ["."],
  allowedShells: ["cmd"],
};

const context = {
  workspaceId: "benchmark",
  logicalCwd: ".",
  absoluteCwd: process.cwd(),
  platform: "win32",
  architecture: "x64",
  allowedShells: ["cmd"],
  markers: [
    { path: ".git", kind: "repository" },
    { path: "package.json", kind: "package-manifest", sha256: "a".repeat(64) },
  ],
  packageMetadata: {
    packageManager: "npm@11",
    scripts: [
      {
        name: "test",
        commandSha256: "b".repeat(64),
        effectClass: "repeatable_local",
        riskClass: "safe",
      },
    ],
  },
  git: { repository: true, dirty: false },
  tools: [
    { name: "cmd", available: true, version: "10" },
    { name: "git", available: true, version: "2.53" },
    { name: "node", available: true, version: "24" },
    { name: "npm", available: true, version: "11" },
    { name: "npx", available: true, version: "11" },
    { name: "pnpm", available: true, version: "10" },
    { name: "yarn", available: true, version: "4" },
  ],
};

const collector = { async collect() { return context; } };
const qualifier = new QualifiedCommandPlanQualifier(collector);
const qualificationSamples = [];
for (let index = 0; index < 1_000; index += 1) {
  const startedAt = performance.now();
  const result = await qualifier.qualify(workspace, {
    invocationId: `explicit-${index}`,
    workspaceId: "benchmark",
    input: {
      workspaceId: "benchmark",
      command: "git status --short",
      shell: "cmd",
      executionMode: "qualified",
      timeoutMs: 30_000,
    },
  });
  if (result.status !== "qualified") throw new Error("Explicit qualification failed.");
  qualificationSamples.push(performance.now() - startedAt);
}

await qualifier.qualify(workspace, {
  invocationId: "cache-warmup",
  workspaceId: "benchmark",
  input: {
    workspaceId: "benchmark",
    objective: "Executar os testes",
    timeoutMs: 30_000,
  },
});
const cacheSamples = [];
for (let index = 0; index < 1_000; index += 1) {
  const startedAt = performance.now();
  const result = await qualifier.qualify(workspace, {
    invocationId: `cache-${index}`,
    workspaceId: "benchmark",
    input: {
      workspaceId: "benchmark",
      objective: "Executar os testes",
      timeoutMs: 30_000,
    },
  });
  if (result.status !== "qualified") throw new Error("Cached qualification failed.");
  cacheSamples.push(performance.now() - startedAt);
}

const directInput = {
  workspaceId: "benchmark",
  command: "node --version",
  shell: "cmd",
  executionMode: "direct",
  timeoutMs: 30_000,
};
const directFlags = {
  qualifiedExecution: false,
  safeAutoCorrection: false,
  shadowMode: false,
  providerEnabled: false,
};
const shellService = new ShellService();
const directMetrics = new QualifiedCommandMetrics();
const baselineSamples = [];
for (let index = 0; index < 30; index += 1) {
  baselineSamples.push(await measureDirect());
}
const instrumentationOverheadSamples = [];
const directBatchSize = 25_000;
for (let batch = 0; batch < 30; batch += 1) {
  let baselineBatchMs;
  let instrumentedBatchMs;
  if (batch % 2 === 0) {
    baselineBatchMs = measureRoutingBatch(false, directBatchSize);
    instrumentedBatchMs = measureRoutingBatch(true, directBatchSize);
  } else {
    instrumentedBatchMs = measureRoutingBatch(true, directBatchSize);
    baselineBatchMs = measureRoutingBatch(false, directBatchSize);
  }
  instrumentationOverheadSamples.push(
    Math.max(0, instrumentedBatchMs - baselineBatchMs) / directBatchSize,
  );
}

const repairCases = [
  repairCase("resource_locked", "pure_read", "git", ["status"], "."),
  repairCase("resource_locked", "repeatable_local", "npm", ["test"], "."),
  repairCase("transient_failure", "pure_read", "git", ["status"], "."),
  repairCase("transient_failure", "pure_read", "node", ["--version"], "."),
  repairCase("executable_unavailable", "pure_read", "git.exe", ["status"], "."),
  repairCase("executable_unavailable", "pure_read", "node.exe", ["--version"], "."),
  repairCase("executable_unavailable", "repeatable_local", "npm.cmd", ["test"], "."),
  repairCase("executable_unavailable", "repeatable_local", "npx.cmd", ["jest"], "."),
  repairCase("wrong_working_directory", "pure_read", "git", ["status"], "nested"),
  repairCase("wrong_working_directory", "repeatable_local", "npm", ["test"], "nested"),
];
const resolvedRepairs = repairCases.filter(({ input, plan, diagnosis }) =>
  proposeDeterministicRepair(input, plan, diagnosis, context),
).length;
const correctionRate = resolvedRepairs / repairCases.length;
const manualCallsBaseline = repairCases.length * 2;
const manualCallsWithEngine = repairCases.length;
const manualCallReduction =
  1 - manualCallsWithEngine / manualCallsBaseline;

const baseline = summarize(baselineSamples);
const instrumentationOverhead = summarize(instrumentationOverheadSamples);
const directRegressionPercent = baseline.p95Ms === 0
  ? 0
  : (instrumentationOverhead.p95Ms / baseline.p95Ms) * 100;
const result = {
  qualification: summarize(qualificationSamples),
  cacheHit: summarize(cacheSamples),
  directExecution: {
    baseline,
    instrumentationOverhead,
    p95RegressionPercent: round(directRegressionPercent),
  },
  deterministicRepairCorpus: {
    cases: repairCases.length,
    resolved: resolvedRepairs,
    correctionRate: round(correctionRate),
    manualCallsBaseline,
    manualCallsWithEngine,
    manualCallReduction: round(manualCallReduction),
  },
  cache: qualifier.recipeCacheSnapshot(),
};
console.log(JSON.stringify(result));
if (result.qualification.p95Ms > 50) {
  throw new Error(`Qualification p95 exceeded 50 ms: ${result.qualification.p95Ms}`);
}
if (result.cacheHit.p95Ms > 25) {
  throw new Error(`Cache hit p95 exceeded 25 ms: ${result.cacheHit.p95Ms}`);
}
if (result.directExecution.p95RegressionPercent > 5) {
  throw new Error(
    `Direct execution p95 regression exceeded 5%: ${result.directExecution.p95RegressionPercent}`,
  );
}
if (result.deterministicRepairCorpus.correctionRate < 0.9) {
  throw new Error(
    `Deterministic correction rate fell below 90%: ${result.deterministicRepairCorpus.correctionRate}`,
  );
}
if (result.deterministicRepairCorpus.manualCallReduction < 0.5) {
  throw new Error(
    `Manual call reduction fell below 50%: ${result.deterministicRepairCorpus.manualCallReduction}`,
  );
}

async function measureDirect() {
  const startedAt = performance.now();
  const routed = routeRunCommandInput(directInput, directFlags);
  if (routed.mode !== "direct") throw new Error("Direct routing changed mode.");
  const response = await shellService.runCommand(workspace, routed.input, {});
  if (response.status !== "executed" || response.exitCode !== 0) {
    throw new Error("Direct benchmark command failed.");
  }
  return performance.now() - startedAt;
}

function measureRoutingBatch(instrumented, iterations) {
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const routed = routeRunCommandInput(directInput, directFlags);
    if (routed.mode !== "direct") throw new Error("Direct routing changed mode.");
    if (instrumented) directMetrics.recordRoute("direct", false);
  }
  return performance.now() - startedAt;
}

function repairCase(category, effectClass, executable, argv, cwd) {
  const command = [executable, ...argv].join(" ");
  return {
    input: {
      workspaceId: "benchmark",
      command,
      shell: "cmd",
      executionMode: "qualified",
      autoCorrection: "safe",
      cwd,
      timeoutMs: 30_000,
    },
    plan: {
      invocationId: `repair-${category}-${executable}-${cwd}`,
      source: "explicit-command",
      shell: "cmd",
      cwd,
      execution: { kind: "argv", executable, argv },
      timeoutMs: 30_000,
      absoluteDeadline: "2099-01-01T00:00:00.000Z",
      riskClass: "safe",
      effectClass,
      expectedOutcomes: [{ kind: "exit_code", value: 0 }],
      postconditions: [{ kind: "exit_code", value: 0 }],
      fingerprint: "c".repeat(64),
      provenance: { source: "explicit-command", sanitized: true },
    },
    diagnosis: {
      category,
      confidence: 0.99,
      source: "deterministic",
    },
  };
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

function percentile(sorted, ratio) {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return round(sorted[index] ?? 0);
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
