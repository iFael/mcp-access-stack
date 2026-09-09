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

test("keeps edge-gateway-only PRs on the edge-specific typecheck", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const expected = `      - name: Typecheck affected graph
        if: >-
          github.event_name == 'pull_request' &&
          (needs.impact.result != 'success' ||
           needs.impact.outputs.shared == 'true' ||
           needs.impact.outputs.edgeProtocol == 'true' ||
           needs.impact.outputs.workspaceAgent == 'true' ||
           needs.impact.outputs.mcpGateway == 'true' ||
           needs.impact.outputs.browserWorker == 'true' ||
           needs.impact.outputs.rootBroad == 'true')
        run: npm run typecheck`;
  assert.ok(
    workflow.replaceAll("\r\n", "\n").includes(expected),
    "global typecheck must skip edge-gateway-only changes so Check Edge Gateway owns that scope",
  );
});

test("keeps main integration sharded instead of one monolithic timeout", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const normalized = workflow.replaceAll("\r\n", "\n");
  assert.doesNotMatch(
    normalized,
    /^\s*run: npm run ci:main\s*$/mu,
    "main push must not serialize the full integration graph behind one timeout",
  );
  const expectedMatrix = `    strategy:
      fail-fast: false
      matrix:
        target:
          - core
          - node
          - workspace-agent
          - gateway
          - edge`;
  assert.ok(
    normalized.includes(expectedMatrix),
    "main integration must keep independent core, node, workspace-agent, gateway and edge shards",
  );
  assert.match(
    normalized,
    /run: npm run ci:main:\$\{\{ matrix\.target \}\}/u,
    "each main integration shard must execute its dedicated package script",
  );
});

test("provisions Playwright Chromium for the main node shard", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const normalized = workflow.replaceAll("\r\n", "\n");
  const mainIntegrationStart = normalized.indexOf("  main-integration:");
  const mainBrowserStart = normalized.indexOf("\n  main-browser:", mainIntegrationStart);
  assert.ok(
    mainIntegrationStart >= 0 && mainBrowserStart > mainIntegrationStart,
    "main integration job must be present before the browser job",
  );
  const mainIntegration = normalized.slice(mainIntegrationStart, mainBrowserStart);
  assert.match(
    mainIntegration,
    /- name: Install Playwright Chromium for node shard\s+if: matrix\.target == 'node'\s+run: npx playwright install chromium/u,
    "main-node runs Playwright-backed fixture tests and must provision Chromium",
  );
});

