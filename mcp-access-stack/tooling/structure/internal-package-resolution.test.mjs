import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
}

async function collectFiles(root, predicate) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath, predicate));
    } else if (predicate(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

test("uses one canonical source-resolution contract for internal packages", async () => {
  const tsconfig = await readJson("tsconfig.json");
  assert.deepEqual(tsconfig.compilerOptions.paths, {
    "@vs-code-gpt/shared": ["./packages/mcp-core/src/index.ts"],
    "@vs-code-gpt/local-agent": ["./services/workspace-agent/src/index.ts"],
    "@mcp-access-stack/edge-protocol": ["./packages/edge-protocol/src/index.ts"],
  });

  const preset = await readFile(path.join(repoRoot, "jest.preset.ts"), "utf8");
  assert.match(preset, /pathsToModuleNameMapper/u);
  assert.doesNotMatch(preset, /sharedSourceUrl/u);

  for (const relativePath of [
    "packages/mcp-core/jest.config.ts",
    "services/browser-worker/jest.config.ts",
    "services/mcp-edge-gateway/jest.config.ts",
    "services/mcp-gateway/jest.config.ts",
    "services/workspace-agent/jest.config.ts",
  ]) {
    const config = await readFile(path.join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(config, /sharedSourceUrl/u, `${relativePath} must rely on the shared preset mapping`);
  }
});

test("removes edge-protocol source escape hatches and test prebuild coupling", async () => {
  const rootPackage = await readJson("package.json");
  const edgeProtocolPackage = await readJson("packages/edge-protocol/package.json");

  assert.equal(edgeProtocolPackage.exports["./source"], undefined);
  assert.equal(rootPackage.scripts["pretest:mcp-gateway"], undefined);
  assert.match(rootPackage.scripts["test:typescript"], /test:mcp-edge-gateway/u);
  assert.match(rootPackage.scripts["ci:main:edge"], /test:mcp-edge-gateway/u);

  const edgeFiles = await collectFiles(
    path.join(repoRoot, "services", "mcp-edge-gateway"),
    (file) => /\.(?:ts|json)$/u.test(file),
  );
  for (const file of edgeFiles) {
    const content = await readFile(file, "utf8");
    assert.doesNotMatch(
      content,
      /@mcp-access-stack\/edge-protocol\/source/u,
      `${path.relative(repoRoot, file)} still uses the obsolete /source subpath`,
    );
  }
});

test("keeps edge gateway tests in the official Jest and CI surfaces", async () => {
  const rootPackage = await readJson("package.json");
  const edgePackage = await readJson("services/mcp-edge-gateway/package.json");
  const rootJest = await readFile(path.join(repoRoot, "jest.config.ts"), "utf8");

  assert.equal(typeof edgePackage.scripts.test, "string");
  assert.equal(typeof rootPackage.scripts["test:mcp-edge-gateway"], "string");
  assert.match(rootJest, /services\/mcp-edge-gateway\/jest\.config\.ts/u);
});

test("uses one worktree-safe Jest runner instead of hardcoded node_modules paths", async () => {
  const packageFiles = [
    "package.json",
    "packages/mcp-core/package.json",
    "services/browser-worker/package.json",
    "services/mcp-edge-gateway/package.json",
    "services/mcp-gateway/package.json",
    "services/workspace-agent/package.json",
  ];

  for (const relativePath of packageFiles) {
    const packageJson = await readJson(relativePath);
    for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
      assert.doesNotMatch(
        command,
        /node_modules\/jest\/bin\/jest\.js/u,
        `${relativePath}#${name} must use the shared Jest runner`,
      );
    }
  }

  const runner = await readFile(path.join(repoRoot, "tooling/testing/run-jest.mjs"), "utf8");
  assert.match(runner, /createRequire/u);
  assert.match(runner, /jest\/package\.json/u);
  assert.match(runner, /"bin", "jest\.js"/u);
});
