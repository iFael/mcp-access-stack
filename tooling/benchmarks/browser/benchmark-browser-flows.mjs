import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  machineSummary,
  prepareOfficialSource,
  sourceSummary,
  startIsolatedBrowserWorker,
  startIsolatedGateway,
  vscodeSummary,
} from "./browser-benchmark-runtime.mjs";
import {
  buildExecutionSchedule,
  calculatePairedComparisons,
  calculatePairedTransport,
  evaluateLocalFlowGates,
  LOCAL_FLOW_IDS,
  sanitizeBenchmarkValue,
  summarizeFlowSamples,
} from "./flow-benchmark-core.mjs";
import { startFlowBenchmarkFixture } from "./flow-benchmark-fixture.mjs";
import {
  createVsCodeFlowAdapter,
  createWorkerFlowAdapter,
} from "./flow-benchmark-local.mjs";
import { runDevFlowSuite } from "./flow-benchmark-dev.mjs";

const DEFAULT_WARMUPS = 5;
const DEFAULT_ITERATIONS = 30;
const OUTPUT_ROOT = path.join("runtime", "benchmarks", "browser", "flows");

export async function runBrowserFlowBenchmarks(options) {
  const candidateRoot = path.resolve(options.candidateRoot ?? process.cwd());
  const previousRoot = path.resolve(required(options.previousRoot, "previousRoot"));
  const suite = parseSuite(options.suite ?? "local");
  const gatewayMode = parseGatewayMode(options.gatewayMode ?? "docker");
  const warmups = positiveInteger(options.warmups ?? DEFAULT_WARMUPS, "warmups", 200);
  const iterations = positiveInteger(options.iterations ?? DEFAULT_ITERATIONS, "iterations", 1_000);
  if (options.official && options.transportOnly) {
    throw new Error("Official flow benchmarks cannot use transport-only mode.");
  }
  if (options.official && options.skipVsCode) {
    throw new Error("Official flow benchmarks cannot skip VS Code.");
  }
  if (options.official && gatewayMode !== "docker") {
    throw new Error("Official flow benchmarks require the Docker gateway.");
  }
  if (["local", "all"].includes(suite) && !options.skipVsCode) {
    required(options.vscodePageId, "vscodePageId");
  }
  if (["dev", "all"].includes(suite)) {
    required(options.devConfigPath, "devConfig");
    required(options.vscodePageId, "vscodePageId");
  }

  const activeVsCodePromise = vscodeSummary();
  let candidateSource;
  let previousSource;
  if (options.official) {
    candidateSource = await prepareOfficialSource(candidateRoot, "candidate");
    previousSource = await prepareOfficialSource(previousRoot, "previous");
  } else {
    [candidateSource, previousSource] = await Promise.all([
      sourceSummary(candidateRoot),
      sourceSummary(previousRoot),
    ]);
  }
  const activeVsCode = await activeVsCodePromise;

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDirectory = path.resolve(candidateRoot, OUTPUT_ROOT, runId);
  const scratchDirectory = path.join(outputDirectory, "scratch");
  await mkdir(scratchDirectory, { recursive: true });
  const common = {
    schemaVersion: 1,
    runId,
    capturedAt: new Date().toISOString(),
    suite,
    official: options.official === true,
    officialRefusalReason: options.official
      ? null
      : "Exploratory run: dirty trees are permitted and the result is not a release gate artifact.",
    samples: {
      warmups,
      measuredIterations: iterations,
    },
    machine: machineSummary(),
    source: {
      candidate: candidateSource,
      previous: previousSource,
      vscode: activeVsCode,
    },
    boundaries: {
      comparison:
        "First required browser action through exact final postcondition. Controlled postback compares authorized execution; its confirmation challenge is published separately as protocol latency.",
      direct: "Browser Worker loopback HTTP: typed operations through exact final postcondition.",
      gateway: "Isolated MCP gateway and Docker boundary routed to the isolated candidate Browser Worker.",
      vscodeIndividual: "Authenticated VS Code bridge with one native tool round trip per action through the same final postcondition.",
      vscodeBatch: "Authenticated VS Code bridge with one static run_playwright_code batch through the same final postcondition.",
      cacheSemantics:
        "Candidate and previous publish structural cache evidence. VS Code publishes first/repeat execution only and never claims an equivalent internal cache.",
      confirmationSemantics:
        "Candidate and previous execute the real confirmation challenge. VS Code has no equivalent challenge, so only authorized execution latency is used for cross-engine comparison.",
      public:
        "Public/ngrok is intentionally not contacted unless a future deployed-result run is explicitly authorized; it is never part of the local gate.",
      modelDeliberation: "Excluded.",
    },
  };

  let local;
  let dev;
  if (["local", "all"].includes(suite)) {
    local = await runLocalSuite({
      candidateRoot,
      previousRoot,
      scratchDirectory,
      vscodePageId: options.vscodePageId,
      vscodeRuntimePath: options.vscodeRuntimePath,
      warmups,
      iterations,
      skipVsCode: options.skipVsCode === true || options.transportOnly === true,
      transportOnly: options.transportOnly === true,
      gatewayMode,
    });
  }
  if (["dev", "all"].includes(suite)) {
    dev = await runDevFlowSuite({
      candidateRoot,
      previousRoot,
      scratchDirectory,
      vscodePageId: options.vscodePageId,
      vscodeRuntimePath: options.vscodeRuntimePath,
      devConfigPath: path.resolve(options.devConfigPath),
      devAuthSignalPath: options.devAuthSignalPath
        ? path.resolve(options.devAuthSignalPath)
        : undefined,
      warmups,
      iterations,
      source: common.source,
      historyDirectory: options.devHistoryDirectory
        ? path.resolve(options.devHistoryDirectory)
        : path.resolve(candidateRoot, OUTPUT_ROOT),
      gatewayMode,
      runId,
      capturedAt: common.capturedAt,
    });
  }

  const report = sanitizeBenchmarkValue({
    ...common,
    ...(local ?? {}),
    ...(dev ? { dev } : {}),
  });
  const jsonPath = path.join(outputDirectory, "flows.json");
  const markdownPath = path.join(outputDirectory, "flows.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, renderMarkdown(report), "utf8"),
  ]);
  return { report, jsonPath, markdownPath };
}

