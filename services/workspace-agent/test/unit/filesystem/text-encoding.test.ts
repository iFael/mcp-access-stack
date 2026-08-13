import { describe, expect, test } from "@jest/globals";
import { decodeBufferToText } from "../../../src/filesystem/text-encoding.js";

describe("decodeBufferToText", () => {
  test("decodes UTF-8 with BOM", () => {
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello", "utf8")]);
    expect(decodeBufferToText(buffer)).toEqual({ text: "hello", encoding: "utf-8" });
  });

  test("decodes plain UTF-8", () => {
    const buffer = Buffer.from("função", "utf8");
    expect(decodeBufferToText(buffer)).toEqual({ text: "função", encoding: "utf-8" });
  });

  test("decodes UTF-16 LE with BOM", () => {
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("ab", "utf16le")]);
    expect(decodeBufferToText(buffer)).toEqual({ text: "ab", encoding: "utf-16le" });
  });

  test("decodes UTF-16 BE with BOM", () => {
    const buffer = Buffer.from([0xfe, 0xff, 0x00, 0x61, 0x00, 0x62]);
    expect(decodeBufferToText(buffer)).toEqual({ text: "ab", encoding: "utf-16be" });
  });

  test("falls back to windows-1252 for invalid UTF-8", () => {
    const buffer = Buffer.from([0xe7, 0xe3, 0x6f]);
    expect(decodeBufferToText(buffer)).toEqual({ text: "ção", encoding: "windows-1252" });
  });

  test("decodes invalid UTF-8 sequences via windows-1252", () => {
    const buffer = Buffer.from([0xc3, 0x28]);
    expect(decodeBufferToText(buffer)).toEqual({ text: "Ã(", encoding: "windows-1252" });
  });
});
