#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MANIFEST_NAME, hashTree, sha256File, verifyCampaignRunnerDirectory } from "./Verify-CampaignRunnerLinux.mjs";

const VERSION = "v26.10.0";
const ARCHIVE = "node-v26.10.0-linux-x64.tar.xz";
// SHA256 from the official Node.js v26.10.0 SHASUMS256.txt (linux-x64).
const ARCHIVE_SHA256 = "ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022";
const SOURCE_PACKAGES = [
  ["packages/mcp-core", "@vs-code-gpt/shared"],
  ["services/workspace-agent", "@vs-code-gpt/local-agent"],
];
const SHA = /^[a-f0-9]{40}$/u;

function command(bin, argv, cwd, { capture = false } = {}) {
  const r = spawnSync(bin, argv, {
    cwd, encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true, timeout: 180000,
  });
  if (r.error || r.status !== 0) throw new Error("CAMPAIGN_ARTIFACT_COMMAND_FAILED: " + path.basename(bin));
  return r.stdout?.trim() ?? "";
}
function parse(argv) {
  if (argv.length !== 4 || argv[0] !== "--source-commit" ||
      argv[2] !== "--output" || !SHA.test(argv[1])) {
    throw new Error("CAMPAIGN_ARTIFACT_INVALID_ARGS");
  }
  const output = path.resolve(argv[3]);
  if (path.basename(output) !== "mcp-v3-campaign-linux-x64-" + argv[1] + ".tar.gz") {
    throw new Error("CAMPAIGN_ARTIFACT_OUTPUT_NAME_MISMATCH");
  }
  return { sourceCommit: argv[1], output };
}
async function assertMissing(file) {
  try {
    await lstat(file);
    throw new Error("CAMPAIGN_ARTIFACT_OUTPUT_ALREADY_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
async function addWorkspace(stage, root, workspace) {
  const dir = path.join(root, workspace);
  for (const relative of ["package.json", "dist"]) {
    const source = path.join(dir, relative);
    const info = await lstat(source);
    if ((relative === "dist" && !info.isDirectory()) ||
        (relative === "package.json" && !info.isFile()) ||
        info.isSymbolicLink()) throw new Error("CAMPAIGN_ARTIFACT_SOURCE_INVALID");
    const target = path.join(stage, workspace, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, relative === "dist" ? { recursive: true } : {});
  }
}
async function materialize(stage) {
  for (const [dir, name] of SOURCE_PACKAGES) {
    const target = path.join(stage, "node_modules", ...name.split("/"));
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await cp(path.join(stage, dir, "package.json"), path.join(target, "package.json"));
    await cp(path.join(stage, dir, "dist"), path.join(target, "dist"), { recursive: true });
  }
  const lock = JSON.parse(await readFile(path.join(stage, "package-lock.json"), "utf8"));
  if (!lock?.packages || typeof lock.packages !== "object") {
    throw new Error("CAMPAIGN_ARTIFACT_LOCK_INVALID");
  }
  const selected = new Set(SOURCE_PACKAGES.map(([dir]) => dir));
  const modulesRoot = path.join(stage, "node_modules");
  for (const [relative, value] of Object.entries(lock.packages)) {
    if (!relative.startsWith("node_modules/") || value?.link !== true ||
        selected.has(value?.resolved)) continue;
    const target = path.resolve(stage, relative);
    if (!target.startsWith(modulesRoot + path.sep)) {
      throw new Error("CAMPAIGN_ARTIFACT_LOCK_PATH_ESCAPE");
    }
    const stat = await lstat(target).catch(error => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (stat) {
      if (!stat.isSymbolicLink()) throw new Error("CAMPAIGN_ARTIFACT_UNEXPECTED_MODULE");
      await rm(target);
    }
  }
  await rm(path.join(modulesRoot, ".bin"), { recursive: true, force: true });
  await rm(path.join(stage, "packages"), { recursive: true, force: true });
  await rm(path.join(stage, "services"), { recursive: true, force: true });
  await rm(path.join(stage, "package.json"));
  await rm(path.join(stage, "package-lock.json"));
}
async function officialNode(stage, temporary) {
  const tar = path.join(temporary, ARCHIVE);
  // Download only the fixed HTTPS official filename; the checksum is pinned in source.
  command("curl", ["--fail", "--location", "--silent", "--show-error",
    "--connect-timeout", "15", "--max-time", "120",
    "--output", tar, "https://nodejs.org/dist/" + VERSION + "/" + ARCHIVE], temporary);
  if (await sha256File(tar) !== ARCHIVE_SHA256) {
    throw new Error("CAMPAIGN_ARTIFACT_NODE_CHECKSUM_MISMATCH");
  }
  const unpacked = path.join(temporary, "official-node");
  await mkdir(unpacked);
  const prefix = "node-" + VERSION + "-linux-x64";
  command("tar", ["-xJf", tar, "-C", unpacked, "--no-same-owner",
    prefix + "/bin/node", prefix + "/LICENSE"], temporary);
  await mkdir(path.join(stage, "runtime"), { recursive: true });
  await cp(path.join(unpacked, prefix, "bin/node"), path.join(stage, "runtime/node"));
  await cp(path.join(unpacked, prefix, "LICENSE"), path.join(stage, "runtime/LICENSE"));
  await chmod(path.join(stage, "runtime/node"), 0o755);
  if (command(path.join(stage, "runtime/node"), ["--version"], stage, { capture: true }) !== VERSION) {
    throw new Error("CAMPAIGN_ARTIFACT_NODE_VERSION_MISMATCH");
  }
}
async function createPackage(root, sourceCommit, output) {
  if (process.platform !== "linux" || process.arch !== "x64" ||
      process.version !== VERSION) throw new Error("CAMPAIGN_ARTIFACT_HOST_MISMATCH");
  if (command("git", ["rev-parse", "HEAD"], root, { capture: true }) !== sourceCommit ||
      command("git", ["status", "--porcelain=v1"], root, { capture: true }) !== "") {
    throw new Error("CAMPAIGN_ARTIFACT_SOURCE_NOT_CLEAN_SHA");
  }
  await mkdir(path.dirname(output), { recursive: true });
  await assertMissing(output);
  await assertMissing(output + ".sha256");
  const temporary = await mkdtemp(path.join(path.dirname(output), ".mcp-v3-campaign-build-"));
  const stage = path.join(temporary, "staging");
  try {
    await mkdir(stage);
    await cp(path.join(root, "package.json"), path.join(stage, "package.json"));
    await cp(path.join(root, "package-lock.json"), path.join(stage, "package-lock.json"));
    for (const [workspace] of SOURCE_PACKAGES) await addWorkspace(stage, root, workspace);
    const lockSha256 = await sha256File(path.join(root, "package-lock.json"));
    command("npm", ["ci", "--omit=dev", "--ignore-scripts", "--workspaces",
      "--include-workspace-root", "--no-audit", "--no-fund"], stage);
    await materialize(stage);
    await officialNode(stage, temporary);
    const checker = path.join(stage, "verify.mjs");
    await cp(path.join(root, "tooling/release/Verify-CampaignRunnerLinux.mjs"), checker);
    const manifest = {
      schemaVersion: 1,
      format: "mcp-v3-trusted-campaign-runner",
      platform: "linux-x64",
      nodeVersion: VERSION,
      nodeArchiveSha256: ARCHIVE_SHA256,
      lockSha256,
      sourceCommit,
      files: await hashTree(stage),
    };
    await writeFile(path.join(stage, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx", mode: 0o600,
    });
    await verifyCampaignRunnerDirectory(stage, sourceCommit);
    command(path.join(stage, "runtime/node"), [
      "--input-type=module", "-e",
      'const host = await import("./node_modules/@vs-code-gpt/local-agent/dist/campaign/trusted-campaign-service-entrypoint.js"); if(typeof host.runTrustedCampaignService !== "function")process.exit(1);',
    ], stage);
    command("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0",
      "--numeric-owner", "-czf", output, "-C", stage, "."], temporary);
    const artifactSha256 = await sha256File(output);
    await writeFile(output + ".sha256",
      artifactSha256 + "  " + path.basename(output) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify({
      status: "created", sourceCommit, platform: "linux-x64", nodeVersion: VERSION,
      files: manifest.files.length, bytes: (await lstat(output)).size, sha256: artifactSha256,
      output,
    }) + "\n");
  } catch (error) {
    await rm(output, { force: true }).catch(() => undefined);
    await rm(output + ".sha256", { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parse(process.argv.slice(2));
    await createPackage(process.cwd(), args.sourceCommit, args.output);
  } catch (error) {
    process.stderr.write("CAMPAIGN_ARTIFACT_BUILD_FAILED: " +
      (error instanceof Error ? error.message : "unknown") + "\n");
    process.exitCode = 1;
  }
}
