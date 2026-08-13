import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const browserFastPathDefaults = Object.freeze({
  iterations: 10,
  warmupIterations: 3,
  flowIterations: 10,
  unitsPerRun: 10,
});

export function summarizeFastPathBenchmark(individualRuns, sequenceRuns, unitsPerRun) {
  const individualMedianMs = percentile(individualRuns, 0.5);
  const sequenceMedianMs = percentile(sequenceRuns, 0.5);
  const individualMsPerUnit = round(individualMedianMs / unitsPerRun, 3);
  const sequenceMsPerUnit = round(sequenceMedianMs / unitsPerRun, 3);
  return {
    iterations: Math.min(individualRuns.length, sequenceRuns.length),
    unitsPerRun,
    individual: {
      p50Ms: individualMedianMs,
      p95Ms: percentile(individualRuns, 0.95),
      p99Ms: percentile(individualRuns, 0.99),
      p50MsPerUnit: individualMsPerUnit,
      toolCallsPerFlow: unitsPerRun,
    },
    sequence: {
      p50Ms: sequenceMedianMs,
      p95Ms: percentile(sequenceRuns, 0.95),
      p99Ms: percentile(sequenceRuns, 0.99),
      p50MsPerUnit: sequenceMsPerUnit,
      toolCallsPerFlow: 1,
    },
    speedup: sequenceMedianMs === 0
      ? 0
      : round(individualMedianMs / sequenceMedianMs, 2),
    roundTripReductionPercent: round((1 - 1 / unitsPerRun) * 100, 2),
    toolCallsPerFlow: 1,
  };
}

export function summarizeOperationBenchmark(
  runs,
  responseBytes = [],
  warmupIterations = 0,
) {
  return {
    samples: runs.length,
    warmupIterations,
    p50Ms: percentile(runs, 0.5),
    p95Ms: percentile(runs, 0.95),
    p99Ms: percentile(runs, 0.99),
    responseBytes: {
      p50: percentile(responseBytes, 0.5),
      p95: percentile(responseBytes, 0.95),
      p99: percentile(responseBytes, 0.99),
    },
  };
}

export function evaluateBrowserPerformanceGates(candidate, references) {
  const actionP95 = Number(candidate?.actionState?.p95Ms);
  const currentP95 = Number(references?.current?.actionStateP95Ms);
  const vscodeP95 = Number(references?.vscode?.actionStateP95Ms);
  const candidateToolCalls = Number(candidate?.flows?.toolCallsPerFlow);
  const currentToolCalls = Number(references?.current?.toolCallsPerFlow);
  const checks = {
    vscodeParity: actionP95 <= vscodeP95,
    vscodeExtendedTarget: actionP95 <= vscodeP95 * 0.8,
    currentEngineImprovement: actionP95 <= currentP95 * 0.65,
    toolCallReduction:
      candidateToolCalls <= Math.max(1, currentToolCalls * 0.5),
    gatewayOverhead:
      Number(candidate?.gatewayOverheadPercent) <= 5,
    soakSuccessRate: Number(candidate?.soakSuccessRate) >= 1,
    duplicateMutations: Number(candidate?.duplicateMutations) === 0,
    crossTabBlocking: Number(candidate?.crossTabBlockingIncidents) === 0,
  };
  return {
    checks,
    passed:
      checks.vscodeParity &&
      checks.currentEngineImprovement &&
      checks.toolCallReduction &&
      checks.gatewayOverhead &&
      checks.soakSuccessRate &&
      checks.duplicateMutations &&
      checks.crossTabBlocking,
    extendedTargetPassed: checks.vscodeExtendedTarget,
  };
}

