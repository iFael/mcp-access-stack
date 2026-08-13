import { readFile, stat } from "node:fs/promises";
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

describe("write file", () => {
  test("creates and updates files when full-repo-write is enabled", async () => {
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
    const agent = await LocalAgent.create(fixture.policyPath);
    const targetPath = "notes/hello.txt";

    await expect(
      agent.writeFile({
        workspaceId: "test",
        path: targetPath,
        content: "first version",
      }),
    ).resolves.toEqual({
      path: targetPath,
      sizeBytes: Buffer.byteLength("first version", "utf8"),
      created: true,
    });

    await expect(
      agent.writeFile({
        workspaceId: "test",
        path: targetPath,
        content: "second version",
      }),
    ).resolves.toMatchObject({ created: false });

    const absolutePath = path.join(fixture.workspacePath, ...targetPath.split("/"));
    await expect(readFile(absolutePath, "utf8")).resolves.toBe("second version");
  });

  test("denies writes outside allowWrites", async () => {
    fixture = await createFixture({ profile: "planning-readonly" });
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.writeFile({
        workspaceId: "test",
        path: "src/new.txt",
        content: "blocked",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  test("denies writes to blocked paths", async () => {
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
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.writeFile({
        workspaceId: "test",
        path: ".env",
        content: "secret",
      }),
    ).rejects.toMatchObject({ code: "BLOCKED_PATH" });
  });

  test("overwrites existing file atomically", async () => {
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
    await writeWorkspaceFile(fixture.workspacePath, "existing.txt", "before");
    const agent = await LocalAgent.create(fixture.policyPath);

    await agent.writeFile({
      workspaceId: "test",
      path: "existing.txt",
      content: "after",
    });

    const absolutePath = path.join(fixture.workspacePath, "existing.txt");
    await expect(readFile(absolutePath, "utf8")).resolves.toBe("after");
    expect((await stat(absolutePath)).isFile()).toBe(true);
  });
});
