import { execFile } from "node:child_process";
import { lstat, readdir, statfs } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const ROOTS = Object.freeze({
  releases: "/var/lib/mcp-access-stack/releases",
  worktrees: "/srv/mcp-access-stack/.worktrees",
  root: "/",
});
const SYSTEM_PATHS = Object.freeze([
  "/usr", "/opt", "/var/cache", "/var/log", "/var/lib/apt",
  "/var/lib/dpkg", "/var/lib/snapd", "/tmp", "/home", "/root", "/etc",
]);
const MAX_PER_CALL = 3;
const SYSTEM_TIMEOUT_MS = 45_000;
const CHILD_TIMEOUT_MS = 12_000;

export function parseArgs(args) {
  let group = "system";
  let start = 0;
  let limit;
  const seen = new Set();
  for (const arg of args) {
    const match = /^--(group|start|limit)=(.+)$/u.exec(arg);
    if (!match || seen.has(match[1])) throw new Error("Invalid or repeated option.");
    seen.add(match[1]);
    const [, key, value] = match;
    if (key === "group") {
      if (!["system", "releases", "worktrees", "root"].includes(value)) {
        throw new Error("Unknown audit group.");
      }
      group = value;
    } else {
      if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error("Invalid nonnegative integer.");
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error("Integer out of range.");
      if (key === "start") start = number;
      else limit = number;
    }
  }
  const maximum = group === "system" || group === "root" ? 1 : MAX_PER_CALL;
  limit ??= maximum;
  if (limit < 1 || limit > maximum) throw new Error(`Limit must be between 1 and ${maximum}.`);
  return { group, start, limit };
}

export function classifyDuError(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  if (code === "EACCES" || code === "EPERM" || /permission denied|operation not permitted/iu.test(stderr)) {
    return "permission_denied";
  }
  if (code === "ETIMEDOUT" || error?.killed === true) return "timed_out";
  if (code === "ENOENT") return "missing";
  return "failed";
}

async function diskSize(absolutePath, timeoutMs, run = execute) {
  try {
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink() || !(info.isDirectory() || info.isFile())) {
      return { path: absolutePath, status: "not_physical_directory" };
    }
    const { stdout } = await run("du", ["-sx", "-B1", "--", absolutePath], {
      timeout: timeoutMs,
      maxBuffer: 2048,
      windowsHide: true,
    });
    const size = /^([0-9]+)\s/u.exec(stdout);
    if (!size || !Number.isSafeInteger(Number(size[1]))) {
      return { path: absolutePath, status: "invalid_output" };
    }
    return { path: absolutePath, status: "measured", allocatedBytes: Number(size[1]) };
  } catch (error) {
    return { path: absolutePath, status: classifyDuError(error) };
  }
}

export async function audit(options, dependencies = {}) {
  const { group, start, limit } = options;
  const root = ROOTS[group];
  const fsStat = dependencies.statfs ?? statfs;
  const disk = dependencies.diskSize ?? diskSize;
  let targets;
  if (root) {
    try {
      const entries = await (dependencies.readdir ?? readdir)(root, { withFileTypes: true });
      targets = entries.filter(entry => entry.isDirectory() || (group === "root" && entry.isFile()))
        .map(entry => path.join(root, entry.name)).sort();
    } catch (error) {
      return { group, complete: false, error: error?.code ?? "READ_ERROR", targets: [] };
    }
  } else {
    targets = [...SYSTEM_PATHS];
  }
  const part = targets.slice(start, start + limit);
  let filesystem = null;
  try {
    const fs = await fsStat("/");
    const block = Number(fs.bsize);
    const blocks = Number(fs.blocks);
    const free = Number(fs.bfree);
    const available = Number(fs.bavail);
    if ([block, blocks, free, available].every(Number.isSafeInteger) &&
        [block * blocks, block * (blocks - free), block * available].every(Number.isSafeInteger)) {
      filesystem = {
        totalBytes: block * blocks, usedBytes: block * (blocks - free),
        availableBytes: block * available,
      };
    }
  } catch { /* Total is optional; no invented value. */ }
  const measured = [];
  const perTargetTimeoutMs = group === "system" || group === "root"
    ? SYSTEM_TIMEOUT_MS : CHILD_TIMEOUT_MS;
  for (const target of part) measured.push(await disk(target, perTargetTimeoutMs));
  return {
    group, start, count: targets.length, nextStart: start + part.length < targets.length
      ? start + part.length : null,
    complete: start === 0 && part.length === targets.length &&
      measured.every(item => item.status === "measured"),
    filesystem, targets: measured,
    measuredBytes: measured.reduce((sum, item) => sum + (item.allocatedBytes ?? 0), 0),
    warning: "Partial measurements never justify treating the df-minus-du difference as reclaimable files.",
  };
}

export function parsePrivilegedInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "group,limit,start" ||
      typeof value.group !== "string" ||
      !Number.isSafeInteger(value.start) || value.start < 0 ||
      !Number.isSafeInteger(value.limit) || value.limit < 1) {
    throw new Error("Invalid privileged audit input.");
  }
  return parseArgs([
    `--group=${value.group}`, `--start=${value.start}`, `--limit=${value.limit}`,
  ]);
}

async function readPrivilegedInput() {
  let payload = "";
  for await (const chunk of process.stdin) {
    payload += chunk.toString("utf8");
    if (Buffer.byteLength(payload) > 256) throw new Error("Audit input exceeds limit.");
  }
  return parsePrivilegedInput(JSON.parse(payload));
}

const isEntrypoint = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  try {
    const args = process.argv.slice(2);
    const options = args.length === 1 && args[0] === "--privileged-stdin"
      ? await readPrivilegedInput() : parseArgs(args);
    const result = await audit(options);
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.error) process.exitCode = 2;
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : "Invalid input") + "\n");
    process.exitCode = 2;
  }
}
