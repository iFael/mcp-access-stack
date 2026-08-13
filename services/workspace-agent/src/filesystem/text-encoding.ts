export interface DecodedText {
  text: string;
  encoding: string;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const windows1252 = new TextDecoder("windows-1252");
const latin1 = new TextDecoder("latin1");

function decodeWith(label: string, buffer: Buffer): string {
  return new TextDecoder(label).decode(buffer);
}

function tryUtf8Strict(buffer: Buffer): string | null {
  try {
    return utf8Strict.decode(buffer);
  } catch {
    return null;
  }
}

export function decodeBufferToText(buffer: Buffer): DecodedText {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: decodeWith("utf-8", buffer.subarray(3)), encoding: "utf-8" };
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: decodeWith("utf-16le", buffer.subarray(2)), encoding: "utf-16le" };
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: decodeWith("utf-16be", buffer.subarray(2)), encoding: "utf-16be" };
  }

  const utf8 = tryUtf8Strict(buffer);
  if (utf8 !== null) {
    return { text: utf8, encoding: "utf-8" };
  }

  try {
    return { text: windows1252.decode(buffer), encoding: "windows-1252" };
  } catch {
    return { text: latin1.decode(buffer), encoding: "latin1" };
  }
}
