import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveBrowserAuditPath, summarizeBrowserAudit } from "./report-browser-reliability.mjs";

test("summarizes browser reliability without exposing operation payloads", () => {
  const summary = summarizeBrowserAudit([
    JSON.stringify({ operation: "connect", status: "allowed", durationMs: 100, queueWaitMs: 4 }),
    JSON.stringify({ operation: "connect", status: "error", reason: "BROWSER_DISCONNECTED", durationMs: 300, queueWaitMs: 8 }),
    JSON.stringify({ operation: "snapshot", status: "allowed", durationMs: 50, queueWaitMs: 1 }),
    JSON.stringify({ operation: "sequence", status: "allowed", durationMs: 90, queueWaitMs: 2, operationUnits: 3 }),
    "not-json",
  ]);

  assert.equal(summary.entries, 4);
  assert.equal(summary.malformedLines, 1);
  assert.equal(summary.allowed, 3);
  assert.equal(summary.errors, 1);
  assert.equal(summary.errorRatePercent, 25);
  assert.deepEqual(summary.reasons, [
    { reason: "BROWSER_DISCONNECTED", count: 1 },
  ]);
  assert.deepEqual(summary.operations[0], {
    operation: "connect",
    count: 2,
    allowed: 1,
    errors: 1,
    denied: 0,
    p50Ms: 100,
    p95Ms: 300,
    maxMs: 300,
    queueP95Ms: 8,
    operationUnits: 2,
    p50MsPerUnit: 100,
    p95MsPerUnit: 300,
  });
  assert.deepEqual(
    summary.operations.find((operation) => operation.operation === "sequence"),
    {
      operation: "sequence",
      count: 1,
      allowed: 1,
      errors: 0,
      denied: 0,
      p50Ms: 90,
      p95Ms: 90,
      maxMs: 90,
      queueP95Ms: 2,
      operationUnits: 3,
      p50MsPerUnit: 30,
      p95MsPerUnit: 30,
    },
  );
});


test("resolves the Browser Worker audit log from the canonical runtime directory", async () => {
  const root = path.join("tmp", "browser-reliability-report");
  const runtimeDirectory = "production-browser-runtime";
  assert.equal(
    await resolveBrowserAuditPath(undefined, root, {
      BROWSER_WORKER_RUNTIME_DIR: runtimeDirectory,
    }),
    path.resolve(root, runtimeDirectory, "browser-audit.ndjson"),
  );
  assert.equal(
    await resolveBrowserAuditPath(undefined, root, {}),
    path.join(root, "runtime", "browser", "browser-audit.ndjson"),
  );
  assert.equal(
    await resolveBrowserAuditPath("explicit.ndjson", root, {}),
    "explicit.ndjson",
  );
});
