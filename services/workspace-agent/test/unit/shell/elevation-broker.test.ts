import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "@jest/globals";
import { createOperationDeadline } from "@vs-code-gpt/shared";
import { WindowsElevationBroker } from "../../../src/shell/elevation-broker.js";

const temporaryRoots: string[] = [];

describe("WindowsElevationBroker", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  });

  it("keeps command content out of the UAC command line and validates the nonce-bound response", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-elevation-"));
    temporaryRoots.push(root);
    const brokerPath = path.join(root, "McpElevationBroker.exe");
    await writeFile(brokerPath, "fixture", "utf8");

    const captured: { file?: string; args?: readonly string[] } = {};
    const spawnProcess = ((file: string, args: readonly string[]) => {
      captured.file = file;
      captured.args = [...args];
      const child = new EventEmitter() as EventEmitter & {
        stderr: PassThrough;
      };
      child.stderr = new PassThrough();

      queueMicrotask(() => {
        void (async () => {
          const directory = path.join(root, "private", "elevation");
          const names = await readdir(directory);
          const requestName = names.find((name) =>
            /^request-[A-Za-z0-9_-]+\.json$/u.test(name),
          );
          if (!requestName) throw new Error("request fixture was not created");
          const requestPath = path.join(directory, requestName);
          const request = JSON.parse(await readFile(requestPath, "utf8")) as {
            nonce: string;
            command: string;
            responsePath: string;
          };
          expect(request.command).toBe("Write-Output 'SECRET_COMMAND_MARKER'");
          await writeFile(
            request.responsePath,
            JSON.stringify({
              version: 1,
              nonce: request.nonce,
              exitCode: 0,
              stdout: "elevated-ok\n",
              stderr: "",
              timedOut: false,
              cancelled: false,
            }),
            "utf8",
          );
          child.emit("close", 0);
        })().catch((error) => child.emit("error", error));
      });

      return child as never;
    }) as unknown as typeof spawn;

    const broker = new WindowsElevationBroker({
      brokerExecutablePath: brokerPath,
      privateDirectory: path.join(root, "private"),
      platform: "win32",
      powershellExecutable: "powershell.exe",
      spawnProcess,
    });

    const result = await broker.run({
      shell: "powershell",
      command: "Write-Output 'SECRET_COMMAND_MARKER'",
      absoluteCwd: root,
      logicalCwd: ".",
      timeoutMs: 30_000,
      deadline: createOperationDeadline(30_000),
    });

    expect(result).toMatchObject({
      status: "executed",
      exitCode: 0,
      stdout: "elevated-ok\n",
      timedOut: false,
    });
    expect(captured.file).toBe("powershell.exe");
    const encodedIndex = captured.args?.indexOf("-EncodedCommand") ?? -1;
    expect(encodedIndex).toBeGreaterThanOrEqual(0);
    const encoded = captured.args?.[encodedIndex + 1] ?? "";
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    expect(decoded).toContain("--request");
    expect(decoded).toContain("--sha256");
    expect(decoded).toContain("--nonce");
    expect(decoded).not.toContain("SECRET_COMMAND_MARKER");

    const leftovers = await readdir(path.join(root, "private", "elevation"));
    expect(leftovers).toEqual([]);
  });
});
