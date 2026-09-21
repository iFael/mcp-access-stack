import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
const exists = (relativePath) => existsSync(path.join(root, relativePath));

test("retires Docker/V2 deployment surfaces from the current repository", () => {
  for (const relativePath of [
    ".dockerignore",
    "deploy/docker",
    "deploy/remote",
  ]) {
    assert.equal(exists(relativePath), false, `${relativePath} must be retired`);
  }
});

test("removes Docker-specific repository automation and runtime defaults", () => {
  const dependabot = readFileSync(path.join(root, ".github/dependabot.yml"), "utf8");
  assert.equal(dependabot.includes("package-ecosystem: docker"), false);
  assert.equal(dependabot.includes("deploy/docker"), false);

  const benchmark = readFileSync(path.join(root, "tooling/benchmarks/browser/browser-benchmark-runtime.mjs"), "utf8");
  for (const token of ["deploy/docker/gateway.Dockerfile", "startIsolatedDockerGateway", "startDockerHostRelay", 'mode ?? "docker"']) {
    assert.equal(benchmark.includes(token), false, `benchmark still contains Docker runtime token: ${token}`);
  }

  const productionConfig = readJson("config/gpt-only-production.example.json");
  assert.equal(Object.hasOwn(productionConfig, "tunnel"), false, "production example still exposes retired tunnel configuration");
});

test("removes Docker-named npm entrypoints and deploy/docker references", () => {
  const packageJson = readJson("package.json");
  assert.deepEqual(Object.keys(packageJson.scripts).filter((name) => name.startsWith("docker:")), []);
  assert.equal(JSON.stringify(packageJson).includes("deploy/docker"), false);
});

test("keeps npm scripts free of references to deleted repository files", () => {
  const packageJson = readJson("package.json");
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    for (const match of command.matchAll(/(?:^|\s)([A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|ps1))(?:\s|$)/gu)) {
      const relativePath = match[1];
      if (relativePath.includes("node_modules/") || relativePath.includes("/dist/")) continue;
      assert.equal(exists(relativePath), true, `${name} references missing repository file: ${relativePath}`);
    }
  }
});
