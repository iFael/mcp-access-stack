import { describe, expect, test } from "@jest/globals";
import {
  parsePorcelainStatus,
  relativizeGitEntry,
} from "../../../src/git/status.js";

describe("git status parser", () => {
  test("parses modified, untracked and renamed porcelain entries", () => {
    const entries = parsePorcelainStatus(
      [
        " M nested/file.ts",
        "?? nested/new.txt",
        "R  nested/renamed.ts",
        "nested/original.ts",
        "",
      ].join("\0"),
    );

    expect(entries).toEqual([
      {
        path: "nested/file.ts",
        indexStatus: " ",
        workTreeStatus: "M",
        untracked: false,
      },
      {
        path: "nested/new.txt",
        indexStatus: "?",
        workTreeStatus: "?",
        untracked: true,
      },
      {
        path: "nested/renamed.ts",
        originalPath: "nested/original.ts",
        indexStatus: "R",
        workTreeStatus: " ",
        untracked: false,
      },
    ]);
  });

  test("relativizes entries to the selected Git root and rejects siblings", () => {
    const [entry] = parsePorcelainStatus(
      "R  nested\\renamed.ts\0nested\\original.ts\0",
    );
    expect(entry).toBeDefined();

    expect(relativizeGitEntry(entry!, "nested")).toEqual({
      repositoryPath: "nested/renamed.ts",
      status: {
        path: "renamed.ts",
        originalPath: "original.ts",
        indexStatus: "R",
        workTreeStatus: " ",
        untracked: false,
      },
    });
    expect(
      relativizeGitEntry(
        {
          path: "sibling/file.ts",
          indexStatus: " ",
          workTreeStatus: "M",
          untracked: false,
        },
        "nested",
      ),
    ).toBeUndefined();
  });
});
