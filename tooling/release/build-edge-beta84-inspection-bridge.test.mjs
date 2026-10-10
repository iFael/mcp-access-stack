import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BETA84_MANIFEST_BLOB,
  BETA84_REVISION,
  MAIN_AT_GATE_REVISION,
  extractRevision,
  makeBridgeConfig,
  prepareBridge,
  verifyFrozenManifest,
} from "./build-edge-beta84-inspection-bridge.mjs";

const historicalSource = "// GENERATED FILE. DO NOT EDIT.\n" +
  "export const EDGE_MCP_CATALOG_METADATA = {\n" +
  '  "contractRevision": "' + BETA84_REVISION + '"\n};\n';

function canonical() {
  return {
    name: "mcp-access-stack",
    main: "src/index.ts",
    secrets: { required: ["MCP_CONTRACT_PREPARE_TOKEN"] },
    durable_objects: { bindings: [{ name: "MCP_SESSION", class_name: "McpSession" }] },
    vars: { MCP_EDGE_ENABLED: "true" },
  };
}

test("rejects missing, malformed or drifted historical revisions", () => {
  assert.equal(extractRevision(historicalSource), BETA84_REVISION);
  assert.throws(() => extractRevision("no revision"), /exact contract revision/);
  assert.throws(() => verifyFrozenManifest(historicalSource, "wrong"), /mismatch/);
  assert.throws(() => verifyFrozenManifest(historicalSource.replace(BETA84_REVISION, MAIN_AT_GATE_REVISION), BETA84_MANIFEST_BLOB), /mismatch/);
  assert.equal(verifyFrozenManifest(historicalSource, BETA84_MANIFEST_BLOB), BETA84_REVISION);
});

test("isolates both generated imports while leaving the canonical Worker config unchanged", () => {
  const base = canonical();
  const pristine = structuredClone(base);
  const root = resolve("/tmp", "canonical-bridge-test");
  const file = join(root, "worker", "manifest.ts");
  const selected = makeBridgeConfig(base, root, file);
  assert.deepEqual(base, pristine);
  assert.equal(selected.name, "mcp-access-stack");
  assert.equal(selected.main, join(root, "services/mcp-edge-gateway/src/index.ts"));
  assert.equal(selected.alias["./generated/mcp-tool-manifest.js"], file);
  assert.equal(selected.alias["../generated/mcp-tool-manifest.js"], file);
  assert.deepEqual(selected.durable_objects, base.durable_objects);
  assert.deepEqual(selected.secrets, base.secrets);
  assert.throws(() => makeBridgeConfig({ ...base, name: "another-worker" }, root, file), /drift/);
  assert.throws(() => makeBridgeConfig({ ...base, alias: {} }, root, file), /drift/);
  assert.throws(() => makeBridgeConfig({ ...base, durable_objects: { bindings: [] } }, root, file), /drift/);
  assert.throws(() => makeBridgeConfig({ ...base, secrets: { required: [] } }, root, file), /drift/);
});

test("materializes only ignored bridge artifacts and preserves the committed manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "edge-bridge-test-"));
  try {
    const edge = join(root, "services/mcp-edge-gateway");
    const generated = join(edge, "src/generated");
    await mkdir(generated, { recursive: true });
    await writeFile(join(edge, "wrangler.jsonc"), JSON.stringify(canonical()));
    const mainManifest = "// GENERATED FILE. DO NOT EDIT.\n" +
      '{"contractRevision": "' + MAIN_AT_GATE_REVISION + '"}\n';
    await writeFile(join(generated, "mcp-tool-manifest.ts"), mainManifest);
    const paths = await prepareBridge({
      root, readHistorical: (ref, path) => {
        assert.match(ref, /^[0-9a-f]{40}$/);
        assert.equal(path, "services/mcp-edge-gateway/src/generated/mcp-tool-manifest.ts");
        return historicalSource;
      }, hashHistorical: () => BETA84_MANIFEST_BLOB,
    });
    assert.equal(paths.revision, BETA84_REVISION);
    assert.equal(await readFile(join(generated, "mcp-tool-manifest.ts"), "utf8"), mainManifest);
    assert.equal(await readFile(join(paths.staging, "mcp-tool-manifest.ts"), "utf8"), historicalSource);
    const bridge = JSON.parse(await readFile(paths.configPath, "utf8"));
    assert.equal(bridge.alias["./generated/mcp-tool-manifest.js"], join(paths.staging, "mcp-tool-manifest.ts"));
    await writeFile(join(generated, "mcp-tool-manifest.ts"), mainManifest.replace(MAIN_AT_GATE_REVISION, BETA84_REVISION));
    await assert.rejects(() => prepareBridge({
      root, readHistorical: () => historicalSource, hashHistorical: () => BETA84_MANIFEST_BLOB,
    }), /Canonical manifest changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