async function runLocalSuite(options) {
  const fixture = await startFlowBenchmarkFixture();
  let previousWorker;
  let candidateWorker;
  let gateway;
  let vscode;
  try {
    if (options.transportOnly) {
      candidateWorker = await startIsolatedBrowserWorker({
        label: "candidate",
        root: options.candidateRoot,
        scratchDirectory: options.scratchDirectory,
        browserChannel: "chromium",
      });
    } else {
      [previousWorker, candidateWorker] = await Promise.all([
        startIsolatedBrowserWorker({
          label: "previous",
          root: options.previousRoot,
          scratchDirectory: options.scratchDirectory,
        }),
        startIsolatedBrowserWorker({
          label: "candidate",
          root: options.candidateRoot,
          scratchDirectory: options.scratchDirectory,
          browserChannel: "chromium",
        }),
      ]);
    }
    gateway = await startIsolatedGateway({
      root: options.candidateRoot,
      worker: candidateWorker,
      mode: options.gatewayMode,
      scratchDirectory: path.join(options.scratchDirectory, "gateway-private"),
    });
    if (!options.skipVsCode) {
      vscode = await createVsCodeFlowAdapter({
        pageId: options.vscodePageId,
        runtimePath: options.vscodeRuntimePath,
        fixture,
      });
    }

    const adapters = {
      previous: previousWorker
        ? {
            optimized: createWorkerFlowAdapter({
              name: "previous",
              call: previousWorker.call,
              fixture,
              supportsNavigationCheckpoint: false,
            }),
          }
        : {},
      candidate: {
        optimized: createWorkerFlowAdapter({
          name: "candidate",
          call: candidateWorker.call,
          fixture,
        }),
        gateway: createWorkerFlowAdapter({
          name: "candidate",
          call: gateway.call,
          fixture,
          route: "gateway",
        }),
      },
      vscode: {
        ...(vscode ? { individual: vscode, batch: vscode } : {}),
      },
    };
    const schedule = buildExecutionSchedule({
      warmups: options.warmups,
      iterations: options.iterations,
    });
    const flows = {};
    for (const flowId of LOCAL_FLOW_IDS) {
      const raw = {
        previous: { optimized: [] },
        candidate: { optimized: [], gateway: [] },
        vscode: { individual: [], batch: [] },
      };
      for (const scheduled of schedule) {
        const scheduledEngines = options.transportOnly
          ? ["candidate"]
          : scheduled.order;
        for (const engine of scheduledEngines) {
          if (engine === "vscode" && options.skipVsCode) continue;
          const paths = engine === "candidate"
            ? (scheduled.index % 2 === 0 ? ["optimized", "gateway"] : ["gateway", "optimized"])
            : engine === "vscode"
              ? (scheduled.index % 2 === 0 ? ["individual", "batch"] : ["batch", "individual"])
              : ["optimized"];
          for (const pathName of paths) {
            const context = {
              phase: scheduled.phase,
              sample: scheduled.sample,
              scheduleIndex: scheduled.index,
              engineOrder: options.transportOnly ? ["candidate"] : scheduled.order,
              pathName,
            };
            raw[engine][pathName].push(
              await captureSample(adapters[engine][pathName], flowId, context),
            );
          }
        }
      }
      flows[flowId] = summarizeFlow(flowId, raw, options.warmups);
    }
    const transport = calculatePairedTransport(flows);
    const comparisons = calculatePairedComparisons(flows);
    const localReport = {
      fixture: {
        origin: fixture.origin,
        description:
          "Deterministic loopback frameset, 2,505-item legacy menu, multi-frame form and counted POST document replacement.",
      },
      methodology: {
        order: options.transportOnly
          ? "Candidate direct and Gateway paths alternate order per sample."
          : "Three-order Latin square rotated per warmup and measured sample.",
        concurrency: 1,
        measuredIterations: options.iterations,
        setupExcluded: true,
        failuresRetained: true,
        postconditionsValidatedOutsideMeasuredBoundary: false,
        pairedByMeasuredSample: true,
        comparisonUsesAuthorizedExecutionForControlledPostback: true,
      },
      executionSchedule: schedule.map((entry) => ({
        ...entry,
        order: options.transportOnly ? ["candidate"] : [...entry.order],
      })),
      flows,
      comparisons,
      transport: {
        ...transport,
        gatewayRuntime: gateway.provenance,
        public: {
          status: "not-measured",
          reason:
            "No deployed endpoint was contacted because production containers and protected tabs are outside this harness.",
        },
      },
      vscodeStatus: options.skipVsCode
        ? {
            status: "skipped",
            reason: options.transportOnly
              ? "Exploratory transport-only validation; baseline and VS Code are intentionally excluded."
              : "Exploratory validation requested --skip-vscode; official runs forbid this.",
          }
        : { status: "measured" },
    };
    return {
      ...localReport,
      gates: evaluateLocalFlowGates(localReport),
    };
  } finally {
    await vscode?.close().catch(() => undefined);
    await gateway?.close().catch(() => undefined);
    await Promise.all([
      previousWorker?.close().catch(() => undefined),
      candidateWorker?.close().catch(() => undefined),
    ]);
    await fixture.close();
  }
}

