import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);
const RELEASE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?$/u;
const digest = x => createHash("sha256").update(x).digest("hex");
const same = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const abort = () => { throw new Error("LOCAL_RETENTION_PRECHECK_FAILED"); };

async function physicalDirectory(dir) {
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || !same(await realpath(dir), dir)) abort();
  return info;
}
function validRelease(id) {
  return typeof id === "string" && id.length <= 90 && RELEASE.test(id) && !id.includes("..");
}
async function processReferences(releaseRoot) {
  // Protect in-use historical runtimes; inspection failure fails closed.
  if (process.platform === "linux") {
    const pids = await readdir("/proc");
    for (const pid of pids.filter(x => /^\d+$/u.test(x))) {
      let command = "";
      try { command = (await readFile("/proc/" + pid + "/cmdline")).toString("utf8").replaceAll("\0", " "); }
      catch (e) { if (e?.code === "ENOENT" || e?.code === "ESRCH") continue; abort(); }
      if (command.includes(releaseRoot + path.sep)) return true;
    }
    return false;
  }
  const executable = process.platform === "win32" ? "pwsh.exe" : "/bin/ps";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { $_.ExecutablePath; $_.CommandLine }"]
    : ["-ax", "-o", "command="];
  const { stdout } = await execFile(executable, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.includes(releaseRoot + path.sep);
}

async function linuxMountpoints() {
  const lines = (await readFile("/proc/self/mountinfo", "utf8")).split("\n").filter(Boolean);
  return lines.map(line => {
    const mount = line.split(" ")[4];
    if (!mount || !mount.startsWith("/")) abort();
    return mount.replace(/\\([0-7]{3})/gu, (_, octal) =>
      String.fromCharCode(parseInt(octal, 8)));
  });
}
async function oracleProcessReferences(releaseRoot) {
  const {stdout} = await execFile("/usr/bin/ps", ["-eo", "args="], {
    timeout:10_000, maxBuffer:2*1024*1024, encoding:"utf8",
  });
  return stdout.includes(releaseRoot + path.sep);
}

/**
 * Internal shared retention executor for the signed local installers.
 * Always keep active, previous and candidate. No caller-supplied paths to delete.
 * A failed/ambiguous cleanup leaves the lock for reconciliation, never retries.
 */
export async function pruneLocalReleases({
  installationRoot, previousReleaseId, activeReleaseId, expectedPlanSha256,
  dryRun = true, processCheck, distribution = "local",
}) {
  if (distribution !== "local" && distribution !== "oracle") abort();
  const oracle = distribution === "oracle";
  if (oracle && process.platform !== "linux") abort();
  const checkProcess = processCheck ?? (oracle ? oracleProcessReferences : processReferences);
  if (!validRelease(activeReleaseId) || !validRelease(previousReleaseId)
    || activeReleaseId === previousReleaseId) abort();
  const root = path.resolve(installationRoot);
  const releases = path.join(root, "releases");
  const stateRoot = path.join(root, "state");
  await physicalDirectory(root);
  const parentInfo = await physicalDirectory(releases);
  await physicalDirectory(stateRoot);
  const stateFile = path.join(stateRoot, "lifecycle-state.v1.json");
  let candidate = null, stateSha = null;
  const stateInfo = await lstat(stateFile).catch(e => e?.code === "ENOENT" ? null : Promise.reject(e));
  if (oracle && !stateInfo) abort();
  if (stateInfo) {
    if (!stateInfo.isFile() || stateInfo.isSymbolicLink()) abort();
    const raw = await readFile(stateFile);
    stateSha = digest(raw);
    const state = JSON.parse(raw.toString("utf8"));
    if (state?.active?.releaseId !== activeReleaseId ||
      state?.previous?.releaseId !== previousReleaseId) abort();
    candidate = state.candidate?.releaseId ?? null;
    if (candidate !== null && !validRelease(candidate)) abort();
  } else {
    const target = await realpath(path.join(root, "current"));
    if (!same(target, path.join(releases, activeReleaseId))) abort();
  }
  if (oracle) {
    if (candidate !== null ||
        !same(await realpath(path.join(root, "current")),
          path.join(releases, activeReleaseId))) abort();
    const children = await readdir(root, {withFileTypes:true});
    if (children.some(child => child.isSymbolicLink() && child.name !== "current")) abort();
  }
  const manifestName = oracle ? "linux-release-manifest.json" : "mcp-v3-local-manifest.json";
  const protectedIds = new Set([activeReleaseId, previousReleaseId, candidate].filter(Boolean));
  const allNames = [];
  for (const entry of await readdir(releases, { withFileTypes: true })) {
    if (!validRelease(entry.name) || protectedIds.has(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) abort();
    const marker = path.join(releases, entry.name, manifestName);
    const proof = await lstat(marker).catch(e => e?.code === "ENOENT" ? null : Promise.reject(e));
    if (!proof) continue; // Historical or foreign release: never infer ownership.
    if (!proof.isFile() || proof.isSymbolicLink()) abort();
    const metadata = JSON.parse(await readFile(marker, "utf8"));
    if (metadata.releaseId !== entry.name || (oracle && metadata.platform !== "linux-x64")) abort();
    allNames.push(entry.name);
  }
  allNames.sort();
  const names = allNames.slice(0, 5);
  const planSha256 = digest(JSON.stringify({activeReleaseId,previousReleaseId,candidate,stateSha,allNames,...(oracle ? {distribution} : {})}));
  const plan = { status:"planned", stateSha256:stateSha, planSha256, names };
  if (dryRun) return plan;
  if (!expectedPlanSha256 || expectedPlanSha256 !== planSha256) abort();
  if (names.length === 0) return {...plan,status:"completed"};
  const lockFile = path.join(stateRoot, oracle ? "release-prune.lock" : "local-release-prune.lock");
  const lock = await open(lockFile, "wx", 0o600);
  const operationId = randomUUID();
  let complete = false;
  try {
    await lock.writeFile(JSON.stringify({operationId,planSha256}));
    await lock.close();
    for (let i=0; i<names.length;i++) {
      const name = names[i];
      const candidateRoot = path.join(releases, name);
      const info = await lstat(candidateRoot);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== parentInfo.dev ||
          !same(await realpath(candidateRoot), candidateRoot)) abort();
      const manifest = path.join(candidateRoot, manifestName);
      const proof = await lstat(manifest);
      if (!proof.isFile() || proof.isSymbolicLink()) abort();
      const meta = JSON.parse(await readFile(manifest, "utf8"));
      if (meta.releaseId !== name || (oracle && meta.platform !== "linux-x64")) abort();
      const current = [];
      for (const entry of await readdir(releases, { withFileTypes:true })) {
        if (!validRelease(entry.name) || protectedIds.has(entry.name)) continue;
        const marker = path.join(releases, entry.name, manifestName);
        const found = await lstat(marker).catch(e => e?.code === "ENOENT" ? null : Promise.reject(e));
        if (found) current.push(entry.name);
      }
      current.sort();
      if (JSON.stringify(current) !== JSON.stringify(allNames.filter(n => !names.slice(0, i).includes(n)))) abort();
      if (stateSha !== null && digest(await readFile(stateFile)) !== stateSha) abort();
      if (stateSha === null && !same(await realpath(path.join(root, "current")),
        path.join(releases, activeReleaseId))) abort();
      if (oracle) {
        if (!same(await realpath(path.join(root, "current")),
            path.join(releases, activeReleaseId))) abort();
        const mounts = await linuxMountpoints();
        if (mounts.some(mount => mount === candidateRoot ||
            mount.startsWith(candidateRoot + path.sep))) abort();
      }
      if (await checkProcess(candidateRoot)) abort();
      const quarantine = path.join(releases, ".local-prune-" + operationId + "-" + i);
      await rename(candidateRoot, quarantine);
      await rm(quarantine, { recursive: true, force: false, maxRetries:0 });
    }
    complete = true;
    return {...plan,status:"completed"};
  } finally {
    await lock.close().catch(()=>{});
    if (complete) await rm(lockFile, {force:true});
  }
}

export async function drainLocalReleases(options, maxBatches = 20) {
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 20) abort();
  let removedCount = 0;
  const removedReleases = options.distribution === "oracle" ? [] : null;
  for (let index = 0; index < maxBatches; index++) {
    const preview = await pruneLocalReleases({...options,dryRun:true});
    if (preview.names.length === 0) {
      const outcome = {status:"completed",removedCount,batches:index};
      return removedReleases === null ? outcome : {...outcome,removedReleases};
    }
    const result = await pruneLocalReleases({...options,dryRun:false,
      expectedPlanSha256:preview.planSha256});
    if (result.status !== "completed" ||
        result.planSha256 !== preview.planSha256 ||
        result.names.length !== preview.names.length) abort();
    removedCount += result.names.length;
    if (removedReleases !== null) removedReleases.push(...result.names);
  }
  throw new Error("LOCAL_RETENTION_BATCH_LIMIT");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const oracle = process.argv[2] === "--oracle-drain";
    const drain = process.argv[2] === "--drain" || oracle;
    const [root, active, previous, planSha] = process.argv.slice(drain ? 3 : 2);
    if (drain ? process.argv.length !== 6 :
      (process.argv.length !== 5 && process.argv.length !== 6)) abort();
    const input = {installationRoot:root,activeReleaseId:active,previousReleaseId:previous,
      ...(oracle ? {distribution:"oracle"} : {})};
    const result = drain
      ? await drainLocalReleases(input)
      : await pruneLocalReleases({...input,
          ...(planSha ? {dryRun:false,expectedPlanSha256:planSha} : {})});
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    process.stderr.write(process.argv[2] === "--oracle-drain" ? "ORACLE_RETENTION_REFUSED\n" : "LOCAL_RETENTION_REFUSED\n");
    process.exitCode = 1;
  }
}
