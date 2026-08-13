import * as iconv from "iconv-lite";

export type ValidationTextEncoding =
  | "ascii"
  | "utf-8"
  | "utf-8-bom"
  | "utf-16le"
  | "utf-16be"
  | "windows-1252";

export type ValidationLineEnding = "lf" | "crlf" | "cr" | "mixed" | "none";

export interface ValidationTextFormat {
  encoding: ValidationTextEncoding;
  bom: boolean;
  bomBytes: number;
  lineEnding: ValidationLineEnding;
}

export function detectTextFormat(buffer: Buffer): ValidationTextFormat {
  let encoding: ValidationTextEncoding;
  let bomBytes = 0;

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    encoding = "utf-8-bom";
    bomBytes = 3;
  } else if (
    buffer.length >= 2 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xfe
  ) {
    encoding = "utf-16le";
    bomBytes = 2;
  } else if (
    buffer.length >= 2 &&
    buffer[0] === 0xfe &&
    buffer[1] === 0xff
  ) {
    encoding = "utf-16be";
    bomBytes = 2;
  } else if (buffer.every((byte) => byte < 0x80)) {
    encoding = "ascii";
  } else {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      encoding = "utf-8";
    } catch {
      encoding = "windows-1252";
    }
  }

  const text = decodeForInspection(buffer, encoding, bomBytes);
  return {
    encoding,
    bom: bomBytes > 0,
    bomBytes,
    lineEnding: detectLineEnding(text),
  };
}

export function decodeForInspection(
  buffer: Buffer,
  encoding: ValidationTextEncoding,
  bomBytes: number,
): string {
  const payload = buffer.subarray(bomBytes);
  switch (encoding) {
    case "utf-16le":
      return new TextDecoder("utf-16le").decode(payload);
    case "utf-16be":
      return new TextDecoder("utf-16be").decode(payload);
    case "windows-1252":
      return iconv.decode(payload, "windows-1252");
    default:
      return new TextDecoder("utf-8").decode(payload);
  }
}

export function hasUtf16Bom(buffer: Buffer): boolean {
  return (
    buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) ||
      (buffer[0] === 0xfe && buffer[1] === 0xff))
  );
}

export function lineAndColumn(
  text: string,
  offset: number,
): { line: number; column: number } {
  const prefix = text.slice(0, offset);
  const lines = prefix.split(/\r\n|\r|\n/);
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function detectLineEnding(text: string): ValidationLineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const withoutCrlf = text.replace(/\r\n/g, "");
  const lf = (withoutCrlf.match(/\n/g) ?? []).length;
  const cr = (withoutCrlf.match(/\r/g) ?? []).length;
  const styles = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;

  if (styles === 0) return "none";
  if (styles > 1) return "mixed";
  if (crlf > 0) return "crlf";
  if (lf > 0) return "lf";
  return "cr";
}
