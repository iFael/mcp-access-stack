import { createHash } from "node:crypto";
import { link, lstat, open, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { LocalAgent } from "../../../src/index.js";
import { FileService } from "../../../src/filesystem/service.js";
import { WorkspaceRegistry } from "../../../src/workspace-registry.js";
import { PathSecurity } from "../../../src/path-security.js";
import {
  createFixture,
  defaultLimits,
  makeWorkspacePolicy,
  type Fixture,
  writePolicy,
  writeWorkspaceFile,
} from "../../support/helpers.js";

jest.setTimeout(45_000);
const nativeDeletion = process.platform === "linux" || process.platform === "win32";
let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

async function setup(options: { readonly?: boolean; blocked?: string[]; allowWrites?: string[]; maxDeleteFileBytes?: number } = {}) {
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
    ...(options.maxDeleteFileBytes === undefined ? {} : {
      limits: { ...defaultLimits, maxDeleteFileBytes: options.maxDeleteFileBytes },
    }),
    allowWrites: options.readonly ? [] : (options.allowWrites ?? ["."]),
  }]);
  await writeWorkspaceFile(fixture.workspacePath, "remove.txt", "expected");
  return { agent: await LocalAgent.create(fixture.policyPath), root: fixture.workspacePath };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const input = { workspaceId: "test", path: "remove.txt", expectedSha256: sha("expected") };
const noStaging = async (root: string) => {
  expect((await readdir(root)).filter((name) => name.startsWith(".mcp-delete-"))).toEqual([]);
};

