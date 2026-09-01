import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SshWorkspaceExecutor } from "../../../src/remote/ssh-workspace-executor.js";
import type {
  RemoteBytesResult,
  RemoteDirectoryListing,
  RemoteProcessResult,
  RemoteWriteResult,
  SshWindowsTransport,
} from "../../../src/remote/ssh-windows-transport.js";

class FakeTransport {
  readonly files = new Map<string, Buffer>([
    ["README.md", Buffer.from("line one\nline two\n", "utf8")],
  ]);
  commands: Array<{ shell: string; command: string; cwd: string }> = [];

  async probeRoot() {
    return { fullPath: "C:\\workspace", kind: "directory" as const };
  }

  async list(): Promise<RemoteDirectoryListing> {
    return {
      entries: [...this.files.entries()].map(([filePath, value]) => ({
        path: filePath,
        kind: "file" as const,
        sizeBytes: value.byteLength,
      })),
      truncated: false,
    };
  }

  async readBytes(_root: string, logicalPath: string): Promise<RemoteBytesResult> {
    const value = this.files.get(logicalPath);
    if (!value) throw new Error("missing fake file");
    return {
      contentBase64: value.toString("base64"),
      sizeBytes: value.byteLength,
      sha256: sha256(value),
    };
  }

  async writeBytes(
    _root: string,
    logicalPath: string,
    value: Buffer,
    options: { expectedSha256?: string },
  ): Promise<RemoteWriteResult> {
    const before = this.files.get(logicalPath);
    if (before && options.expectedSha256 && sha256(before) !== options.expectedSha256) {
      throw new Error("hash mismatch");
    }
    this.files.set(logicalPath, Buffer.from(value));
    return { created: !before, sizeBytes: value.byteLength, sha256: sha256(value) };
  }

  async runShell(
    _root: string,
    cwd: string,
    shell: string,
    command: string,
  ): Promise<RemoteProcessResult> {
    this.commands.push({ shell, command, cwd });
    return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
  }

  async exec(): Promise<RemoteProcessResult> {
    return { exitCode: 0, stdout: "main\n", stderr: "", timedOut: false };
  }
}

describe("SshWorkspaceExecutor", () => {
  let stateDirectory: string;
  let transport: FakeTransport;
  let executor: SshWorkspaceExecutor;

  beforeEach(async () => {
    stateDirectory = await mkdtemp(path.join(os.tmpdir(), "mcp-ssh-executor-"));
    transport = new FakeTransport();
    executor = await SshWorkspaceExecutor.create({
      policy: {
        version: 1,
        workspaces: [
          {
            id: "test",
            name: "Test",
            rootPath: "C:\\workspace",
            workspaceKind: "repository",
            enabled: true,
            permissionProfile: "full-repo-write",
            confirmationMode: "standard",
            allowedRoots: ["."],
            blockedGlobs: ["private/**"],
            limits: {
              maxFileBytes: 64_000,
              maxSearchResults: 100,
              maxSearchSnippetBytes: 20_000,
              maxDiffBytes: 500_000,
              maxListedFiles: 500,
            },
            allowWrites: ["."],
            allowShell: ["."],
            allowedShells: ["powershell", "pwsh"],
          },
        ],
      },
      backgroundStateDirectory: stateDirectory,
      transport: transport as unknown as SshWindowsTransport,
    });
  });

  afterEach(async () => {
    await rm(stateDirectory, { recursive: true, force: true });
  });

  it("reads and writes through the SSH transport without changing MCP contracts", async () => {
    const read = await executor.readFile({ workspaceId: "test", path: "README.md" });
    expect(read).toMatchObject({
      path: "README.md",
      content: "line one\nline two\n",
      encoding: "utf-8",
    });

    const written = await executor.writeFile({
      workspaceId: "test",
      path: "src/new.txt",
      content: "remote\n",
    });
    expect(written).toMatchObject({ path: "src/new.txt", created: true });
    expect(transport.files.get("src/new.txt")?.toString("utf8")).toBe("remote\n");
  });

  it("keeps blocked paths server-side", async () => {
    await expect(
      executor.readFile({ workspaceId: "test", path: "private/secret.txt" }),
    ).rejects.toMatchObject({ code: "BLOCKED_PATH" });
  });

  it("requires confirmation before dispatching a destructive remote shell command", async () => {
    const first = await executor.runCommand({
      workspaceId: "test",
      shell: "powershell",
      command: "Remove-Item -LiteralPath .\\obsolete.txt",
      timeoutMs: 30_000,
    });
    expect(first.status).toBe("confirmation_required");
    expect(transport.commands).toHaveLength(0);
    if (first.status !== "confirmation_required") throw new Error("expected confirmation");

    const second = await executor.runCommand({
      workspaceId: "test",
      shell: "powershell",
      command: "Remove-Item -LiteralPath .\\obsolete.txt",
      timeoutMs: 30_000,
      confirmationId: first.confirmationId,
    });
    expect(second.status).toBe("executed");
    expect(transport.commands).toHaveLength(1);
  });

  it("fails closed for every typed source-control port without touching the SSH transport", async () => {
    const methods = [
      "createBranch",
      "stagePaths",
      "unstagePaths",
      "commit",
      "mergeBranch",
      "pushBranch",
      "getRepository",
      "createRepository",
      "getPullRequest",
      "createPullRequest",
      "mergePullRequest",
    ] as const;

    for (const method of methods) {
      await expect((executor as any)[method]({ workspaceId: "test" })).rejects.toMatchObject({
        code: "CAPABILITY_UNSUPPORTED",
      });
    }
    expect(transport.commands).toHaveLength(0);
  });
});

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
