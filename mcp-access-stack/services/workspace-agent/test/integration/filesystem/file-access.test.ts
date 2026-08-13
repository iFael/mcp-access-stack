import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import { LocalAgent } from "../../../src/index.js";
import {
  createFixture,
  type Fixture,
  makeWorkspacePolicy,
  writePolicy,
  writeWorkspaceFile,
} from "../../support/helpers.js";

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("file access", () => {
  test("reads UTF-8 files and line ranges", async () => {
    fixture = await createFixture({ allowedRoots: ["src"] });
    await writeWorkspaceFile(fixture.workspacePath, "src/file.txt", "one\ntwo\nthree");
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.readFile({
        workspaceId: "test",
        path: "src/file.txt",
        startLine: 2,
        endLine: 3,
      }),
    ).resolves.toEqual({
      path: "src/file.txt",
      content: "two\nthree",
      startLine: 2,
      endLine: 3,
      totalLines: 3,
      sizeBytes: 13,
      sha256: "058053d87c818d699cde0f00d670bca0e1c6ad857caa9758ea6a556d7c64fcee",
      encoding: "utf-8",
      lineEnding: "lf",
    });
  });

  test("reads authorized files as exact base64 for browser uploads", async () => {
    fixture = await createFixture({ allowedRoots: ["src"] });
    await writeWorkspaceFile(fixture.workspacePath, "src/upload.bin", Buffer.from([0, 1, 2, 255]));
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.readBinaryFile({ workspaceId: "test", path: "src/upload.bin" }),
    ).resolves.toEqual({
      path: "src/upload.bin",
      contentBase64: "AAEC/w==",
      sizeBytes: 4,
      sha256: "3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56",
    });
  });

  test("lists allowed files in stable order without blocked paths", async () => {
    fixture = await createFixture({ allowedRoots: ["src"] });
    await writeWorkspaceFile(fixture.workspacePath, "src/z.txt", "z");
    await writeWorkspaceFile(fixture.workspacePath, "src/a.ts", "a");
    await writeWorkspaceFile(fixture.workspacePath, "src/.env", "secret");
    await writeWorkspaceFile(fixture.workspacePath, "outside.txt", "outside");
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.listFiles({ workspaceId: "test", glob: "**/*.txt" }),
    ).resolves.toEqual({ files: ["src/z.txt"], truncated: false });
  });

  test("performs literal case-aware and case-insensitive search", async () => {
    fixture = await createFixture();
    await writeWorkspaceFile(
      fixture.workspacePath,
      "code.ts",
      "const value = 'Needle.*';\nconst lower = 'needle.*';",
    );
    const agent = await LocalAgent.create(fixture.policyPath);

    const insensitive = await agent.searchFiles({
      workspaceId: "test",
      query: "needle.*",
    });
    expect(insensitive.matches).toHaveLength(2);

    const sensitive = await agent.searchFiles({
      workspaceId: "test",
      query: "Needle.*",
      caseSensitive: true,
    });
    expect(sensitive.matches).toEqual([
      {
        path: "code.ts",
        line: 1,
        column: 16,
        snippet: "const value = 'Needle.*';",
      },
    ]);
  });

  test.each(["../outside.txt", "..\\outside.txt", "C:\\outside.txt", "\\\\server\\share\\file.txt"])(
    "blocks unsafe path %s",
    async (unsafePath) => {
      fixture = await createFixture();
      const agent = await LocalAgent.create(fixture.policyPath);

      await expect(
        agent.readFile({ workspaceId: "test", path: unsafePath }),
      ).rejects.toMatchObject({ code: "INVALID_PATH" });
    },
  );

  test("blocks sensitive files and paths outside allowed roots", async () => {
    fixture = await createFixture({ allowedRoots: ["src"] });
    await writeWorkspaceFile(fixture.workspacePath, "src/.env", "secret");
    await writeWorkspaceFile(fixture.workspacePath, "outside.txt", "outside");
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.readFile({ workspaceId: "test", path: "src/.env" }),
    ).rejects.toMatchObject({ code: "BLOCKED_PATH" });
    await expect(
      agent.readFile({ workspaceId: "test", path: "outside.txt" }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
  });

  test("blocks .runtime-private from listing, reading, searching, and writing", async () => {
    fixture = await createFixture({
      profile: "full-repo-write",
      allowedRoots: ["."],
    });
    await writePolicy(fixture.policyPath, [
      {
        ...makeWorkspacePolicy(fixture.workspacePath, {
          profile: "full-repo-write",
          allowedRoots: ["."],
        }),
        allowWrites: ["."],
      },
    ]);
    await writeWorkspaceFile(
      fixture.workspacePath,
      ".runtime-private/secret.json",
      "private-marker",
    );
    await writeWorkspaceFile(fixture.workspacePath, "public.txt", "public-marker");
    const agent = await LocalAgent.create(fixture.policyPath);

    const listing = await agent.listFiles({ workspaceId: "test" });
    expect(listing.files).toContain("public.txt");
    expect(listing.files.some((file) => file.startsWith(".runtime-private/"))).toBe(false);

    await expect(
      agent.readFile({
        workspaceId: "test",
        path: ".runtime-private/secret.json",
      }),
    ).rejects.toMatchObject({ code: "BLOCKED_PATH" });

    await expect(
      agent.searchFiles({
        workspaceId: "test",
        query: "private-marker",
      }),
    ).resolves.toMatchObject({ matches: [] });

    await expect(
      agent.writeFile({
        workspaceId: "test",
        path: ".runtime-private/new.txt",
        content: "blocked",
      }),
    ).rejects.toMatchObject({ code: "BLOCKED_PATH" });
  });

  test("treats an allowed root file as an exact path", async () => {
    fixture = await createFixture({ allowedRoots: ["allowed.txt"] });
    await writeWorkspaceFile(fixture.workspacePath, "allowed.txt", "allowed");
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.readFile({ workspaceId: "test", path: "allowed.txt" }),
    ).resolves.toMatchObject({ content: "allowed" });
    await expect(
      agent.readFile({ workspaceId: "test", path: "allowed.txt/child" }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_ALLOWED_ROOTS" });
  });

  test("reads Windows-1252/ANSI files with accented characters", async () => {
    fixture = await createFixture();
    const ansiContent = Buffer.from("fun\u00e7\u00e3o n\u00e3o", "latin1");
    await writeWorkspaceFile(fixture.workspacePath, "ansi.txt", ansiContent);
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.readFile({ workspaceId: "test", path: "ansi.txt" }),
    ).resolves.toMatchObject({ content: "função não" });
  });

  test("reads ANSI byte 0xE7 as ç in cp1252", async () => {
    fixture = await createFixture();
    await writeWorkspaceFile(fixture.workspacePath, "cp1252.txt", Buffer.from([0x63, 0x61, 0x72, 0x61, 0x63, 0x74, 0x65, 0x72, 0x20, 0xe7]));
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.readFile({ workspaceId: "test", path: "cp1252.txt" }),
    ).resolves.toMatchObject({ content: "caracter ç" });
  });

  test("searches ANSI-encoded files instead of skipping them", async () => {
    fixture = await createFixture();
    const ansiContent = Buffer.from("const label = 'configura\u00e7\u00e3o';", "latin1");
    await writeWorkspaceFile(fixture.workspacePath, "legacy.js", ansiContent);
    const agent = await LocalAgent.create(fixture.policyPath);

    const search = await agent.searchFiles({
      workspaceId: "test",
      query: "configuração",
    });
    expect(search.skippedFiles).toBe(0);
    expect(search.matches).toEqual([
      {
        path: "legacy.js",
        line: 1,
        column: 16,
        snippet: "const label = 'configuração';",
      },
    ]);
  });

  test("rejects oversized and binary files", async () => {
    fixture = await createFixture({ limits: { maxFileBytes: 4 } });
    await writeWorkspaceFile(fixture.workspacePath, "large.txt", "12345");
    await writeWorkspaceFile(fixture.workspacePath, "binary.bin", Buffer.from([65, 0, 66]));
    await writeWorkspaceFile(fixture.workspacePath, "invalid.txt", Buffer.from([0xc3, 0x28]));
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.readFile({ workspaceId: "test", path: "large.txt" }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(
      agent.readFile({ workspaceId: "test", path: "binary.bin" }),
    ).rejects.toMatchObject({ code: "BINARY_FILE" });
    await expect(
      agent.readFile({ workspaceId: "test", path: "invalid.txt" }),
    ).resolves.toMatchObject({ content: "Ã(" });
  });

  test("applies list, search result and snippet limits", async () => {
    fixture = await createFixture({
      limits: {
        maxListedFiles: 2,
        maxSearchResults: 1,
        maxSearchSnippetBytes: 5,
      },
    });
    await writeWorkspaceFile(fixture.workspacePath, "a.txt", "needle-long-line");
    await writeWorkspaceFile(fixture.workspacePath, "b.txt", "needle-second");
    await writeWorkspaceFile(fixture.workspacePath, "c.txt", "third");
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(agent.listFiles({ workspaceId: "test" })).resolves.toEqual({
      files: ["a.txt", "b.txt"],
      truncated: true,
    });
    const search = await agent.searchFiles({ workspaceId: "test", query: "needle" });
    expect(search).toMatchObject({ truncated: true, skippedFiles: 0 });
    expect(search.matches).toEqual([
      { path: "a.txt", line: 1, column: 1, snippet: "needl" },
    ]);
  });

  test("allows internal junction reads, blocks external junction reads, and never lists through them", async () => {
    fixture = await createFixture();
    const internalTarget = path.join(fixture.workspacePath, "internal-target");
    const externalTarget = path.join(fixture.basePath, "external-target");
    await mkdir(internalTarget);
    await mkdir(externalTarget);
    await writeWorkspaceFile(fixture.workspacePath, "internal-target/file.txt", "inside");
    await writeWorkspaceFile(fixture.basePath, "external-target/file.txt", "outside");
    await symlink(internalTarget, path.join(fixture.workspacePath, "internal-link"), "junction");
    await symlink(externalTarget, path.join(fixture.workspacePath, "external-link"), "junction");
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.readFile({ workspaceId: "test", path: "internal-link/file.txt" }),
    ).resolves.toMatchObject({ content: "inside" });
    await expect(
      agent.readFile({ workspaceId: "test", path: "external-link/file.txt" }),
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });

    const listing = await agent.listFiles({ workspaceId: "test" });
    expect(listing.files).toContain("internal-target/file.txt");
    expect(listing.files.some((file) => file.startsWith("internal-link/"))).toBe(false);
    expect(listing.files.some((file) => file.startsWith("external-link/"))).toBe(false);
  });

  (process.platform === "win32" ? test : test.skip)(
    "handles allowed root casing and rejects Windows ADS/trailing segments",
    async () => {
      fixture = await createFixture({ allowedRoots: ["SRC"] });
      await writeWorkspaceFile(fixture.workspacePath, "SRC/file.txt", "content");
      const agent = await LocalAgent.create(fixture.policyPath);

      await expect(
        agent.readFile({ workspaceId: "test", path: "src/file.txt" }),
      ).resolves.toMatchObject({ content: "content" });
      await expect(
        agent.readFile({ workspaceId: "test", path: "SRC/file.txt:stream" }),
      ).rejects.toMatchObject({ code: "INVALID_PATH" });
      await expect(
        agent.readFile({ workspaceId: "test", path: "SRC/file.txt. " }),
      ).rejects.toMatchObject({ code: "INVALID_PATH" });
    },
  );
});
