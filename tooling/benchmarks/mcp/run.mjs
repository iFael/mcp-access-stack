import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpBenchmarkClient, sanitizeRoute } from "./mcp-client.mjs";
import { writeReports } from "./reporter.mjs";

export function validateBenchmarkConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Benchmark config must be an object.");
  }
  const routes = Array.isArray(value.routes) ? value.routes : [];
  const scenarios = Array.isArray(value.scenarios) ? value.scenarios : [];
  if (routes.length === 0) throw new Error("At least one benchmark route is required.");
  if (scenarios.length === 0) throw new Error("At least one benchmark scenario is required.");
  return {
    warmups: positiveInteger(value.warmups ?? 3, "warmups", 20),
    samples: positiveInteger(value.samples ?? 10, "samples", 100),
    outputDirectory: typeof value.outputDirectory === "string" && value.outputDirectory
      ? value.outputDirectory
      : "runtime/benchmarks/mcp",
    routes: routes.map((route, index) => validateRoute(route, index)),
    scenarios: scenarios.map((scenario, index) => validateScenario(scenario, index)),
  };
}

export async function runMcpBenchmark(config, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const runId = new Date().toISOString().replace(/[:.]/gu, "-");
  const outputDirectory = path.resolve(cwd, config.outputDirectory, runId);
  const samples = [];

  for (const route of config.routes) {
    const client = new McpBenchmarkClient(route);
    try {
      for (const scenario of config.scenarios.filter((entry) => entry.enabled)) {
        for (let index = 0; index < config.warmups; index += 1) {
          await executeScenario(client, scenario);
        }
        for (let index = 0; index < config.samples; index += 1) {
          const startedAt = performance.now();
          try {
            await executeScenario(client, scenario);
            samples.push(sample(route, scenario, "ok", performance.now() - startedAt));
          } catch (error) {
            samples.push(sample(
              route,
              scenario,
              "error",
              performance.now() - startedAt,
              error instanceof Error ? error.name : "Error",
            ));
          }
        }
      }
    } finally {
      await client.close();
    }
  }

  return writeReports(outputDirectory, samples, {
    generatedAt: new Date().toISOString(),
    routes: config.routes.map(sanitizeRoute),
    warmups: config.warmups,
    samples: config.samples,
  });
}

async function executeScenario(client, scenario) {
  if (scenario.tool === "tools/list") return client.listTools();
  return client.callTool(scenario.tool, scenario.args);
}

function sample(route, scenario, status, durationMs, errorName) {
  return {
    route: route.name,
    tool: scenario.tool,
    scenario: scenario.name,
    cold: false,
    concurrency: 1,
    status,
    durationMs: Math.round(durationMs * 1000) / 1000,
    ...(errorName === undefined ? {} : { errorName }),
  };
}

function validateRoute(route, index) {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    throw new Error(`routes[${index}] must be an object.`);
  }
  if (typeof route.name !== "string" || !route.name) {
    throw new Error(`routes[${index}].name is required.`);
  }
  if (typeof route.url !== "string") throw new Error(`routes[${index}].url is required.`);
  new URL(route.url);
  const token = typeof route.tokenEnv === "string" && route.tokenEnv
    ? process.env[route.tokenEnv]
    : undefined;
  if (route.tokenEnv && !token) {
    throw new Error(`Environment variable ${route.tokenEnv} is required.`);
  }
  return { name: route.name, url: route.url, ...(token ? { token } : {}) };
}

function validateScenario(scenario, index) {
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
    throw new Error(`scenarios[${index}] must be an object.`);
  }
  if (typeof scenario.name !== "string" || !scenario.name) {
    throw new Error(`scenarios[${index}].name is required.`);
  }
  if (typeof scenario.tool !== "string" || !scenario.tool) {
    throw new Error(`scenarios[${index}].tool is required.`);
  }
  return {
    name: scenario.name,
    tool: scenario.tool,
    enabled: scenario.enabled !== false,
    args: scenario.args && typeof scenario.args === "object" && !Array.isArray(scenario.args)
      ? scenario.args
      : {},
  };
}

function positiveInteger(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}.`);
  }
  return parsed;
}

async function main() {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
  if (!configPath) throw new Error("Usage: npm run bench:mcp -- --config <private-config.json>");
  const config = validateBenchmarkConfig(
    JSON.parse((await readFile(path.resolve(configPath), "utf8")).replace(/^\uFEFF/u, "")),
  );
  const result = await runMcpBenchmark(config);
  process.stdout.write(`${JSON.stringify({ outputDirectory: result.outputDirectory }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