describe("typed file deletion (pinned parent and staged inode validation)", () => {
  test("dry-run preserves the file, while Linux deletes only the SHA-matched inode", async () => {
    const { agent, root } = await setup();
    await expect(agent.deleteFile({ ...input, dryRun: true })).resolves.toEqual({
      path: "remove.txt", sha256Before: input.expectedSha256, deleted: false, dryRun: true,
    });
    if (nativeDeletion) {
      await expect(agent.deleteFile(input)).resolves.toEqual({
        path: "remove.txt", sha256Before: input.expectedSha256, deleted: true, dryRun: false,
      });
      await expect(lstat(path.join(root, "remove.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(agent.deleteFile(input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("expected");
    }
    await noStaging(root);
  });

  test("a separately configured deletion limit allows a larger file without expanding the read limit", async () => {
    const { agent, root } = await setup({ maxDeleteFileBytes: 512_000 });
    const content = "x".repeat(330_658);
    await writeWorkspaceFile(root, "remove.txt", content);
    const target = { ...input, expectedSha256: sha(content) };
    await expect(agent.readBinaryFile({ workspaceId: "test", path: "remove.txt" }))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(agent.deleteFile({ ...target, dryRun: true }))
      .resolves.toMatchObject({ deleted: false, sha256Before: target.expectedSha256 });
    await expect(agent.deleteFile({ ...target, dryRun: true, expectedSha256: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    if (nativeDeletion) {
      await expect(agent.deleteFile(target)).resolves.toMatchObject({ deleted: true });
      await expect(lstat(path.join(root, "remove.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(agent.deleteFile(target)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe(content);
    }
    await noStaging(root);
  });

  test("rejects a file larger than the explicitly configured deletion limit", async () => {
    const { agent, root } = await setup({ maxDeleteFileBytes: 3 });
    await expect(agent.deleteFile({ ...input, dryRun: true }))
      .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("expected");
    await noStaging(root);
  });

  test("rejects a policy exceeding the deletion limit ceiling", async () => {
    await expect(setup({ maxDeleteFileBytes: 64 * 1024 * 1024 + 1 }))
      .rejects.toMatchObject({ code: "POLICY_INVALID" });
  });

  test("the existing file limit still applies when no deletion limit is configured", async () => {
    const { agent, root } = await setup();
    const content = "x".repeat(64_001);
    await writeWorkspaceFile(root, "remove.txt", content);
    await expect(agent.deleteFile({ ...input, expectedSha256: sha(content), dryRun: true }))
      .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe(content);
  });

  test("dry-run refuses stale SHA and changed content without modifying bytes", async () => {
    const { agent, root } = await setup();
    await expect(agent.deleteFile({ ...input, dryRun: true, expectedSha256: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await writeWorkspaceFile(root, "remove.txt", "changed");
    await expect(agent.deleteFile({ ...input, dryRun: true }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("changed");
  });

  test("a stale SHA never deletes or stages the target", async () => {
    const { agent, root } = await setup();
    await writeWorkspaceFile(root, "remove.txt", "changed");
    await expect(agent.deleteFile(input)).rejects.toMatchObject({
      code: nativeDeletion ? "INVALID_ARGUMENT" : "PERMISSION_DENIED",
    });
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("changed");
    await noStaging(root);
  });

  test("rejects directories, traversal and symlink targets", async () => {
    const { agent, root } = await setup();
    await symlink(path.join(root, "remove.txt"), path.join(root, "link.txt"));
    await expect(agent.deleteFile({ ...input, dryRun: true, path: "link.txt" }))
      .rejects.toMatchObject({ code: "NOT_A_FILE" });
    await expect(agent.deleteFile({ ...input, path: "." }))
      .rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(agent.deleteFile({ ...input, path: "../remove.txt" }))
      .rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(lstat(path.join(root, "link.txt"))).resolves.toBeDefined();
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("expected");
  });

  test("retains workspace read-only policy", async () => {
    const { agent, root } = await setup({ readonly: true });
    await expect(agent.deleteFile(input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("expected");
  });

  test("retains blocked-glob policy even for dry-run", async () => {
    const { agent, root } = await setup({ blocked: ["remove.txt"] });
    await expect(agent.deleteFile({ ...input, dryRun: true }))
      .rejects.toMatchObject({ code: "BLOCKED_PATH" });
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("expected");
  });

  test("does not bypass allowWrites via a parent symlink", async () => {
    const { agent, root } = await setup({ allowWrites: ["alias"] });
    await writeWorkspaceFile(root, "protected.txt", "expected");
    await symlink(root, path.join(root, "alias"), "dir");
    await expect(agent.deleteFile({ ...input, path: "alias/protected.txt" }))
      .rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED" });
    await expect(readFile(path.join(root, "protected.txt"), "utf8"))
      .resolves.toBe("expected");
    await noStaging(root);
  });

  test("restricted allowWrites never creates staging at workspace root", async () => {
    const { agent, root } = await setup({ allowWrites: ["nested"] });
    await writeWorkspaceFile(root, "nested/remove.txt", "expected");
    await expect(agent.deleteFile({ ...input, path: "nested/remove.txt", dryRun: true }))
      .resolves.toMatchObject({ deleted: false, dryRun: true });
    if (nativeDeletion) {
      await expect(agent.deleteFile({ ...input, path: "nested/remove.txt" }))
        .resolves.toMatchObject({ deleted: true });
      await expect(lstat(path.join(root, "nested/remove.txt")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(agent.deleteFile({ ...input, path: "nested/remove.txt" }))
        .rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(readFile(path.join(root, "nested/remove.txt"), "utf8"))
        .resolves.toBe("expected");
    }
    await noStaging(root);
    await noStaging(path.join(root, "nested"));
  });

  test("ancestor redirect after authorization never moves or removes outside file", async () => {
    const { root } = await setup();
    await writeWorkspaceFile(root, "nested/remove.txt", "expected");
    await writeWorkspaceFile(fixture!.basePath, "remove.txt", "expected");
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    const original = PathSecurity.prototype.authorizeExisting;
    const spy = jest.spyOn(PathSecurity.prototype, "authorizeExisting")
      .mockImplementation(async function (this: PathSecurity, requested, kind, allowDot, operation) {
        const authorized = await original.call(this, requested, kind, allowDot, operation);
        if (requested === "nested/remove.txt") {
          await rename(path.join(root, "nested"), path.join(root, "nested-original"));
          await symlink(fixture!.basePath, path.join(root, "nested"), "dir");
        }
        return authorized;
      });
    try {
      if (nativeDeletion) {
        await expect(new FileService().deleteFile(workspace, { ...input, path: "nested/remove.txt" }))
          .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      } else {
        await expect(new FileService().deleteFile(workspace, { ...input, path: "nested/remove.txt" }))
          .rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      }
      await expect(readFile(path.join(fixture!.basePath, "remove.txt"), "utf8"))
        .resolves.toBe("expected");
      await expect(readFile(path.join(root, "nested-original", "remove.txt"), "utf8"))
        .resolves.toBe("expected");
      await noStaging(root);
    } finally {
      spy.mockRestore();
    }
  });

  test("dry-run rejects redirected ancestor after authorization", async () => {
    const { root } = await setup();
    await writeWorkspaceFile(root, "nested/remove.txt", "expected");
    await writeWorkspaceFile(fixture!.basePath, "remove.txt", "expected");
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    const original = PathSecurity.prototype.authorizeExisting;
    const spy = jest.spyOn(PathSecurity.prototype, "authorizeExisting")
      .mockImplementation(async function (this: PathSecurity, requested, kind, allowDot, operation) {
        const authorized = await original.call(this, requested, kind, allowDot, operation);
        if (requested === "nested/remove.txt") {
          await rename(path.join(root, "nested"), path.join(root, "nested-original"));
          await symlink(fixture!.basePath, path.join(root, "nested"), "dir");
        }
        return authorized;
      });
    try {
      await expect(new FileService().deleteFile(workspace, { ...input, path: "nested/remove.txt", dryRun: true }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(readFile(path.join(fixture!.basePath, "remove.txt"), "utf8"))
        .resolves.toBe("expected");
      await noStaging(root);
    } finally {
      spy.mockRestore();
    }
  });

  test("cannot move an external object at the former pre-rename injection point", async () => {
    const { root } = await setup();
    await writeWorkspaceFile(root, "nested/remove.txt", "expected");
    await writeWorkspaceFile(fixture!.basePath, "remove.txt", "expected");
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    if (nativeDeletion) {
      await expect(new FileService().deleteFile(workspace, { ...input, path: "nested/remove.txt" }))
        .resolves.toMatchObject({ deleted: true });
      await expect(lstat(path.join(root, "nested/remove.txt")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(new FileService().deleteFile(workspace, { ...input, path: "nested/remove.txt" }))
        .rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
    await expect(readFile(path.join(fixture!.basePath, "remove.txt"), "utf8"))
      .resolves.toBe("expected");
    await noStaging(root);
    await noStaging(path.join(root, "nested"));
  });

  test("staging-directory symlink swap cannot redirect destructive rename outside workspace", async () => {
    if (process.platform !== "linux") return;
    const { root } = await setup();
    await writeWorkspaceFile(fixture!.basePath, "remove.txt", "external");
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    const service = new FileService(undefined, async (directory) => {
      await rename(directory, directory + "-parked");
      await symlink(fixture!.basePath, directory, "dir");
      return open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    });
    await expect(service.deleteFile(workspace, input)).rejects.toThrow();
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("expected");
    await expect(readFile(path.join(fixture!.basePath, "remove.txt"), "utf8"))
      .resolves.toBe("external");
  });

  test("staging-directory relocation after opening its descriptor fails closed", async () => {
    if (process.platform !== "linux") return;
    const { root } = await setup();
    await writeWorkspaceFile(fixture!.basePath, "remove.txt", "external");
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    const service = new FileService(undefined, async (directory) => {
      const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await rename(directory, directory + "-parked");
      await symlink(fixture!.basePath, directory, "dir");
      return handle;
    });
    await expect(service.deleteFile(workspace, input)).rejects.toThrow();
    await expect(readFile(path.join(root, "remove.txt"), "utf8")).resolves.toBe("expected");
    await expect(readFile(path.join(fixture!.basePath, "remove.txt"), "utf8"))
      .resolves.toBe("external");
  });

  test("destructive mode rejects a replacement after opening the original inode", async () => {
    if (process.platform !== "linux") return;
    const { root } = await setup();
    const original = path.join(root, "remove.txt");
    const parked = path.join(root, "parked.txt");
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    const service = new FileService(async (target) => {
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      await rename(original, parked);
      await writeFile(original, "replacement");
      return handle;
    });
    await expect(service.deleteFile(workspace, input))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readFile(parked, "utf8")).resolves.toBe("expected");
    await expect(readFile(original, "utf8")).resolves.toBe("replacement");
    await noStaging(root);
  });

  test("dry-run binds SHA inspection to the opened file when its name is replaced", async () => {
    const { root } = await setup();
    const original = path.join(root, "remove.txt");
    const parked = path.join(root, "parked.txt");
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    const service = new FileService(async (target) => {
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      await rename(original, parked);
      await writeFile(original, "replacement");
      return handle;
    });
    await expect(service.deleteFile(workspace, { ...input, dryRun: true }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readFile(parked, "utf8")).resolves.toBe("expected");
    await expect(readFile(original, "utf8")).resolves.toBe("replacement");
    await noStaging(root);
  });

  test("dry-run rejects an ancestor redirected during the handle-open boundary", async () => {
    const { root } = await setup();
    await writeWorkspaceFile(root, "nested/remove.txt", "expected");
    await writeWorkspaceFile(fixture!.basePath, "remove.txt", "expected");
    const workspace = (await WorkspaceRegistry.load(fixture!.policyPath)).get("test");
    const service = new FileService(async (target) => {
      await rename(path.join(root, "nested"), path.join(root, "nested-original"));
      await symlink(fixture!.basePath, path.join(root, "nested"), "dir");
      return open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    });
    await expect(service.deleteFile(workspace, { ...input, path: "nested/remove.txt", dryRun: true }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readFile(path.join(fixture!.basePath, "remove.txt"), "utf8"))
      .resolves.toBe("expected");
    await expect(readFile(path.join(root, "nested-original", "remove.txt"), "utf8"))
      .resolves.toBe("expected");
    await noStaging(root);
  });

  test("Windows native deletion rejects a hardlinked file and preserves both names", async () => {
    if (process.platform !== "win32") return;
    const { agent, root } = await setup();
    const other = path.join(root, "hardlink.txt");
    await link(path.join(root, "remove.txt"), other);
    await expect(agent.deleteFile(input)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await readFile(other, "utf8")).toBe("expected");
    expect(await readFile(path.join(root, "remove.txt"), "utf8")).toBe("expected");
  });

  test("Windows native deletion treats apostrophes and Unicode as literal file names", async () => {
    if (process.platform !== "win32") return;
    const { agent, root } = await setup();
    const name = "arquivo d'água.txt";
    await writeWorkspaceFile(root, name, "expected");
    await expect(agent.deleteFile({ ...input, path: name })).resolves.toMatchObject({ deleted: true });
    await expect(lstat(path.join(root, name))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "remove.txt"), "utf8")).toBe("expected");
  });

  test("rejects existing symlink ancestor pointing outside workspace", async () => {
    const { agent, root } = await setup();
    await symlink(fixture!.basePath, path.join(root, "outside"));
    await writeWorkspaceFile(fixture!.basePath, "external.txt", "expected");
    await expect(agent.deleteFile({ ...input, path: "outside/external.txt" }))
      .rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    await expect(readFile(path.join(fixture!.basePath, "external.txt"), "utf8"))
      .resolves.toBe("expected");
  });
});
