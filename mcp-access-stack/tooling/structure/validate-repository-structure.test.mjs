import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateServiceBoundaries } from "./validate-repository-structure.mjs";

test("rejects production imports that reach another service internal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-structure-boundary-"));
  try {
    await mkdir(path.join(root, "services", "alpha", "src"), { recursive: true });
    await mkdir(path.join(root, "services", "beta", "src"), { recursive: true });
    await writeFile(
      path.join(root, "services", "alpha", "src", "index.ts"),
      'import { internal } from "../../beta/src/internal.js";\nvoid internal;\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "services", "beta", "src", "internal.ts"),
      "export const internal = true;\n",
      "utf8",
    );

    const issues = [];
    validateServiceBoundaries(root, issues);

    assert.deepEqual(issues, [
      "services/alpha/src/index.ts imports another service internal: ../../beta/src/internal.js",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows relative imports that stay inside the current service", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-structure-local-"));
  try {
    await mkdir(path.join(root, "services", "alpha", "src"), { recursive: true });
    await writeFile(
      path.join(root, "services", "alpha", "src", "index.ts"),
      'import { local } from "./local.js";\nvoid local;\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "services", "alpha", "src", "local.ts"),
      "export const local = true;\n",
      "utf8",
    );

    const issues = [];
    validateServiceBoundaries(root, issues);

    assert.deepEqual(issues, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolates TypeScript test workspaces and serializes Browser Worker", async () => {
  const rootPackage = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const browserPackage = JSON.parse(
    await readFile(
      new URL("../../services/browser-worker/package.json", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(
    rootPackage.scripts["test:typescript"],
    "npm run test:browser-worker && npm run test:mcp-core && npm run test:mcp-gateway && npm run test:workspace-agent",
  );
  assert.match(browserPackage.scripts.test, /(?:^|\s)--runInBand(?:\s|$)/u);
  assert.doesNotMatch(
    rootPackage.scripts["test:typescript"],
    /node_modules\/jest\/bin\/jest\.js/u,
  );
});

test("keeps authoritative development and build surfaces on Node 26", async () => {
  const rootPackage = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(rootPackage.engines.node, ">=26");
  assert.match(rootPackage.devDependencies["@types/node"], /^\^26\./u);

  for (const workflowPath of [
    "../../../.github/workflows/ci.yml",
    "../../../.github/workflows/release.yml",
  ]) {
    const workflow = await readFile(new URL(workflowPath, import.meta.url), "utf8");
    const majors = [...workflow.matchAll(/node-version:\s*["']?(\d+)/gu)].map((match) => match[1]);
    assert.ok(majors.length > 0, `${workflowPath} must configure Node.js`);
    assert.deepEqual([...new Set(majors)], ["26"]);
  }

  const expectedDockerBase =
    "26.8.1-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e";
  for (const dockerfilePath of [
    "../../deploy/docker/gateway.Dockerfile",
    "../../deploy/docker/proxy.Dockerfile",
    "../../deploy/remote/browser-worker.Dockerfile",
  ]) {
    const dockerfile = await readFile(new URL(dockerfilePath, import.meta.url), "utf8");
    const bases = [...dockerfile.matchAll(/^FROM node:(\S+)/gmu)].map((match) => match[1]);
    assert.ok(bases.length > 0, `${dockerfilePath} must use an official Node.js base image`);
    assert.deepEqual([...new Set(bases)], [expectedDockerBase]);
  }

  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
  assert.match(readme, /Node\.js 26 ou superior/u);
});