export async function runFastPathBenchmark(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const iterations = positiveInteger(options.iterations ?? browserFastPathDefaults.iterations, "iterations", 1_000);
  const warmupIterations = positiveInteger(
    options.warmupIterations ?? browserFastPathDefaults.warmupIterations,
    "warmupIterations",
    200,
  );
  const flowIterations = positiveInteger(
    options.flowIterations ?? browserFastPathDefaults.flowIterations,
    "flowIterations",
    200,
  );
  const unitsPerRun = positiveInteger(options.unitsPerRun ?? browserFastPathDefaults.unitsPerRun, "unitsPerRun", 20);
  const config = await readProductionConfig(cwd);
  const call = createBrowserWorkerClient(config);
  const benchmarkSite = await startBenchmarkSite();
  const individualRuns = [];
  const sequenceRuns = [];
  const actionStateRuns = [];
  const actionStateBytes = [];
  try {
    const opened = await call("open", {
      url: benchmarkSite.url,
      purpose: `browser-fast-path-benchmark-${Date.now()}`,
      reusable: false,
      protected: false,
      sticky: false,
    });
    const tabId = opened?.tab?.tabId;
    if (typeof tabId !== "string") throw new Error("Browser Worker returned no benchmark tab.");
    const initialSnapshot = await call("snapshot", { tabId, forceFull: true });
    const actionRef = initialSnapshot?.refs?.find((entry) => entry.name === "Increment")?.ref;
    if (typeof actionRef !== "string") {
      throw new Error("Browser Worker returned no benchmark action ref.");
    }
    let knownRevision = initialSnapshot?.state?.revision;
    for (let index = 0; index < warmupIterations; index += 1) {
      const warmed = await call("click", {
        tabId,
        ref: actionRef,
        ...(Number.isInteger(knownRevision) ? { knownRevision } : {}),
      });
      knownRevision = warmed?.state?.revision ?? knownRevision;
    }
    for (let index = 0; index < iterations; index += 1) {
      const startedAt = performance.now();
      const result = await call("click", {
        tabId,
        ref: actionRef,
        ...(Number.isInteger(knownRevision) ? { knownRevision } : {}),
      });
      actionStateRuns.push(elapsed(startedAt));
      actionStateBytes.push(Buffer.byteLength(JSON.stringify(result), "utf8"));
      if (!result?.state) {
        throw new Error("Browser action did not return updated state.");
      }
      knownRevision = result.state.revision;
    }

    await call("extract", { tabId, selector: "body", format: "text" });
    await call("sequence", {
      tabId,
      steps: [{ action: "extract", selector: "body", format: "text" }],
    });

    for (let index = 0; index < flowIterations; index += 1) {
      const individualStartedAt = performance.now();
      for (let unit = 0; unit < unitsPerRun; unit += 1) {
        await call("extract", { tabId, selector: "body", format: "text" });
      }
      individualRuns.push(elapsed(individualStartedAt));

      const sequenceStartedAt = performance.now();
      await call("sequence", {
        tabId,
        steps: Array.from({ length: unitsPerRun }, () => ({
          action: "extract",
          selector: "body",
          format: "text",
        })),
      });
      sequenceRuns.push(elapsed(sequenceStartedAt));
    }
  } finally {
    await call("finishTask", {}).catch(() => undefined);
    await benchmarkSite.close();
  }

  return {
    actionState: summarizeOperationBenchmark(
      actionStateRuns,
      actionStateBytes,
      warmupIterations,
    ),
    flows: summarizeFastPathBenchmark(
      individualRuns,
      sequenceRuns,
      unitsPerRun,
    ),
  };
}

export async function startBenchmarkSite() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("<!doctype html><html><head><title>Browser fast path benchmark</title></head><body><main><button onclick=\"document.querySelector('output').value=String(Number(document.querySelector('output').value)+1)\">Increment</button><output>0</output><p>benchmark-ready</p></main></body></html>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("Benchmark site did not bind to a local port.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/benchmark`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function readProductionConfig(cwd) {
  const configPath = path.join(cwd, ".runtime-private", "gpt-only-production.json");
  const config = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/u, ""));
  const port = Number(config?.ports?.browser);
  const token = config?.browser?.token;
  if (!Number.isInteger(port) || port <= 0 || typeof token !== "string" || token.length < 32) {
    throw new Error("Production Browser Worker configuration is incomplete.");
  }
  return { port, token };
}

export function createBrowserWorkerClient({ port, token }) {
  return (operation, input) => new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ operation, input }), "utf8");
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/operations",
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(payload.length),
        "x-mcp-call-id": `benchmark-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      },
      timeout: 120_000,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => body += chunk);
      response.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return reject(new Error(`Browser Worker returned invalid JSON for ${operation}.`));
        }
        if (response.statusCode !== 200 || parsed?.ok !== true) {
          return reject(new Error(
            `Browser Worker ${operation} failed: ${parsed?.error?.code ?? response.statusCode}.`,
          ));
        }
        resolve(parsed.result);
      });
    });
    request.on("timeout", () => request.destroy(new Error(`${operation} timed out.`)));
    request.on("error", reject);
    request.end(payload);
  });
}

function positiveInteger(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return round(sorted[index], 3);
}

function elapsed(startedAt) {
  return round(performance.now() - startedAt, 3);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function main() {
  const result = await runFastPathBenchmark({
    iterations: process.argv[2] ?? browserFastPathDefaults.iterations,
    unitsPerRun: process.argv[3] ?? browserFastPathDefaults.unitsPerRun,
    warmupIterations: process.argv[4] ?? browserFastPathDefaults.warmupIterations,
    flowIterations: process.argv[5] ?? browserFastPathDefaults.flowIterations,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
