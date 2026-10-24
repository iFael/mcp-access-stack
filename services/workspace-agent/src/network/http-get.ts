import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import {
  AppError,
  abortSignalError,
  httpGetInputSchema,
  httpGetResultSchema,
  type HttpGetInput,
  type HttpGetResult,
  type OperationContext,
} from "@vs-code-gpt/shared";

const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".corp"];

// Everything that is not routable on the public internet. One list per family:
// BlockList matches IPv4 against IPv4-mapped IPv6 rules too.
const nonPublicV4 = new BlockList();
const nonPublicV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) nonPublicV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 127], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) nonPublicV6.addSubnet(network, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return family === 4 ? !nonPublicV4.check(address, "ipv4") : !nonPublicV6.check(address, "ipv6");
}

/** Rejects URLs that name an internal host before any DNS lookup. */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("INVALID_ARGUMENT", "http_get needs an absolute https:// URL.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (url.protocol !== "https:") {
    throw new AppError("INVALID_ARGUMENT", "http_get only fetches https:// URLs.");
  }
  if (url.username || url.password) {
    throw new AppError("INVALID_ARGUMENT", "http_get does not send credentials in the URL.");
  }
  if (url.port !== "" && url.port !== "443") {
    throw new AppError("NAVIGATION_BLOCKED", "http_get only uses the default https port.");
  }
  if (isIP(host.replace(/^\[|\]$/gu, "")) !== 0 || !host.includes(".") || host === "localhost" ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new AppError("NAVIGATION_BLOCKED", "http_get only fetches public host names, not IP addresses or internal hosts.");
  }
  url.hash = "";
  return url;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** DNS lookup that refuses non-public answers, so a rebinding host cannot reach the private network. */
export function publicOnlyLookup(hostname: string, options: { all?: boolean }, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, "");
    if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
      const blocked = Object.assign(new Error("http_get refused a private or internal address."), { code: "EMCPBLOCKED" });
      return callback(blocked, "");
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

export type HttpsGetter = (url: URL, signal: AbortSignal) => Promise<IncomingMessage>;

const defaultGetter: HttpsGetter = (url, signal) => new Promise((resolve, reject) => {
  const req = httpsRequest(url, {
    method: "GET",
    lookup: publicOnlyLookup as never,
    signal,
    headers: { "user-agent": "mcp-access-stack-http-get", accept: "*/*", "accept-encoding": "identity" },
  }, resolve);
  req.on("error", reject);
  req.end();
});

export async function httpGet(
  input: HttpGetInput,
  context: OperationContext = {},
  getter: HttpsGetter = defaultGetter,
): Promise<HttpGetResult> {
  const parsed = httpGetInputSchema.parse(input);
  let url = assertFetchableUrl(parsed.url);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
  for (let redirects = 0; ; redirects += 1) {
    let response: IncomingMessage;
    try {
      response = await getter(url, signal);
    } catch (error) {
      throw fetchError(error, context.signal, timeout);
    }
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(status) && typeof location === "string") {
      response.destroy();
      if (redirects >= MAX_REDIRECTS) {
        throw new AppError("LIMIT_EXCEEDED", `http_get stopped after ${MAX_REDIRECTS} redirects.`);
      }
      url = assertFetchableUrl(new URL(location, url).href);
      continue;
    }
    let body: { bytes: Buffer; truncated: boolean };
    try {
      body = await readBounded(response, parsed.maxBytes);
    } catch (error) {
      throw fetchError(error, context.signal, timeout);
    }
    const contentType = typeof response.headers["content-type"] === "string"
      ? response.headers["content-type"].slice(0, 256) : null;
    const text = decodeText(body.bytes, contentType, body.truncated);
    return httpGetResultSchema.parse({
      url: url.href,
      status,
      contentType,
      body: text ?? body.bytes.toString("base64"),
      bodyEncoding: text === undefined ? "base64" : "utf8",
      truncated: body.truncated,
      redirects,
    });
  }
}

async function readBounded(response: IncomingMessage, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const buffer = chunk as Buffer;
    if (total + buffer.byteLength > maxBytes) {
      chunks.push(buffer.subarray(0, maxBytes - total));
      response.destroy();
      return { bytes: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(buffer);
    total += buffer.byteLength;
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
}

function decodeText(bytes: Buffer, contentType: string | null, truncated: boolean): string | undefined {
  const textual = contentType === null ||
    /^(text\/|application\/(json|xml|javascript|x-ndjson|problem\+json|[a-z.+-]*\+(json|xml)))/iu.test(contentType);
  if (!textual) return undefined;
  try {
    // A cut body may end inside a multi-byte character; drop that partial tail only.
    return new TextDecoder("utf-8", { fatal: !truncated }).decode(bytes);
  } catch {
    return undefined;
  }
}

function fetchError(error: unknown, callerSignal: AbortSignal | undefined, timeout: AbortSignal): AppError {
  if (error instanceof AppError) return error;
  if (callerSignal?.aborted) return abortSignalError(callerSignal, "http_get was cancelled.");
  if (timeout.aborted) return new AppError("NAVIGATION_TIMEOUT", `http_get timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "EMCPBLOCKED") {
    return new AppError("NAVIGATION_BLOCKED", "http_get refused a host that resolves to a private or internal address.");
  }
  const safeCode = typeof code === "string" && /^[A-Z0-9_]{1,40}$/u.test(code) ? ` (${code})` : "";
  return new AppError("INVALID_ARGUMENT", `http_get could not fetch the URL${safeCode}.`);
}