test("parallelizes expensive PR validation lanes behind the canonical check", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const normalized = workflow.replaceAll("\r\n", "\n");
  const validationStart = normalized.indexOf("  pr-validation:");
  const browserStart = normalized.indexOf("\n  pr-browser-worker:", validationStart);
  const workspaceAgentStart = normalized.indexOf("\n  pr-workspace-agent:", browserStart);
  const runtimeStart = normalized.indexOf("\n  pr-runtime-assurance:", workspaceAgentStart);
  const checkStart = normalized.indexOf("\n  check:", runtimeStart);
  const mainStart = normalized.indexOf("\n  main-integration:", checkStart);

  assert.ok(
    validationStart >= 0 &&
      browserStart > validationStart &&
      workspaceAgentStart > browserStart &&
      runtimeStart > workspaceAgentStart &&
      checkStart > runtimeStart &&
      mainStart > checkStart,
    "PR validation lanes must run before the canonical check aggregator and main integration",
  );

  const validation = normalized.slice(validationStart, browserStart);
  assert.doesNotMatch(validation, /- name: Install Playwright Chromium/u);
  assert.doesNotMatch(validation, /- name: Test Browser Worker/u);
  assert.doesNotMatch(validation, /- name: Build Browser Worker/u);
  assert.doesNotMatch(validation, /- name: Test Workspace Agent/u);
  assert.doesNotMatch(validation, /- name: Validate Windows and release runtime assurance/u);

  const browser = normalized.slice(browserStart, workspaceAgentStart);
  assert.match(browser, /needs: impact/u);
  assert.match(browser, /needs\.impact\.outputs\.browserWorker/u);
  assert.match(browser, /- name: Install Playwright Chromium/u);
  assert.match(browser, /run: npx playwright install --only-shell chromium/u);
  assert.match(browser, /- name: Test Browser Worker/u);
  assert.match(browser, /run: npm run test:browser-worker/u);
  assert.match(browser, /- name: Build Browser Worker/u);
  assert.match(browser, /run: npm run build --workspace @vs-code-gpt\/browser-worker/u);

  const workspaceAgent = normalized.slice(workspaceAgentStart, runtimeStart);
  assert.match(workspaceAgent, /needs: impact/u);
  assert.match(workspaceAgent, /- name: Test Workspace Agent/u);
  assert.match(workspaceAgent, /run: npm run test:workspace-agent/u);

  const runtime = normalized.slice(runtimeStart, checkStart);
  assert.match(runtime, /needs: impact/u);
  assert.match(runtime, /- name: Validate Windows and release runtime assurance/u);
  assert.match(runtime, /run: npm run check:runtime-assurance/u);

  const check = normalized.slice(checkStart, mainStart);
  assert.match(check, /- pr-validation/u);
  assert.match(check, /- pr-browser-worker/u);
  assert.match(check, /- pr-workspace-agent/u);
  assert.match(check, /- pr-runtime-assurance/u);
  assert.match(check, /needs\.pr-validation\.result/u);
  assert.match(check, /needs\.pr-browser-worker\.result/u);
  assert.match(check, /needs\.pr-workspace-agent\.result/u);
  assert.match(check, /needs\.pr-runtime-assurance\.result/u);
});
test("parallelizes independent ci release image builds behind the canonical result", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const normalized = workflow.replaceAll("\r\n", "\n");
  const gatewayStart = normalized.indexOf("  release-image-gateway:");
  const browserStart = normalized.indexOf("\n  release-image-browser:", gatewayStart);
  const proxyStart = normalized.indexOf("\n  release-image-proxy:", browserStart);
  const aggregateStart = normalized.indexOf("\n  release-images:", proxyStart);

  assert.ok(
    gatewayStart >= 0 && browserStart > gatewayStart && proxyStart > browserStart && aggregateStart > proxyStart,
    "gateway, browser and proxy image builds must precede the canonical release-images aggregator",
  );

  const gateway = normalized.slice(gatewayStart, browserStart);
  assert.match(gateway, /needs\.impact\.outputs\.dockerGateway/u);
  assert.match(gateway, /deploy\/docker\/gateway\.Dockerfile/u);
  assert.doesNotMatch(gateway, /browser-worker\.Dockerfile|proxy\.Dockerfile/u);

  const browser = normalized.slice(browserStart, proxyStart);
  assert.match(browser, /needs\.impact\.outputs\.dockerBrowser/u);
  assert.match(browser, /deploy\/remote\/browser-worker\.Dockerfile/u);
  assert.doesNotMatch(browser, /gateway\.Dockerfile|proxy\.Dockerfile/u);

  const proxy = normalized.slice(proxyStart, aggregateStart);
  assert.match(proxy, /needs\.impact\.outputs\.dockerProxy/u);
  assert.match(proxy, /deploy\/docker\/proxy\.Dockerfile/u);
  assert.doesNotMatch(proxy, /gateway\.Dockerfile|browser-worker\.Dockerfile/u);

  const aggregate = normalized.slice(aggregateStart);
  assert.match(aggregate, /- release-image-gateway/u);
  assert.match(aggregate, /- release-image-browser/u);
  assert.match(aggregate, /- release-image-proxy/u);
  assert.match(aggregate, /needs\.release-image-gateway\.result/u);
  assert.match(aggregate, /needs\.release-image-browser\.result/u);
  assert.match(aggregate, /needs\.release-image-proxy\.result/u);
  assert.doesNotMatch(aggregate, /docker\/build-push-action/u);
});
test("parallelizes public release image publishers behind the images digest aggregator", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const normalized = workflow.replaceAll("\r\n", "\n");
  const gatewayStart = normalized.indexOf("  release-image-gateway:");
  const browserStart = normalized.indexOf("\n  release-image-browser:", gatewayStart);
  const proxyStart = normalized.indexOf("\n  release-image-proxy:", browserStart);
  const imagesStart = normalized.indexOf("\n  images:", proxyStart);
  const packageStart = normalized.indexOf("\n  package:", imagesStart);

  assert.ok(
    gatewayStart >= 0 && browserStart > gatewayStart && proxyStart > browserStart && imagesStart > proxyStart && packageStart > imagesStart,
    "public release image publishers must run independently before the images digest aggregator and package job",
  );

  const gateway = normalized.slice(gatewayStart, browserStart);
  assert.match(gateway, /needs: metadata/u);
  assert.match(gateway, /packages: write/u);
  assert.match(gateway, /digest: \$\{\{ steps\.gateway\.outputs\.digest \}\}/u);
  assert.match(gateway, /deploy\/docker\/gateway\.Dockerfile/u);
  assert.doesNotMatch(gateway, /browser-worker\.Dockerfile|proxy\.Dockerfile/u);

  const browser = normalized.slice(browserStart, proxyStart);
  assert.match(browser, /needs: metadata/u);
  assert.match(browser, /packages: write/u);
  assert.match(browser, /digest: \$\{\{ steps\.browser-worker\.outputs\.digest \}\}/u);
  assert.match(browser, /deploy\/remote\/browser-worker\.Dockerfile/u);
  assert.doesNotMatch(browser, /gateway\.Dockerfile|proxy\.Dockerfile/u);

  const proxy = normalized.slice(proxyStart, imagesStart);
  assert.match(proxy, /needs: metadata/u);
  assert.match(proxy, /packages: write/u);
  assert.match(proxy, /digest: \$\{\{ steps\.proxy\.outputs\.digest \}\}/u);
  assert.match(proxy, /deploy\/docker\/proxy\.Dockerfile/u);
  assert.doesNotMatch(proxy, /gateway\.Dockerfile|browser-worker\.Dockerfile/u);

  const images = normalized.slice(imagesStart, packageStart);
  assert.match(images, /- release-image-gateway/u);
  assert.match(images, /- release-image-browser/u);
  assert.match(images, /- release-image-proxy/u);
  assert.match(images, /gateway-digest: \$\{\{ steps\.digests\.outputs\.gateway-digest \}\}/u);
  assert.match(images, /browser-worker-digest: \$\{\{ steps\.digests\.outputs\.browser-worker-digest \}\}/u);
  assert.match(images, /proxy-digest: \$\{\{ steps\.digests\.outputs\.proxy-digest \}\}/u);
  assert.doesNotMatch(images, /docker\/build-push-action/u);

  const packageJob = normalized.slice(packageStart + 1);
  assert.match(packageJob, /^  package:\n    needs:/u);
  assert.match(packageJob, /- metadata/u);
  assert.match(packageJob, /- images/u);
  assert.match(packageJob, /needs\.images\.outputs\.gateway-digest/u);
  assert.match(packageJob, /needs\.images\.outputs\.proxy-digest/u);
});