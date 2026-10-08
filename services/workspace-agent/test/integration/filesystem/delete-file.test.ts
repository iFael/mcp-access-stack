import { createHash } from "node:crypto";
import { lstat, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import { LocalAgent } from "../../../src/index.js";
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