function summarizeFlow(flowId, raw, warmups) {
  const previous = summarizeFlowSamples(raw.previous.optimized, warmups);
  const candidate = {
    optimized: summarizeFlowSamples(raw.candidate.optimized, warmups),
    gateway: summarizeFlowSamples(raw.candidate.gateway, warmups),
  };
  const vscode = {
    individual: summarizeFlowSamples(raw.vscode.individual, warmups),
    batch: summarizeFlowSamples(raw.vscode.batch, warmups),
  };
  const allMeasured = [
    ...raw.previous.optimized,
    ...raw.candidate.optimized,
    ...raw.candidate.gateway,
    ...raw.vscode.individual,
    ...raw.vscode.batch,
  ].filter((sample) => sample.phase === "measured");
  return {
    id: flowId,
    previous: { optimized: previous, samples: raw.previous.optimized },
    candidate: {
      ...candidate,
      samples: {
        optimized: raw.candidate.optimized,
        gateway: raw.candidate.gateway,
      },
    },
    vscode: {
      ...vscode,
      samples: {
        individual: raw.vscode.individual,
        batch: raw.vscode.batch,
      },
    },
    safety: {
      incorrectPostconditions: allMeasured.filter((sample) => sample.failureKind === "postcondition").length,
      executionErrors: allMeasured.filter((sample) => sample.failureKind === "execution-error").length,
      duplicateMutations: flowId === "controlled-postback"
        ? allMeasured.filter((sample) => Number(sample?.observation?.postCount) > 1).length
        : 0,
    },
  };
}

