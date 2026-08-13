import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  type LineEnding,
  type TextEncoding,
} from "@vs-code-gpt/shared";
import * as iconv from "iconv-lite";
import { decodeBufferToText } from "./text-encoding.js";

export interface TextFileContents {
  text: string;
  sizeBytes: number;
  sha256: string;
  encoding: TextEncoding;
  lineEnding: LineEnding;
  bom: Buffer;
}

export async function readTextFile(
  absolutePath: string,
  maxFileBytes: number,
): Promise<TextFileContents> {
  const fileStat = await stat(absolutePath);
  if (fileStat.size > maxFileBytes) {
    throw new AppError("FILE_TOO_LARGE", "File exceeds the configured size limit.");
  }

  const buffer = await readFile(absolutePath);
  if (buffer.includes(0) && !hasUtf16Bom(buffer)) {
    throw new AppError("BINARY_FILE", "Binary files are not supported.");
  }

  const decoded = decodeBufferToText(buffer);
  return {
    text: decoded.text,
    sizeBytes: buffer.byteLength,
    sha256: hashBuffer(buffer),
    encoding: decoded.encoding as TextEncoding,
    lineEnding: detectLineEnding(decoded.text),
    bom: readBom(buffer),
  };
}

export async function atomicWriteBuffer(
  absolutePath: string,
  content: Buffer,
): Promise<void> {
  const parentDirectory = path.dirname(absolutePath);
  const tempPath = path.join(
    parentDirectory,
    `.vs-code-gpt-${randomBytes(8).toString("hex")}.tmp`,
  );

  try {
    await writeFile(tempPath, content);
    await rename(tempPath, absolutePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const withoutCrlf = text.replace(/\r\n/g, "");
  const lf = (withoutCrlf.match(/\n/g) ?? []).length;
  const cr = (withoutCrlf.match(/\r/g) ?? []).length;
  const kinds = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0);
  if (kinds === 0) return "none";
  if (kinds > 1) return "mixed";
  if (crlf > 0) return "crlf";
  if (lf > 0) return "lf";
  return "cr";
}

export function normalizeReplacementLineEndings(
  value: string,
  lineEnding: LineEnding,
): string {
  if (lineEnding === "mixed" || lineEnding === "none") return value;
  const normalized = value.replace(/\r\n|\r|\n/g, "\n");
  if (lineEnding === "crlf") return normalized.replace(/\n/g, "\r\n");
  if (lineEnding === "cr") return normalized.replace(/\n/g, "\r");
  return normalized;
}

export function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= value.length - needle.length) {
    const index = value.indexOf(needle, offset);
    if (index === -1) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

export function encodeTextPreservingFormat(
  text: string,
  encoding: TextEncoding,
  bom: Buffer,
): Buffer {
  const iconvEncoding = encoding === "latin1" ? "latin1" : encoding;
  const encoded = iconv.encode(text, iconvEncoding);
  const roundTrip = iconv.decode(encoded, iconvEncoding);
  if (roundTrip !== text) {
    throw new AppError(
      "INVALID_ARGUMENT",
      `Patched content cannot be represented safely as ${encoding}.`,
    );
  }
  return bom.byteLength === 0 ? encoded : Buffer.concat([bom, encoded]);
}

function hasUtf16Bom(buffer: Buffer): boolean {
  return (
    buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) ||
      (buffer[0] === 0xfe && buffer[1] === 0xff))
  );
}

function readBom(buffer: Buffer): Buffer {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return Buffer.from([0xef, 0xbb, 0xbf]);
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return Buffer.from([0xff, 0xfe]);
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return Buffer.from([0xfe, 0xff]);
  }
  return Buffer.alloc(0);
}
