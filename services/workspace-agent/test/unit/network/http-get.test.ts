import { describe, expect, it } from "@jest/globals";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  assertFetchableUrl,
  httpGet,
  isPublicAddress,
  type HttpsGetter,
} from "../../../src/network/http-get.js";

function response(status: number, headers: Record<string, string>, body = ""): IncomingMessage {
  const stream = new PassThrough();
  stream.end(Buffer.from(body));
  return Object.assign(stream, { statusCode: status, headers }) as unknown as IncomingMessage;
}

describe("http_get address policy", () => {
  it("treats only publicly routable addresses as public", () => {
    for (const address of ["8.8.8.8", "140.82.112.3", "2606:4700::1111"]) {
      expect(isPublicAddress(address)).toBe(true);
    }
    for (const address of ["127.0.0.1", "10.0.0.137", "172.16.4.1", "192.168.1.1", "169.254.169.254",
      "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "not-an-ip"]) {
      expect(isPublicAddress(address)).toBe(false);
    }
  });

  it("refuses non-https, credentials, ports, IP literals and internal names before any lookup", () => {
    expect(assertFetchableUrl("https://example.com/health#x").href).toBe("https://example.com/health");
    for (const url of ["http://example.com", "https://user:pw@example.com", "https://example.com:8443/",
      "https://127.0.0.1/", "https://[::1]/", "https://localhost/", "https://metadata.internal/",
      "https://printer.local/", "https://intranet/", "file:///etc/passwd"]) {
      expect(() => assertFetchableUrl(url)).toThrow();
    }
  });
});

describe("http_get fetch", () => {
  it("returns status, type and a bounded utf8 body", async () => {
    const getter: HttpsGetter = async () => response(200, { "content-type": "application/json" }, JSON.stringify({ ok: true, pad: "x".repeat(4_000) }));
    const result = await httpGet({ workspaceId: "ws", url: "https://example.com/health", maxBytes: 1_024 }, {}, getter);
    expect(result).toMatchObject({ status: 200, contentType: "application/json", bodyEncoding: "utf8", truncated: true, redirects: 0 });
    expect(result.body.startsWith('{"ok":true')).toBe(true);
    expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(1_024);
  });

  it("re-checks every redirect and stops at internal targets", async () => {
    const seen: string[] = [];
    const getter: HttpsGetter = async (url) => {
      seen.push(url.href);
      return seen.length === 1
        ? response(302, { location: "/next" })
        : seen.length === 2 ? response(301, { location: "https://169.254.169.254/latest" }) : response(200, {});
    };
    await expect(httpGet({ workspaceId: "ws", url: "https://example.com/start" }, {}, getter)).rejects.toThrow();
    expect(seen).toEqual(["https://example.com/start", "https://example.com/next"]);
  });

  it("encodes binary bodies as base64 and limits redirects", async () => {
    const binary: HttpsGetter = async () => response(200, { "content-type": "image/png" }, "\u0089PNG");
    await expect(httpGet({ workspaceId: "ws", url: "https://example.com/a.png" }, {}, binary))
      .resolves.toMatchObject({ bodyEncoding: "base64", truncated: false });
    const loop: HttpsGetter = async () => response(302, { location: "https://example.com/again" });
    await expect(httpGet({ workspaceId: "ws", url: "https://example.com/" }, {}, loop)).rejects.toThrow("redirects");
  });
});
