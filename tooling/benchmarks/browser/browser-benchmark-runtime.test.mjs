import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  enrichGatewayTiming,
  prepareIsolatedBenchmarkProfile,
  prepareOfficialSource,
  sourceSummary,
} from "./browser-benchmark-runtime.mjs";

const execFileAsync = promisify(execFile);

test("separates Gateway header latency from MCP client SDK completion", () => {
  const timing = enrichGatewayTiming(
    { serverBeforeWriteMs: 10 },
    18,
    { fetchHeadersMs: 13 },
  );

  assert.equal(timing.clientResidualMs, 8);
  assert.equal(timing.clientHeadersElapsedMs, 13);
  assert.equal(timing.clientHeadersResidualMs, 3);
  assert.equal(timing.clientSdkResidualMs, 5);
});

test("rebuilds official dist artifacts from the same clean immutable source", async () => {
  const root = await createFixtureRepository();
  try {
    await writeFixtureBuild(root, "stale-build");
    const before = await sourceSummary(root);
    assert.equal(before.dirty, false);
    assert.equal(before.build.status, "present");

    const prepared = await prepareOfficialSource(root, "candidate");

    assert.equal(prepared.commit, before.commit);
    assert.equal(prepared.sourceTreeSha256, before.sourceTreeSha256);
    assert.equal(prepared.dirty, false);
    assert.equal(prepared.build.status, "present");
    assert.equal(prepared.build.verification, "rebuilt-from-clean-source");
    assert.equal(prepared.build.command, "npm run build");
    assert.match(prepared.build.sha256, /^[a-f0-9]{64}$/u);
    assert.notEqual(prepared.build.sha256, before.build.sha256);
    assert.equal(
      await readFile(path.join(root, "services", "browser-worker", "dist", "server.js"), "utf8"),
      "browser-worker:source-v1\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an official build that changes the committed source tree", async () => {
  const root = await createFixtureRepository({ mutateSourceDuringBuild: true });
  try {
    await assert.rejects(
      prepareOfficialSource(root, "candidate"),
      /source tree must be clean|source tree changed/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an official build before executing npm when the source is dirty", async () => {
  const root = await createFixtureRepository();
  try {
    await writeFile(
      path.join(root, "services", "browser-worker", "source.txt"),
      "dirty-source\n",
      "utf8",
    );
    await assert.rejects(
      prepareOfficialSource(root, "candidate"),
      /source tree must be clean/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("copies authenticated profiles into the private benchmark directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-profile-copy-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "scratch", "private", "profile");
  try {
    await mkdir(path.join(source, "Default"), { recursive: true });
    await writeFile(path.join(source, "Default", "Cookies"), "authenticated\n", "utf8");
    await writeFile(path.join(source, "SingletonLock"), "stale-lock\n", "utf8");

    const result = await prepareIsolatedBenchmarkProfile({
      sourceDirectory: source,
      destinationDirectory: destination,
    });

    assert.equal(result.copied, true);
    assert.equal(await readFile(path.join(destination, "Default", "Cookies"), "utf8"), "authenticated\n");
    await assert.rejects(readFile(path.join(destination, "SingletonLock"), "utf8"));
    assert.equal(await readFile(path.join(source, "SingletonLock"), "utf8"), "stale-lock\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unavailable authenticated benchmark profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-profile-missing-"));
  try {
    await assert.rejects(
      prepareIsolatedBenchmarkProfile({
        sourceDirectory: path.join(root, "missing"),
        destinationDirectory: path.join(root, "private", "profile"),
      }),
      /profile directory is unavailable/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createFixtureRepository(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-official-build-"));
  const files = new Map([
    [".gitignore", "**/dist/\n"],
    ["package.json", JSON.stringify({
      private: true,
      scripts: { build: "node build.mjs" },
    }, null, 2) + "\n"],
    ["package-lock.json", JSON.stringify({
      name: "browser-official-build-fixture",
      lockfileVersion: 3,
      packages: {},
    }, null, 2) + "\n"],
    ["deploy/docker/gateway.Dockerfile", "FROM scratch\n"],
    ["packages/mcp-core/source.txt", "source-v1\n"],
    ["services/browser-worker/package.json", JSON.stringify({
      name: "fixture-browser-worker",
      version: "1.0.0",
      dependencies: { playwright: "fixture" },
    }, null, 2) + "\n"],
    ["services/browser-worker/source.txt", "source-v1\n"],
    ["services/mcp-gateway/source.txt", "source-v1\n"],
    ["tooling/benchmarks/browser/source.txt", "source-v1\n"],
    ["build.mjs", `import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const targets = [
  ["packages/mcp-core", "index.js", "mcp-core"],
  ["services/browser-worker", "server.js", "browser-worker"],
  ["services/mcp-gateway", "server.js", "mcp-gateway"],
];
for (const [directory, filename, label] of targets) {
  const source = (await readFile(path.join(directory, "source.txt"), "utf8")).trim();
  const output = path.join(directory, "dist");
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, filename), label + ":" + source + "\\n", "utf8");
}
${options.mutateSourceDuringBuild ? 'await writeFile("services/browser-worker/source.txt", "mutated-by-build\\n", "utf8");' : ''}
`],
  ]);
  for (const [relative, content] of files) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "benchmark@example.invalid"]);
  await git(root, ["config", "user.name", "Benchmark Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "test: create benchmark fixture"]);
  return root;
}

async function writeFixtureBuild(root, marker) {
  for (const [directory, filename] of [
    ["packages/mcp-core", "index.js"],
    ["services/browser-worker", "server.js"],
    ["services/mcp-gateway", "server.js"],
  ]) {
    const output = path.join(root, directory, "dist");
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, filename), `${marker}\n`, "utf8");
  }
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root, windowsHide: true });
}
