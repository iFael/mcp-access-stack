import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { LocalAgent } from "../../../src/index.js";
import { FileService } from "../../../src/filesystem/service.js";
import { WorkspaceRegistry } from "../../../src/workspace-registry.js";
import { PathSecurity } from "../../../src/path-security.js";
import {
  createFixture,
  makeWorkspacePolicy,
  type Fixture,
  writePolicy,
  writeWorkspaceFile,
} from "../../support/helpers.js";

let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

async function setup(options: { readonly?: boolean; blocked?: string[]; allowWrites?: string[] } = {}) {
  fixture = await createFixture({
    profile: options.readonly ? "planning-readonly" : "full-repo-write",
    allowedRoots: ["."],
    blockedGlobs: options.blocked ?? [],
  });
  await writePolicy(fixture.policyPath, [{
    ...makeWorkspacePolicy(fixture.workspacePath, {
      profile: options.readonly ? "planning-readonly" : "full-repo-write",
      allowedRoots: ["."],
      blockedGlobs: options.blocked ?? [],
    }),
    allowWrites: options.readonly ? [] : (options.allowWrites ?? ["."]),
  }]);
  await writeWorkspaceFile(fixture.workspacePath, "remove.txt", "expected");
  return { agent: await LocalAgent.create(fixture.policyPath), root: fixture.workspacePath };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const input = { workspaceId: "test", path: "remove.txt", expectedSha256: sha("expected") };

describe("typed file deletion", () => {
  test("dry-run validates without deleting and the exact file is deleted once", async () => {
    const { agent, root } = await setup();
    await expect(agent.deleteFile({ ...input, dryRun: true })).resolves.toEqual({
      path: "remove.txt", sha256Before: input.expectedSha256, deleted: false, dryRun: true,
    });
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("expected");
    await expect(agent.deleteFile(input)).resolves.toEqual({
      path: "remove.txt", sha256Before: input.expectedSha256, deleted: true, dryRun: false,
    });
    await expect(readFile(path.join(root, "remove.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(agent.deleteFile(input)).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  test("never deletes when SHA is stale or content changed", async () => {
    const { agent, root } = await setup();
    await expect(agent.deleteFile({ ...input, expectedSha256: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await writeWorkspaceFile(root, "remove.txt", "changed");
    await expect(agent.deleteFile(input)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("changed");
  });

  test("rejects directories, path traversal and symlinks to files inside the workspace", async () => {
    const { agent, root } = await setup();
    await symlink(path.join(root, "remove.txt"), path.join(root, "link.txt"));
    await expect(agent.deleteFile({ ...input, path: "link.txt" }))
      .rejects.toMatchObject({ code: "NOT_A_FILE" });
    await expect(agent.deleteFile({ ...input, path: "." }))
      .rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(agent.deleteFile({ ...input, path: "../remove.txt" }))
      .rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(lstat(path.join(root, "link.txt"))).resolves.toBeDefined();
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("expected");
  });

  test("denies write when workspace policy is read-only", async () => {
    const { agent, root } = await setup({ readonly: true });
    await expect(agent.deleteFile(input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("expected");
  });

  test("denies blocked paths even if SHA is valid", async () => {
    const { agent, root } = await setup({ blocked: ["remove.txt"] });
    await expect(agent.deleteFile(input)).rejects.toMatchObject({ code: "BLOCKED_PATH" });
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("expected");
  });

  test("does not bypass allowWrites through a parent symlink inside workspace", async () => {
    const { agent, root } = await setup({ allowWrites: ["alias"] });
    await writeWorkspaceFile(root, "protected.txt", "expected");
    await symlink(root, path.join(root, "alias"), "dir");
    await expect(agent.deleteFile({ ...input, path: "alias/protected.txt" }))
      .rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED" });
    await expect(readFile(path.join(root, "protected.txt"), "utf8"))
      .resolves.toBe("expected");
  });

  test("preserves a replacement made immediately before quarantining", async () => {
    const { root } = await setup();
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    const service = new FileService({
      rename: async (source, destination) => {
        await writeFile(source, "replacement");
        await rename(source, destination);
      },
      unlink,
    });
    await expect(service.deleteFile(workspace, input))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("replacement");
    expect((await readdir(root)).filter((name) => name.startsWith(".mcp-delete-"))).toEqual([]);
  });

  test("deletes only the captured object if the source path is recreated after relocation", async () => {
    const { root } = await setup();
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    const service = new FileService({
      rename: async (source, destination) => {
        await rename(source, destination);
        await writeFile(source, "new occupant");
      },
      unlink,
    });
    await expect(service.deleteFile(workspace, input)).resolves.toMatchObject({
      deleted: true, sha256Before: input.expectedSha256,
    });
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("new occupant");
    expect((await readdir(root)).filter((name) => name.startsWith(".mcp-delete-"))).toEqual([]);
  });

  test("retains staged bytes for reconciliation rather than clobbering a concurrent occupant", async () => {
    const { root } = await setup();
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    const service = new FileService({
      rename: async (source, destination) => {
        await writeFile(source, "replacement");
        await rename(source, destination);
        await writeFile(source, "new occupant");
      },
      unlink,
    });
    await expect(service.deleteFile(workspace, input))
      .rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN", details: { operation: "delete_file", outcome: "unknown", retryable: false } });
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("new occupant");
    const stagedDirectories = (await readdir(root)).filter((name) => name.startsWith(".mcp-delete-"));
    expect(stagedDirectories).toHaveLength(1);
    await expect(readFile(path.join(root, stagedDirectories[0]!, "target"), "utf8"))
      .resolves.toBe("replacement");
  });

  test("rejects a changed staged object and restores it without deleting its contents", async () => {
    const { root } = await setup();
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    const service = new FileService({
      rename: async (source, destination) => {
        await rename(source, destination);
        await writeFile(destination, "changed after isolation");
      },
      unlink,
    });
    await expect(service.deleteFile(workspace, input))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readFile(path.join(root, "remove.txt"), "utf8"))
      .resolves.toBe("changed after isolation");
    expect((await readdir(root)).filter((name) => name.startsWith(".mcp-delete-"))).toEqual([]);
  });

  test("reports an uncertain outcome when staging cleanup cannot finish", async () => {
    const { root } = await setup();
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    const service = new FileService({
      rename: async (source, destination) => {
        await rename(source, destination);
        await writeFile(path.join(path.dirname(String(destination)), "concurrent-entry"), "keep");
      },
      unlink,
    });
    await expect(service.deleteFile(workspace, input))
      .rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN", details: { outcome: "unknown", retryable: false } });
    await expect(readFile(path.join(root, "remove.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const stage = (await readdir(root)).filter((name) => name.startsWith(".mcp-delete-"));
    expect(stage).toHaveLength(1);
    await expect(readFile(path.join(root, stage[0]!, "concurrent-entry"), "utf8")).resolves.toBe("keep");
  });

  test("rejects ancestor redirect to an outside file immediately after authorization", async () => {
    const { root } = await setup();
    await writeWorkspaceFile(root, "nested/remove.txt", "expected");
    await writeWorkspaceFile(fixture!.basePath, "remove.txt", "expected");
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    const original = PathSecurity.prototype.authorizeExisting;
    const intercepted = jest.spyOn(PathSecurity.prototype, "authorizeExisting")
      .mockImplementation(async function (this: PathSecurity, requested, kind, allowDot, operation) {
        const authorized = await original.call(this, requested, kind, allowDot, operation);
        if (requested === "nested/remove.txt") {
          await rename(path.join(root, "nested"), path.join(root, "nested-original"));
          await symlink(fixture!.basePath, path.join(root, "nested"), "dir");
        }
        return authorized;
      });
    try {
      await expect(new FileService().deleteFile(workspace, { ...input, path: "nested/remove.txt" }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(readFile(path.join(fixture!.basePath, "remove.txt"), "utf8"))
        .resolves.toBe("expected");
      await expect(readFile(path.join(root, "nested-original", "remove.txt"), "utf8"))
        .resolves.toBe("expected");
    } finally {
      intercepted.mockRestore();
    }
  });

  test("rejects ancestor redirect after staging without moving any external file", async () => {
    const { root } = await setup();
    await writeWorkspaceFile(root, "nested/remove.txt", "expected");
    await writeWorkspaceFile(fixture!.basePath, "remove.txt", "expected");
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    const service = new FileService({
      rename,
      unlink,
      mkdtemp: async (prefix) => {
        const staging = await mkdtemp(prefix);
        await rename(path.join(root, "nested"), path.join(root, "nested-original"));
        await symlink(fixture!.basePath, path.join(root, "nested"), "dir");
        return staging;
      },
    });
    await expect(service.deleteFile(workspace, { ...input, path: "nested/remove.txt" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readFile(path.join(fixture!.basePath, "remove.txt"), "utf8"))
      .resolves.toBe("expected");
    await expect(readFile(path.join(root, "nested-original", "remove.txt"), "utf8"))
      .resolves.toBe("expected");
    expect((await readdir(root)).filter((name) => name.startsWith(".mcp-delete-"))).toEqual([]);
  });

  test("denies deletion through symlinked parent outside workspace", async () => {
    const { agent, root } = await setup();
    await symlink(fixture!.basePath, path.join(root, "outside"));
    await writeWorkspaceFile(fixture!.basePath, "external.txt", "expected");
    await expect(agent.deleteFile({ ...input, path: "outside/external.txt" }))
      .rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    await expect(readFile(path.join(fixture!.basePath, "external.txt"), "utf8"))
      .resolves.toBe("expected");
  });
});