async function captureSample(adapter, flowId, context) {
  const startedAt = performance.now();
  try {
    const sample = await adapter.run(flowId, context);
    return {
      ...sample,
      ...(sample.success === false && sample.failureKind === undefined
        ? { failureKind: "postcondition" }
        : {}),
      phase: context.phase,
      sample: context.sample,
      scheduleIndex: context.scheduleIndex,
      engineOrder: [...context.engineOrder],
      path: context.pathName,
    };
  } catch (error) {
    return {
      phase: context.phase,
      sample: context.sample,
      scheduleIndex: context.scheduleIndex,
      engineOrder: [...context.engineOrder],
      path: context.pathName,
      success: false,
      postcondition: false,
      failureKind: "execution-error",
      durationMs: round(performance.now() - startedAt),
      comparisonDurationMs: round(performance.now() - startedAt),
      requestBytes: 0,
      responseBytes: 0,
      toolCalls: 0,
      error: {
        name: error instanceof Error ? error.name : "Error",
        code: typeof error?.code === "string" ? error.code : "BENCHMARK_FLOW_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function renderMarkdown(report) {
  const lines = [
    "# Browser flow benchmark",
    "",
    `Captured: ${report.capturedAt}`,
    "",
    `Status: ${report.official ? "official" : "exploratory / non-official"}`,
    "",
  ];
  if (report.official) {
    lines.push(
      "## Official build provenance",
      "",
      `- Candidate: ${report.source.candidate.build.verification}, ${report.source.candidate.build.sha256}`,
      `- Previous: ${report.source.previous.build.verification}, ${report.source.previous.build.sha256}`,
      "",
    );
  }
  if (report.flows) {
    lines.push(
      "| Flow | Previous comparison p95 ms | Candidate comparison p95 ms | Gateway comparison p95 ms | VS Code individual comparison p95 ms | VS Code batch comparison p95 ms |",
      "|---|---:|---:|---:|---:|---:|",
    );
    for (const flowId of LOCAL_FLOW_IDS) {
      const flow = report.flows[flowId];
      lines.push(`| ${flowId} | ${flow.previous.optimized.comparisonLatencyMs.p95} | ${flow.candidate.optimized.comparisonLatencyMs.p95} | ${flow.candidate.gateway.comparisonLatencyMs.p95} | ${flow.vscode.individual.comparisonLatencyMs.p95} | ${flow.vscode.batch.comparisonLatencyMs.p95} |`);
    }
    lines.push(
      "",
      `- Local gate: ${report.gates.passed ? "passed" : "failed"}`,
      `- Extended 20% VS Code target: ${report.gates.extendedTargetPassed ? "passed" : "failed"}`,
      `- Candidate vs previous p95: ${report.gates.metrics.previousImprovementPercent}%`,
      `- Candidate vs best VS Code p95: ${report.gates.metrics.vscodeImprovementPercent}%`,
      `- Paired candidate vs previous p50: ${report.gates.metrics.pairedPreviousImprovementP50Percent}%`,
      `- Paired candidate vs best VS Code p50: ${report.gates.metrics.pairedVsCodeImprovementP50Percent}%`,
      `- Candidate success rate: ${report.gates.metrics.candidateSuccessRate}`,
      `- Gateway success rate: ${report.gates.metrics.gatewaySuccessRate}`,
      `- Paired coverage: ${report.gates.metrics.pairedComparisonSamples}/${report.gates.metrics.expectedPairedSamples}`,
      `- Tool-call reduction: ${report.gates.metrics.toolCallReductionPercent}%`,
      `- Gateway overhead gate metric: ${report.gates.metrics.gatewayOverheadMetric}`,
      `- Gateway-owned overhead p95: ${report.transport.gatewayOwnedOverheadPercent}%`,
      `- Paired incremental gateway boundary overhead p95: ${report.transport.gatewayOverheadPercent}%`,
      `- Gateway end-to-end delta p95: ${report.transport.endToEndDeltaPercent}%`,
      `- Direct worker boundary p95: ${report.transport.paired.directWorkerBoundaryMs.p95} ms`,
      `- Gateway total boundary p95: ${report.transport.paired.gatewayTotalBoundaryMs.p95} ms`,
      `- Incremental gateway boundary p95: ${report.transport.paired.incrementalGatewayBoundaryMs.p95} ms`,
      `- Gateway-owned boundary p95: ${report.transport.paired.gatewayOwnedBoundaryMs.p95} ms`,
      `- Gateway timing coverage min: ${report.transport.paired.gatewayTimingCoverage.min}`,
      `- Incremental Gateway per tool call p95: ${report.transport.paired.incrementalPerToolCallMs.p95} ms`,
      "",
    );
    const controlled = report.flows["controlled-postback"];
    if (controlled) {
      lines.push(
        "## Controlled postback protocol",
        "",
        `- Candidate protocol p95: ${controlled.candidate.optimized.protocolLatencyMs?.p95 ?? "n/a"} ms`,
        `- Candidate authorized execution p95: ${controlled.candidate.optimized.executionAfterConfirmationMs?.p95 ?? "n/a"} ms`,
        `- Gateway protocol p95: ${controlled.candidate.gateway.protocolLatencyMs?.p95 ?? "n/a"} ms`,
        `- VS Code confirmation challenge: not available; only authorized execution is compared`,
        "",
      );
    }
  }
  if (report.dev) {
    lines.push(
      "## LegacySite Dev",
      "",
      `Mode: ${report.dev.stability.mode}`,
      `Comparable runs: ${report.dev.stability.comparableRuns}`,
      "",
    );
  }
  lines.push(
    "## Safety",
    "",
    "- Model deliberation is excluded.",
    "- Production containers and protected tabs are not used.",
    "- Dev rows are represented only by count and SHA-256 signatures.",
    "- Failures remain in the report and are never silently retried.",
    "",
  );
  return lines.join("\n");
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--official") {
      values.official = true;
      continue;
    }
    if (argument === "--skip-vscode") {
      values.skipVsCode = true;
      continue;
    }
    if (argument === "--transport-only") {
      values.transportOnly = true;
      values.skipVsCode = true;
      continue;
    }
    if (argument === "--smoke") {
      values.warmups = 1;
      values.iterations = 3;
      continue;
    }
    const match = /^--([^=]+)=(.*)$/u.exec(argument);
    const key = match?.[1] ?? argument.replace(/^--/u, "");
    const value = match?.[2] ?? argv[index + 1];
    if (!match) index += 1;
    switch (key) {
      case "previous-root": values.previousRoot = value; break;
      case "candidate-root": values.candidateRoot = value; break;
      case "suite": values.suite = value; break;
      case "vscode-page-id": values.vscodePageId = value; break;
      case "vscode-runtime": values.vscodeRuntimePath = value; break;
      case "dev-config": values.devConfigPath = value; break;
      case "dev-auth-signal": values.devAuthSignalPath = value; break;
      case "dev-history": values.devHistoryDirectory = value; break;
      case "warmups": values.warmups = value; break;
      case "iterations": values.iterations = value; break;
      case "gateway-mode": values.gatewayMode = value; break;
      default: throw new Error(`Unknown argument: --${key}`);
    }
  }
  return values;
}

function parseSuite(value) {
  if (!["local", "dev", "all"].includes(value)) {
    throw new Error("suite must be local, dev or all.");
  }
  return value;
}

function parseGatewayMode(value) {
  if (!["docker", "process"].includes(value)) {
    throw new Error("gatewayMode must be docker or process.");
  }
  return value;
}

function required(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function positiveInteger(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function main() {
  const result = await runBrowserFlowBenchmarks(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    jsonPath: result.jsonPath,
    markdownPath: result.markdownPath,
    official: result.report.official,
    gates: result.report.gates ?? null,
    dev: result.report.dev?.stability ?? null,
  }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
