import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const segments = [
  ["mcp-core", "tsconfig.typecheck.mcp-core.json"],
  ["edge-protocol", "tsconfig.typecheck.edge-protocol.json"],
  ["browser-worker", "tsconfig.typecheck.browser-worker.json"],
  ["workspace-agent", "tsconfig.typecheck.workspace-agent.json"],
  ["oracle-release-orchestrator", "tsconfig.typecheck.oracle-release-orchestrator.json"],
  ["update-control", "tsconfig.typecheck.update-control.json"],
  ["mcp-gateway", "tsconfig.typecheck.mcp-gateway.json"],
  ["tooling", "tsconfig.typecheck.tooling.json"],
];

// Keep constrained local execution serial. Hosted CI may explicitly opt in
// to two independent noEmit compiler processes, never an unbounded worker pool.
const jobs = process.env.MCP_TYPECHECK_JOBS ?? "1";
if (jobs !== "1" && jobs !== "2") {
  throw new Error("MCP_TYPECHECK_JOBS must be 1 or 2.");
}
const concurrency = Number(jobs);
await verifyCoverage();

for (let offset = 0; offset < segments.length; offset += concurrency) {
  const outcomes = await Promise.allSettled(
    segments.slice(offset, offset + concurrency).map(async ([name, configPath]) => {
      process.stdout.write(`[typecheck] ${name}\n`);
      const started = performance.now();
      await runTypeScript(configPath);
      process.stdout.write(`[typecheck] ${name} passed (${Math.round(performance.now() - started)} ms)\n`);
    }),
  );
  // Drain the entire bounded batch before failing; never leave a sibling
  // compiler process running after a failed segment.
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed) throw failed.reason;
}

process.stdout.write("[typecheck] all segments passed\n");

async function verifyCoverage() {
  const rootConfig = await readJson("tsconfig.json");
  const expected = normalizeIncludes(rootConfig.include);

  const actual = [];
  for (const [, configPath] of segments) {
    const config = await readJson(configPath);
    if (config.extends !== "./tsconfig.json") {
      throw new Error(
        `${configPath} must extend ./tsconfig.json to preserve compiler options.`,
      );
    }
    actual.push(...normalizeIncludes(config.include));
  }

  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((entry) => !actualSet.has(entry));
  const extra = actual.filter((entry) => !expectedSet.has(entry));
  const duplicates = actual.filter(
    (entry, index) => actual.indexOf(entry) !== index,
  );

  if (missing.length || extra.length || duplicates.length) {
    throw new Error(
      [
        "Segmented typecheck coverage no longer matches tsconfig.json.",
        missing.length ? `Missing: ${missing.join(", ")}` : "",
        extra.length ? `Extra: ${extra.join(", ")}` : "",
        duplicates.length
          ? `Duplicated: ${[...new Set(duplicates)].join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function normalizeIncludes(value) {
  if (!Array.isArray(value)) {
    throw new Error("Every typecheck config must declare an include array.");
  }
  return value.map((entry) => String(entry).replaceAll("\\", "/"));
}

function runTypeScript(configPath) {
  const tscPath = path.resolve("node_modules", "typescript", "bin", "tsc");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tscPath, "--noEmit", "-p", configPath],
      {
        stdio: "inherit",
        env: process.env,
      },
    );

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(
          new Error(
            `Typecheck segment ${configPath} terminated by signal ${signal}.`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Typecheck segment ${configPath} exited with code ${code}.`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}
