import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as iconv from "iconv-lite";
import { afterEach, describe, expect, test } from "@jest/globals";
import { LocalAgent } from "../../../src/index.js";
import {
  createFixture,
  makeWorkspacePolicy,
  type Fixture,
  writePolicy,
} from "../../support/helpers.js";

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("patch file", () => {
  test("returns read metadata and preserves Windows-1252 with CRLF", async () => {
    const { agent, absolutePath } = await createPatchFixture(
      "function teste() {\r\n  return \"ação\";\r\n}\r\n",
      "windows-1252",
    );

    const before = await agent.readFile({ workspaceId: "test", path: "legacy.js" });
    expect(before).toMatchObject({
      encoding: "windows-1252",
      lineEnding: "crlf",
      sha256: hash(await readFile(absolutePath)),
    });

    const dryRun = await agent.patchFile({
      workspaceId: "test",
      path: "legacy.js",
      expectedSha256: before.sha256,
      replacements: [
        {
          oldText: "function teste() {\n  return \"ação\";\n}",
          newText: "function teste() {\n  return \"alteração\";\n}",
        },
      ],
      dryRun: true,
    });
    expect(dryRun).toMatchObject({
      encoding: "windows-1252",
      lineEnding: "crlf",
      replacementsApplied: 1,
      changed: true,
      dryRun: true,
    });
    expect(iconv.decode(await readFile(absolutePath), "windows-1252")).toContain("ação");

    const result = await agent.patchFile({
      workspaceId: "test",
      path: "legacy.js",
      expectedSha256: before.sha256,
      replacements: [
        {
          oldText: "function teste() {\n  return \"ação\";\n}",
          newText: "function teste() {\n  return \"alteração\";\n}",
        },
      ],
    });

    const raw = await readFile(absolutePath);
    const decoded = iconv.decode(raw, "windows-1252");
    expect(decoded).toBe("function teste() {\r\n  return \"alteração\";\r\n}\r\n");
    expect(result).toMatchObject({
      sha256Before: before.sha256,
      sha256After: hash(raw),
      encoding: "windows-1252",
      lineEnding: "crlf",
      changed: true,
      dryRun: false,
    });
  }, 30_000);

  test("rejects stale hashes and replacement count mismatches", async () => {
    const { agent } = await createPatchFixture("alpha\nalpha\n", "utf-8");
    const current = await agent.readFile({ workspaceId: "test", path: "legacy.js" });

    await expect(
      agent.patchFile({
        workspaceId: "test",
        path: "legacy.js",
        expectedSha256: "0".repeat(64),
        replacements: [{ oldText: "alpha", newText: "beta", expectedCount: 2 }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    await expect(
      agent.patchFile({
        workspaceId: "test",
        path: "legacy.js",
        expectedSha256: current.sha256,
        replacements: [{ oldText: "alpha", newText: "beta", expectedCount: 1 }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  test("preserves a UTF-8 BOM", async () => {
    fixture = await createFixture({ profile: "full-repo-write", allowedRoots: ["."] });
    await writePolicy(fixture.policyPath, [
      {
        ...makeWorkspacePolicy(fixture.workspacePath, {
          profile: "full-repo-write",
          allowedRoots: ["."],
        }),
        allowWrites: ["."],
      },
    ]);
    const absolutePath = path.join(fixture.workspacePath, "bom.txt");
    await writeFile(absolutePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("before\n")]));
    const agent = await LocalAgent.create(fixture.policyPath);
    const before = await agent.readFile({ workspaceId: "test", path: "bom.txt" });

    await agent.patchFile({
      workspaceId: "test",
      path: "bom.txt",
      expectedSha256: before.sha256,
      replacements: [{ oldText: "before", newText: "after" }],
    });

    const raw = await readFile(absolutePath);
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.subarray(3).toString("utf8")).toBe("after\n");
  });
});

async function createPatchFixture(text: string, encoding: string) {
  fixture = await createFixture({ profile: "full-repo-write", allowedRoots: ["."] });
  await writePolicy(fixture.policyPath, [
    {
      ...makeWorkspacePolicy(fixture.workspacePath, {
        profile: "full-repo-write",
        allowedRoots: ["."],
      }),
      allowWrites: ["."],
    },
  ]);
  const absolutePath = path.join(fixture.workspacePath, "legacy.js");
  await writeFile(absolutePath, iconv.encode(text, encoding));
  return {
    agent: await LocalAgent.create(fixture.policyPath),
    absolutePath,
  };
}

function hash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
