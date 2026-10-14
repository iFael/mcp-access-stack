import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCandidateAdminOauthIngressApp, type IntrospectionResponse } from "../../../src/admin/candidate-admin-oauth-ingress.js";
import { readOwnerPrivateFile } from "../../../src/admin/candidate-admin-oauth-ingress-cli.js";

const ISSUER = "https://private-issuer.invalid/";
const RESOURCE = "https://candidate99-admin.invalid/mcp";
const ACCESS_TOKEN = "example-private-access-token";
const CONFIG = {
  publicBaseUrl: "https://candidate99-admin.invalid",
  authorizationServer: ISSUER,
  introspectionUrl: "https://private-issuer.invalid/oauth/introspect",
  clientId: "candidate99-private-client",
  clientSecret: "s".repeat(48),
  loopbackToken: "p".repeat(64),
};
let claims: IntrospectionResponse = {};
let introspectCount = 0;
let forwardCount = 0;
let lastForward: unknown;
let server: Server;
let endpoint: string;
const now = () => Math.floor(Date.now() / 1000);
const allowed = (): IntrospectionResponse => ({
  active: true, iss: ISSUER, sub: "operator:123",
  aud: [RESOURCE], scope: "candidate99:read", exp: now() + 120,
});

beforeAll(async () => {
  const app = createCandidateAdminOauthIngressApp({
    ...CONFIG,
    introspect: async () => { introspectCount += 1; return claims; },
    forward: async value => { forwardCount += 1; lastForward = value;
      return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
        result: { tools: [{ name: "candidate_service_status" }, { name: "candidate_operation_status" }] } }) }; },
  });
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const info = server.address();
  if (!info || typeof info === "string") throw Error("LISTENER_UNAVAILABLE");
  endpoint = "http://127.0.0.1:" + info.port;
});
afterAll(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function post(method: string, extras?: { token?: string; origin?: string; params?: unknown; cookie?: string }) {
  return fetch(endpoint + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(extras?.token ? { authorization: "Bearer " + extras.token } : {}),
      ...(extras?.origin ? { origin: extras.origin } : {}),
      ...(extras?.cookie ? { cookie: extras.cookie } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(extras?.params ? { params: extras.params } : {}) }),
  });
}

describe("candidate99 private HTTPS/OAuth ingress code-only", () => {
  it("publishes RFC 9728 protected resource metadata scoped to an independent issuer", async () => {
    const result = await fetch(endpoint + "/.well-known/oauth-protected-resource/mcp");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ["candidate99:read"],
    });
    expect(result.headers.get("cache-control")).toContain("no-store");
  });
  it("denies missing bearer, browser origins and cookies without reaching introspection", async () => {
    claims = allowed();
    const before = introspectCount;
    expect((await post("tools/list")).status).toBe(401);
    const challenged = await post("tools/list");
    expect(challenged.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
    expect((await post("tools/list", { token: ACCESS_TOKEN, origin: "https://example.invalid" })).status).toBe(403);
    expect((await post("tools/list", { token: ACCESS_TOKEN, cookie: "session=1" })).status).toBe(403);
    expect(introspectCount).toBe(before);
  });
  it("rejects inactive, expired, wrong issuer, audience and scope before forwarding", async () => {
    const invalid: IntrospectionResponse[] = [
      { ...allowed(), active: false },
      { ...allowed(), exp: now() - 10 },
      { ...allowed(), iss: "https://other.invalid/" },
      { ...allowed(), aud: "https://other.invalid/mcp" },
      { ...allowed(), scope: "update:read" },
      { ...allowed(), sub: "" },
      { ...allowed(), exp: Number.MAX_VALUE + 1 },
    ];
    const before = forwardCount;
    for (const candidate of invalid) {
      claims = candidate;
      expect((await post("tools/list", { token: ACCESS_TOKEN })).status).toBe(401);
    }
    expect(forwardCount).toBe(before);
  });
  it("fails closed when the authorization server is unavailable", async () => {
    claims = {} as IntrospectionResponse;
    expect((await post("tools/list", { token: ACCESS_TOKEN })).status).toBe(401);
  });
  it("permits MCP read-only methods with correct audience and scope", async () => {
    claims = allowed();
    const result = await post("tools/list", { token: ACCESS_TOKEN });
    expect(result.status).toBe(200);
    expect(lastForward).toMatchObject({ method: "tools/list" });
    expect((await result.json()).result.tools).toHaveLength(2);
  });
  it("rejects mutation and unknown tool names even with valid OAuth token", async () => {
    claims = allowed();
    const before = forwardCount;
    expect((await post("tools/call", { token: ACCESS_TOKEN,
      params: { name: "provision_candidate_service", arguments: {} } })).status).toBe(403);
    expect((await post("tools/call", { token: ACCESS_TOKEN,
      params: { name: "unrecognized_tool", arguments: {} } })).status).toBe(403);
    expect((await post("resources/list", { token: ACCESS_TOKEN })).status).toBe(403);
    expect(forwardCount).toBe(before);
    expect((await post("tools/call", { token: ACCESS_TOKEN,
      params: { name: "candidate_service_status", arguments: {} } })).status).toBe(200);
  });
  it("enforces HTTPS-only issuer and independent audience configuration", () => {
    expect(() => createCandidateAdminOauthIngressApp({ ...CONFIG,
      introspectionUrl: "http://private-issuer.invalid/introspect" })).toThrow("HTTPS_URL_REQUIRED");
    expect(() => createCandidateAdminOauthIngressApp({ ...CONFIG,
      publicBaseUrl: ISSUER })).toThrow("CONFIG_INVALID");
    expect(() => createCandidateAdminOauthIngressApp({ ...CONFIG,
      introspectionUrl: "https://wrong-issuer.invalid/introspect" })).toThrow("CONFIG_INVALID");
    expect(() => createCandidateAdminOauthIngressApp({ ...CONFIG,
      clientId: "bad:client-id" })).toThrow("CONFIG_INVALID");
    expect(() => createCandidateAdminOauthIngressApp({ ...CONFIG,
      loopbackToken: "short" })).toThrow("CONFIG_INVALID");
  });
  it("reads only owned private credential files without following symlinks", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "candidate99-private-oauth-"));
    try {
      const file = join(root, "credential");
      const link = join(root, "symlink");
      await writeFile(file, "c".repeat(64), { mode: 0o600 });
      expect(await readOwnerPrivateFile(file)).toBe("c".repeat(64));
      await symlink(file, link);
      await expect(readOwnerPrivateFile(link)).rejects.toThrow();
      await chmod(file, 0o644);
      await expect(readOwnerPrivateFile(file)).rejects.toThrow("UNTRUSTED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
