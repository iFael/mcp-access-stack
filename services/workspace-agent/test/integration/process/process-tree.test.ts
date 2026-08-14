import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import { terminateProcessTreeByPid } from "../../../src/process/process-tree.js";

const windowsTest = process.platform === "win32" ? test : test.skip;

let tempDirectory: string | undefined;
let leakedChildPid: number | undefined;

afterEach(async () => {
  if (leakedChildPid && processExists(leakedChildPid)) {
    try {
      process.kill(leakedChildPid, "SIGKILL");
    } catch {
    }
  }
  leakedChildPid = undefined;
  if (tempDirectory) {
    await rm(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
}, 30_000);

describe("Windows process tree termination", () => {
  windowsTest(
    "terminates a surviving descendant after the original root has already exited",
    async () => {
      tempDirectory = await mkdtemp(path.join(os.tmpdir(), "mcp-process-tree-"));
      const pidPath = path.join(tempDirectory, "descendant.pid");
      const childScript = "setTimeout(() => process.exit(0), 30000)";
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore', windowsHide: true, detached: true });`,
        `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
        "child.unref();",
      ].join(" ");
      const parent = spawn(process.execPath, ["-e", parentScript], {
        windowsHide: true,
        stdio: "ignore",
      });
      const rootPid = parent.pid;
      if (!rootPid) throw new Error("Expected the parent process to have a PID.");

      await once(parent, "close");
      leakedChildPid = Number((await readFile(pidPath, "utf8")).trim());
      expect(Number.isSafeInteger(leakedChildPid)).toBe(true);
      expect(processExists(leakedChildPid)).toBe(true);

      await terminateProcessTreeByPid(rootPid);
      await expectProcessToExit(leakedChildPid);
      leakedChildPid = undefined;
    },
    45_000,
  );
});

async function expectProcessToExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} remained alive after tree termination.`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
