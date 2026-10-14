import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCandidateAdminHttpApp } from "../../../src/admin/candidate-admin-http.js";
import { CandidateServiceAdmin } from "../../../src/admin/candidate-service.js";
import { loadPrivateAdminToken } from "../../../src/admin/candidate-admin-http-cli.js";

const TOKEN = "A".repeat(64);
let server: Server;
let url: string;
let called = 0;

beforeAll(async () => {
  const admin = new CandidateServiceAdmin(async (_exe, _args) => {
    called += 1;
    return { exitCode: 0, timedOut: false, stdout: "not-found\n" };
  }, async () => {});
  server = createServer(createCandidateAdminHttpApp({ token: TOKEN, admin }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("TEST_LISTENER_FAILED");
  url = `http://127.0.0.1:${addr.port}/mcp`;
});

afterAll(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function post(body: unknown, authorization?: string, origin?: string) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      ...(authorization === undefined ? {} : { authorization }),
      ...(origin === undefined ? {} : { origin }),
    },
    body: JSON.stringify(body),
  });
}

describe("isolated private connector99 HTTP transport", () => {
  it("fails closed for missing, wrong and browser-origin credentials", async () => {
    const request = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    expect((await post(request)).status).toBe(401);
    expect((await post(request, "Bearer " + "B".repeat(64))).status).toBe(401);
    expect((await post(request, "Bearer " + TOKEN, "https://untrusted.example")).status).toBe(403);
    expect(called).toBe(0);
  });
  it("rejects requests with an invalid bearer scheme and disallowed methods", async () => {
    const request = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    expect((await post(request, "Basic " + TOKEN)).status).toBe(401);
    expect((await fetch(url, { method: "GET", headers: { authorization: "Bearer " + TOKEN } })).status).toBe(405);
  });
  it("serves only status and operation reconciliation, never remote mutation", async () => {
    const response = await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, "Bearer " + TOKEN);
    expect(response.status).toBe(200);
    const payload = await response.json() as { result?: { tools?: Array<{ name: string }> } };
    expect(payload.result?.tools?.map(x => x.name).sort()).toEqual([
      "candidate_operation_status",
      "candidate_service_status",
    ]);
    expect(called).toBe(0);
    const provision = await post({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "provision_candidate_service", arguments: {} },
    }, "Bearer " + TOKEN);
    expect(provision.status).toBe(200);
    const result = await provision.json() as { error?: unknown; result?: { isError?: boolean } };
    expect(result.error ?? result.result?.isError).toBeTruthy();
    expect(called).toBe(0);
  });
  it("accepts only owner-restricted credential files and never follows a symlink", async () => {
    if (process.platform !== "linux") return;
    const dir = await mkdtemp(join(tmpdir(), "candidate99-private-credential-"));
    try {
      const file = join(dir, "admin-token");
      const linked = join(dir, "linked-token");
      await writeFile(file, TOKEN + "\n", { mode: 0o600 });
      await expect(loadPrivateAdminToken(file)).resolves.toBe(TOKEN);
      await symlink(file, linked);
      await expect(loadPrivateAdminToken(linked)).rejects.toThrow();
      await chmod(file, 0o644);
      await expect(loadPrivateAdminToken(file)).rejects.toThrow("UNTRUSTED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not construct an instance without a strong dedicated secret", () => {
    expect(() => createCandidateAdminHttpApp({ token: "too-short" })).toThrow("TOKEN_INVALID");
  });
});
