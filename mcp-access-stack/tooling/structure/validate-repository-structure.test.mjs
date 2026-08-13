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
