import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { BrowserArtifactRegistry } from "../src/browser-artifact-registry.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
});

describe("browser artifact registry", () => {
  it("streams a private artifact by opaque id only to its owner, across bounded chunks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-artifact-test-"));
    roots.push(root);
    const privateDir = path.join(root, "private");
    await mkdir(privateDir);
    const file = path.join(privateDir, "demo.mp4");
    const original = Buffer.alloc(700_000, 0x41);
    await writeFile(file, original);
    const registry = new BrowserArtifactRegistry(privateDir);
    const id = await registry.register({
      path: file, ownerScope: "user:alice", mimeType: "video/mp4",
    });
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    const chunks = [];
    let offset = 0;
    while (offset < original.length) {
      const part = await registry.read({ artifactId: id!, ownerScope: "user:alice", offset });
      expect(part.offset).toBe(offset);
      expect(part.sizeBytes).toBe(original.length);
      expect(part.mimeType).toBe("video/mp4");
      expect(JSON.stringify(part)).not.toContain(privateDir);
      chunks.push(Buffer.from(part.contentBase64, "base64"));
      offset = part.nextOffset;
    }
    expect(chunks.length).toBe(2);
    expect(Buffer.concat(chunks)).toEqual(original);
    await expect(registry.read({ artifactId: id!, ownerScope: "user:bob", offset: 0 }))
      .rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    await expect(registry.read({ artifactId: id!, offset: 0 }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(registry.read({ artifactId: id!, ownerScope: "user:alice", offset: original.length }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("does not register anonymous files or follow a link outside the private directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "browser-artifact-test-"));
    roots.push(root);
    const privateDir = path.join(root, "private");
    await mkdir(privateDir);
    const outside = path.join(root, "outside.gif");
    await writeFile(outside, "GIF89a");
    const registry = new BrowserArtifactRegistry(privateDir);
    expect(await registry.register({ path: outside, mimeType: "image/gif" })).toBeUndefined();
    await expect(registry.register({
      path: outside, ownerScope: "user:alice", mimeType: "image/gif",
    })).rejects.toMatchObject({ code: "BLOCKED_PATH" });
    await symlink(outside, path.join(privateDir, "symlink.gif"));
    await expect(registry.register({
      path: path.join(privateDir, "symlink.gif"),
      ownerScope: "user:alice", mimeType: "image/gif",
    })).rejects.toMatchObject({ code: "BLOCKED_PATH" });
  });
});
