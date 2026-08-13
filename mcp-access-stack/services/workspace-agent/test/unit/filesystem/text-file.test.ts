import { describe, expect, test } from "@jest/globals";
import {
  countOccurrences,
  detectLineEnding,
  encodeTextPreservingFormat,
  hashBuffer,
  normalizeReplacementLineEndings,
} from "../../../src/filesystem/text-file.js";

describe("filesystem text-file", () => {
  test("detects line endings and normalizes replacements to the original format", () => {
    expect(detectLineEnding("first\r\nsecond\r\n")).toBe("crlf");
    expect(detectLineEnding("first\nsecond\r\n")).toBe("mixed");
    expect(normalizeReplacementLineEndings("one\ntwo", "crlf")).toBe("one\r\ntwo");
    expect(normalizeReplacementLineEndings("one\r\ntwo", "lf")).toBe("one\ntwo");
  });

  test("preserves BOM and rejects content that cannot round-trip in the source encoding", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const encoded = encodeTextPreservingFormat("ação", "utf-8", bom);

    expect(encoded.subarray(0, bom.byteLength)).toEqual(bom);
    expect(encoded.subarray(bom.byteLength).toString("utf8")).toBe("ação");
    expect(() =>
      encodeTextPreservingFormat("emoji 😀", "windows-1252", Buffer.alloc(0)),
    ).toThrow(/cannot be represented safely/i);
  });

  test("counts replacements and hashes the exact bytes", () => {
    expect(countOccurrences("one two one", "one")).toBe(2);
    expect(hashBuffer(Buffer.from("content", "utf8"))).toBe(
      "ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73",
    );
  });
});
