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
    "npm run test:browser-worker && npm run test:mcp-core && npm run test:mcp-gateway && npm run test:workspace-agent && npm run test:mcp-edge-gateway",
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
  const workspaceUnitStart = normalized.indexOf("\n  pr-workspace-agent-unit:", browserStart);
  const workspaceIntegrationShard1Start = normalized.indexOf("\n  pr-workspace-agent-integration-shard-1-e2e:", workspaceUnitStart);
  const workspaceIntegrationShard2Start = normalized.indexOf("\n  pr-workspace-agent-integration-shard-2:", workspaceIntegrationShard1Start);
  const workspaceAggregateStart = normalized.indexOf("\n  pr-workspace-agent:", workspaceIntegrationShard2Start);
  const windowsDistributionStart = normalized.indexOf("\n  pr-windows-distribution:", workspaceAggregateStart);
  const runtimeCoreStart = normalized.indexOf("\n  pr-runtime-assurance-core:", windowsDistributionStart);
  const runtimeAggregateStart = normalized.indexOf("\n  pr-runtime-assurance:", runtimeCoreStart);
  const checkStart = normalized.indexOf("\n  check:", runtimeAggregateStart);
  const mainStart = normalized.indexOf("\n  main-integration:", checkStart);

  assert.ok(
    validationStart >= 0 &&
      browserStart > validationStart &&
      workspaceUnitStart > browserStart &&
      workspaceIntegrationShard1Start > workspaceUnitStart &&
      workspaceIntegrationShard2Start > workspaceIntegrationShard1Start &&
      workspaceAggregateStart > workspaceIntegrationShard2Start &&
      windowsDistributionStart > workspaceAggregateStart &&
      runtimeCoreStart > windowsDistributionStart &&
      runtimeAggregateStart > runtimeCoreStart &&
      checkStart > runtimeAggregateStart &&
      mainStart > checkStart,
    "PR validation lanes must run before the canonical check aggregator and main integration",
  );

  const validation = normalized.slice(validationStart, browserStart);
  assert.doesNotMatch(validation, /- name: Install Playwright Chromium/u);
  assert.doesNotMatch(validation, /- name: Test Browser Worker/u);
  assert.doesNotMatch(validation, /- name: Build Browser Worker/u);
  assert.doesNotMatch(validation, /- name: Test Workspace Agent/u);
  assert.doesNotMatch(validation, /- name: Validate Windows and release runtime assurance/u);

  const browser = normalized.slice(browserStart, workspaceUnitStart);
  assert.match(browser, /needs: impact/u);
  assert.match(browser, /needs\.impact\.outputs\.browserWorker/u);
  assert.match(browser, /- name: Install Playwright Chromium/u);
  assert.match(browser, /run: npx playwright install --only-shell chromium/u);
  assert.match(browser, /- name: Test Browser Worker/u);
  assert.match(browser, /run: npm run test:browser-worker/u);
  assert.match(browser, /- name: Build Browser Worker/u);
  assert.match(browser, /run: npm run build --workspace @vs-code-gpt\/browser-worker/u);

  const workspaceUnit = normalized.slice(workspaceUnitStart, workspaceIntegrationShard1Start);
  assert.match(workspaceUnit, /needs: impact/u);
  assert.match(workspaceUnit, /run: npm run test:workspace-agent:unit/u);
  assert.doesNotMatch(workspaceUnit, /test:workspace-agent:integration|test:workspace-agent:e2e/u);

  const workspaceIntegrationShard1 = normalized.slice(workspaceIntegrationShard1Start, workspaceIntegrationShard2Start);
  assert.match(workspaceIntegrationShard1, /needs: impact/u);
  assert.match(workspaceIntegrationShard1, /needs\.impact\.outputs\.workspaceAgent/u);
  assert.match(workspaceIntegrationShard1, /run: npm run test:workspace-agent:integration -- --shard=1\/2/u);
  assert.match(workspaceIntegrationShard1, /run: npm run test:workspace-agent:e2e/u);
  assert.doesNotMatch(workspaceIntegrationShard1, /test:workspace-agent:unit/u);

  const workspaceIntegrationShard2 = normalized.slice(workspaceIntegrationShard2Start, workspaceAggregateStart);
  assert.match(workspaceIntegrationShard2, /needs: impact/u);
  assert.match(workspaceIntegrationShard2, /needs\.impact\.outputs\.workspaceAgent/u);
  assert.match(workspaceIntegrationShard2, /run: npm run test:workspace-agent:integration -- --shard=2\/2/u);
  assert.doesNotMatch(workspaceIntegrationShard2, /test:workspace-agent:unit|test:workspace-agent:e2e/u);

  const workspaceAggregate = normalized.slice(workspaceAggregateStart, windowsDistributionStart);
  assert.match(workspaceAggregate, /- pr-workspace-agent-unit/u);
  assert.match(workspaceAggregate, /- pr-workspace-agent-integration-shard-1-e2e/u);
  assert.match(workspaceAggregate, /- pr-workspace-agent-integration-shard-2/u);
  assert.match(workspaceAggregate, /needs\.pr-workspace-agent-unit\.result/u);
  assert.match(workspaceAggregate, /needs\.pr-workspace-agent-integration-shard-1-e2e\.result/u);
  assert.match(workspaceAggregate, /needs\.pr-workspace-agent-integration-shard-2\.result/u);
  assert.doesNotMatch(workspaceAggregate, /actions\/checkout|setup-node|npm ci|test:workspace-agent/u);

  const windowsDistribution = normalized.slice(windowsDistributionStart, runtimeCoreStart);
  assert.match(windowsDistribution, /needs: impact/u);
  assert.match(windowsDistribution, /needs\.impact\.outputs\.windowsRuntime/u);
  assert.match(windowsDistribution, /run: pwsh -NoLogo -NoProfile -File deploy\/windows\/Test-WindowsDistribution\.ps1/u);
  assert.doesNotMatch(windowsDistribution, /check:release-runtime|check:persistence|check:materialization/u);

  const runtimeCore = normalized.slice(runtimeCoreStart, runtimeAggregateStart);
  assert.match(runtimeCore, /needs: impact/u);
  assert.match(runtimeCore, /needs\.impact\.outputs\.windowsRuntime/u);
  assert.match(runtimeCore, /run: npm run check:runtime-assurance:core/u);
  assert.doesNotMatch(runtimeCore, /Test-WindowsDistribution\.ps1/u);

  const runtimeAggregate = normalized.slice(runtimeAggregateStart, checkStart);
  assert.match(runtimeAggregate, /- pr-windows-distribution/u);
  assert.match(runtimeAggregate, /- pr-runtime-assurance-core/u);
  assert.match(runtimeAggregate, /needs\.pr-windows-distribution\.result/u);
  assert.match(runtimeAggregate, /needs\.pr-runtime-assurance-core\.result/u);
  assert.doesNotMatch(runtimeAggregate, /actions\/checkout|setup-node|npm ci|check:runtime-assurance/u);

  const check = normalized.slice(checkStart, mainStart);
  assert.match(check, /- pr-validation/u);
  assert.match(check, /- pr-browser-worker/u);
  assert.match(check, /- pr-workspace-agent/u);
  assert.match(check, /- pr-runtime-assurance/u);
  assert.match(check, /needs\.pr-validation\.result/u);
  assert.match(check, /needs\.pr-browser-worker\.result/u);
  assert.match(check, /needs\.pr-workspace-agent\.result/u);
  assert.match(check, /needs\.pr-runtime-assurance\.result/u);
  assert.doesNotMatch(check, /pr-workspace-agent-unit|pr-workspace-agent-integration-shard-1-e2e|pr-workspace-agent-integration-shard-2|pr-windows-distribution|pr-runtime-assurance-core/u);
});
test("keeps canonical CI free of Docker image lanes", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /dockerGateway|dockerBrowser|dockerProxy|release-image-|docker\/build-push-action|deploy\/docker|deploy\/remote/u);
});

test("keeps public release workflow free of Docker and GHCR image publication", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /release-image-|docker\/build-push-action|docker\/login-action|deploy\/docker|deploy\/remote|gateway-digest|proxy-digest|browser-worker-digest/u);
});
