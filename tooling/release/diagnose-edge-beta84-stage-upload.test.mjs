import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  classifyUploadFailure, validateBridgeUploadConfig, classifyUploadLogFile,
} from "./diagnose-edge-beta84-stage-upload.mjs";

function canonical() {
  return {
    name: "mcp-access-stack", main: "src/index.ts", compatibility_date: "2026-08-17",
    workers_dev: true, secrets: { required: ["MCP_CONTRACT_PREPARE_TOKEN"] },
    vars: { MCP_EDGE_ENABLED: "true" },
    durable_objects: { bindings: [{ name: "MCP_SESSION", class_name: "McpSession" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["McpSession"] }],
  };
}
function bridge(original) {
  const p = "/repo/services/mcp-edge-gateway/.wrangler/inspection-bridge/";
  return { ...structuredClone(original), main: p + "index.ts",
    alias: { "./generated/mcp-tool-manifest.js": p + "mcp-tool-manifest.ts",
      "../generated/mcp-tool-manifest.js": p + "mcp-tool-manifest.ts" } };
}
test("static upload preflight accepts only the isolated generated manifest bridge", () => {
  assert.equal(validateBridgeUploadConfig(canonical(), bridge(canonical())), "CONFIG_PARITY_VERIFIED");
});
test("static upload preflight rejects drift in target, vars, token requirements, DO and migrations", () => {
  const orig = canonical();
  const bad = [
    { ...bridge(orig), name: "other-worker" },
    { ...bridge(orig), vars: { MCP_EDGE_ENABLED: "false" } },
    { ...bridge(orig), secrets: { required: [] } },
    { ...bridge(orig), durable_objects: { bindings: [] } },
    { ...bridge(orig), migrations: [] },
    { ...bridge(orig), compatibility_date: "2026-10-11" },
    { ...bridge(orig), routes: [{ pattern: "*", zone_id: "unsafe" }] },
    { ...bridge(orig), alias: { "other-module": "bad" } },
    { ...bridge(orig), main: "../different-worker.ts" },
    { ...bridge(orig), alias: {
      "./generated/mcp-tool-manifest.js": "/tmp/unsafe.ts",
      "../generated/mcp-tool-manifest.js": "/tmp/unsafe.ts",
    } },
  ];
  for (const b of bad) assert.throws(() => validateBridgeUploadConfig(orig, b),
    e => e.message === "EDGE_STAGE_UPLOAD_CONFIG_MISMATCH");
});
test("invalid or incomplete canonical configuration fails closed", () => {
  for (const bad of [null, {}, { ...canonical(), name: "wrong" },
    { ...canonical(), migrations: [] }, { ...canonical(), main: "other.ts" }]) {
    assert.throws(() => validateBridgeUploadConfig(bad, bridge(canonical())),
      e => e.message === "EDGE_STAGE_UPLOAD_CONFIG_MISMATCH");
  }
});
test("classifies upload stderr without returning raw logs or credentials", () => {
  const secret = "private-secret-with-token";
  const scenarios = [
    ["Authentication error: insufficient permissions", "authorization_or_scope"],
    ["HTTP 403 forbidden", "authorization_or_scope"],
    ["Error 429: rate limit exceeded", "rate_limited"],
    ["--strict: existing remote configuration differs", "remote_configuration_conflict"],
    ["Durable Objects migrations are not supported during version upload", "durable_object_migration"],
    ["Invalid configuration file", "configuration_invalid"],
    ["Could not resolve package foo", "missing_dependency"],
    ["connect ETIMEDOUT", "network_or_timeout"],
    ["Something unrecognized happened", "unknown"],
  ];
  for (const [msg, expected] of scenarios) {
    const v = classifyUploadFailure(msg + "\n" + secret);
    assert.equal(v, expected);
    assert.ok(!v.includes(secret));
  }
});
test("receipt markers cannot be mistaken for successful upload", () => {
  assert.equal(classifyUploadFailure("Worker Version ID: 11111111-2222-4333-8444-555555555555"),
    "receipt_marker_outcome_unknown");
});
test("missing or oversized upload logs emit fixed codes only", async () => {
  assert.equal(await classifyUploadLogFile("/does-not-exist/upload.log"), "log_unavailable");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(path.join(tmpdir(), "edge-upload-diagnostic-"));
  try {
    const file = path.join(dir, "upload.log");
    await writeFile(file, "some secret ".repeat(150000));
    assert.equal(await classifyUploadLogFile(file), "log_too_large");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("workflow retains CAS, Environment and exactly one upload, with gated preflight and sanitized failure diagnostics", async () => {
  const base = path.dirname(fileURLToPath(import.meta.url));
  const text = await readFile(path.resolve(base, "../../.github/workflows/edge-beta84-bridge-stage.yml"), "utf8");
  const doc = YAML.parseDocument(text, { uniqueKeys: true });
  assert.equal(doc.errors.length, 0);
  const yaml = doc.toJS();
  assert.equal(yaml.jobs.stage.environment, "public-release");
  assert.equal(yaml.concurrency.group, "public-release-edge");
  assert.equal(yaml.concurrency["cancel-in-progress"], false);
  assert.deepEqual(Object.keys(yaml.on.workflow_dispatch.inputs), [
    "expected_main_sha","expected_active_deployment_id","expected_active_version_id"
  ]);
  const steps = yaml.jobs.stage.steps;
  const dryRun = steps.findIndex(s => s.name === "Verify frozen beta.84 bridge bundle locally");
  const upload = steps.findIndex(s => s.id === "upload");
  const preflight = steps.findIndex(s => s.name === "Validate isolated upload configuration without network");
  assert.ok(dryRun >= 0 && dryRun < preflight && preflight < upload);
  assert.match(steps[preflight].run, /diagnose-edge-beta84-stage-upload\.mjs preflight/);
  assert.match(steps[upload].run, /wrangler versions upload --strict --keep-vars/);
  assert.match(steps[upload].run, /diagnose-edge-beta84-stage-upload\.mjs diagnose/);
  assert.equal((text.match(/npx wrangler versions upload/gu) ?? []).length, 1);
  assert.match(text, /stage-edge-beta84-bridge-guard\.mjs before/);
  assert.match(text, /stage-edge-beta84-bridge-guard\.mjs after/);
  assert.doesNotMatch(text, /wrangler (?:deploy|versions deploy|secret put)/);
  assert.doesNotMatch(text, /actions\/upload-artifact@/);
});
