const AUTHORIZATION_PATTERN = /^HMAC-SHA256 v1=(0|[1-9][0-9]{0,11})\.([0-9a-f]{64})$/u;
const MAX_TIMESTAMP_SKEW_SECONDS = 300;

export interface OperationHmacDescriptor {
  readonly domain: string;
  readonly path: string;
}

export async function verifyOperationHmac(
  request: Request,
  operationId: string,
  secret: string | undefined,
  descriptor: OperationHmacDescriptor,
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "POST") return false;
  if (typeof secret !== "string" || !/^[0-9a-f]{64}$/u.test(secret)) return false;
  if (!descriptor.domain || !descriptor.path.startsWith("/")) return false;

  const authorization = request.headers.get("authorization") ?? "";
  const match = AUTHORIZATION_PATTERN.exec(authorization);
  if (!match) return false;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.pathname !== descriptor.path) return false;

  const timestampText = match[1];
  const signatureHex = match[2];
  if (!timestampText || !signatureHex) return false;
  const timestamp = Number(timestampText);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return false;
  }

  const canonical = [
    descriptor.domain,
    "v1",
    request.method,
    descriptor.path,
    operationId,
    timestampText,
  ].join("\n");

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      asArrayBuffer(decodeHex(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      asArrayBuffer(decodeHex(signatureHex)),
      asArrayBuffer(new TextEncoder().encode(canonical)),
    );
  } catch {
    return false;
  }
}

function decodeHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
