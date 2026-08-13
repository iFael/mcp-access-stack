import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import { searchAuthorizedFiles } from "../../../src/filesystem/search.js";
import {
  createFixture,
  type Fixture,
  writeWorkspaceFile,
} from "../../support/helpers.js";

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("filesystem search", () => {
  test("searches authorized candidates, skips binary files and preserves truncation", async () => {
    fixture = await createFixture();
    await writeWorkspaceFile(
      fixture.workspacePath,
      "src/example.txt",
      "Alpha first\nsecond ALPHA\n",
    );
    await writeWorkspaceFile(
      fixture.workspacePath,
      "src/binary.bin",
      Buffer.from([0x00, 0x01, 0x02]),
    );

    const result = await searchAuthorizedFiles({
      files: [
        {
          logicalPath: "src/binary.bin",
          absolutePath: path.join(fixture.workspacePath, "src", "binary.bin"),
        },
        {
          logicalPath: "src/example.txt",
          absolutePath: path.join(fixture.workspacePath, "src", "example.txt"),
        },
      ],
      query: "alpha",
      caseSensitive: false,
      maxFileBytes: 64_000,
      maxSearchResults: 1,
      maxSearchSnippetBytes: 1_000,
      initialTruncated: false,
    });

    expect(result.skippedFiles).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.matches).toEqual([
      {
        path: "src/example.txt",
        line: 1,
        column: 1,
        snippet: "Alpha first",
      },
    ]);
  });

  test("preserves cancellation before reading candidates", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      searchAuthorizedFiles({
        files: [],
        query: "anything",
        caseSensitive: true,
        maxFileBytes: 64_000,
        maxSearchResults: 10,
        maxSearchSnippetBytes: 1_000,
        initialTruncated: false,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
  });
});
