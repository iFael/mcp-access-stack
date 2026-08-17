import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildWindowsSshRpcScript } from "../../../src/remote/windows-ssh-rpc-script.js";

const windowsIt = process.platform === "win32" ? it : it.skip;

describe("Windows SSH RPC script", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "mcp-ssh-rpc-"));
    await writeFile(path.join(root, "README.md"), "hello\n", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  windowsIt("reads and writes workspace files without installing a helper", async () => {
    const read = await invoke({
      operation: "readBytes",
      rootPath: root,
      logicalPath: "README.md",
      maxBytes: 64_000,
    });
    if (!read.ok) throw new Error(JSON.stringify(read));
    expect(read.ok).toBe(true);
    expect(Buffer.from(String(read.result.contentBase64), "base64").toString("utf8")).toBe("hello\n");

    const write = await invoke({
      operation: "writeBytes",
      rootPath: root,
      logicalPath: "src/generated.txt",
      contentBase64: Buffer.from("remote\n", "utf8").toString("base64"),
    });
    if (!write.ok) throw new Error(JSON.stringify(write));
    expect(write.ok).toBe(true);

    const reread = await invoke({
      operation: "readBytes",
      rootPath: root,
      logicalPath: "src/generated.txt",
      maxBytes: 64_000,
    });
    expect(Buffer.from(String(reread.result.contentBase64), "base64").toString("utf8")).toBe("remote\n");
  });

  windowsIt("does not traverse excluded workspace subtrees", async () => {
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "ignored.js"), "ignored\n", "utf8");
    const listed = await invoke({
      operation: "list",
      rootPath: root,
      logicalRoot: ".",
      recursive: true,
      directoriesOnly: false,
      maxEntries: 100,
      excludedPrefixes: ["node_modules"],
    });
    if (!listed.ok) throw new Error(JSON.stringify(listed));
    expect(listed.result.entries.map((entry: { path: string }) => entry.path)).toContain("README.md");
    expect(listed.result.entries.map((entry: { path: string }) => entry.path)).not.toContain("node_modules/ignored.js");
  });
  windowsIt("runs an explicit PowerShell command in the authorized cwd", async () => {
    const result = await invoke({
      operation: "runShell",
      rootPath: root,
      logicalCwd: ".",
      shell: "pwsh",
      command: "Write-Output 'ssh-rpc-ok'",
      timeoutMs: 30_000,
    });
    expect(result.ok).toBe(true);
    expect(String(result.result.stdout)).toContain("ssh-rpc-ok");
    expect(result.result.exitCode).toBe(0);
  });
});

async function invoke(request: Record<string, unknown>): Promise<any> {
  const child = spawn(
    "pwsh.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(buildWindowsSshRpcScript(request));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const output = Buffer.concat(stdout).toString("utf8").trim();
  if (!output) {
    throw new Error(`RPC produced no stdout (exit=${exitCode}): ${Buffer.concat(stderr).toString("utf8")}`);
  }
  const line = output.split(/\r?\n/u).filter(Boolean).at(-1) ?? "";
  return JSON.parse(line);
}
