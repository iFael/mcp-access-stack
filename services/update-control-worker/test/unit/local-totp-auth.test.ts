import { describe, expect, it, jest } from "@jest/globals";
import type { OwnerOAuthStorage } from "@mcp-access-stack/mcp-owner-auth";
import { UpdateControlAuthController, type UpdateControlDurableState } from "../../src/auth-state.js";

const BASE_URL = "https://update-control.example/";
const ADMIN_MARKER = "x-update-control-internal-admin-operation-authenticated";
const INTERNAL_VALUE = "v1";
const TOTP_KEY = "e".repeat(64);

class MemoryStorage implements OwnerOAuthStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async listPrefix(prefix: string, limit: number): Promise<Map<string, unknown>> {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
  }
  async deleteMany(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) if (this.values.delete(key)) deleted += 1;
    return deleted;
  }
}

function makeController(storage = new MemoryStorage()) {
  const state: UpdateControlDurableState = { storage };
  return {
    storage,
    controller: new UpdateControlAuthController(state, {
      MCP_UPDATE_CONTROL_PUBLIC_URL: BASE_URL,
      UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL: "rafael@example.com",
      UPDATE_CONTROL_TOTP_ENCRYPTION_KEY: TOTP_KEY,
    }),
  };
}

async function bootstrap(controller: UpdateControlAuthController): Promise<void> {
  const operationId = "11111111-2222-4333-8444-555555555555";
  const response = await controller.fetch(new Request(new URL("/_operations/admin/bootstrap", BASE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [ADMIN_MARKER]: INTERNAL_VALUE,
    },
    body: JSON.stringify({ operationId }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ operationId, status: "ready" });
}

async function registerClient(controller: UpdateControlAuthController): Promise<string> {
  const response = await controller.fetch(new Request(new URL("/register", BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector/oauth/local-totp-test"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  }));
  expect(response.status).toBe(201);
  return (await response.json() as { client_id: string }).client_id;
}

async function beginAuthorization(controller: UpdateControlAuthController, clientId: string) {
  const verifier = "v".repeat(64);
  const challenge = await sha256Base64Url(verifier);
  const url = new URL("/authorize", BASE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://chatgpt.com/connector/oauth/local-totp-test",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "update:read",
    resource: new URL("/mcp", BASE_URL).href,
    state: "chatgpt-state",
  }).toString();
  const response = await controller.fetch(new Request(url));
  return { response, verifier };
}

function hiddenState(html: string): string {
  const state = /name="state" value="([^"]+)"/u.exec(html)?.[1];
  expect(state).toBeTruthy();
  return state!;
}

function provisioningSecret(html: string): string {
  const encoded = /data-provisioning-uri="([^"]+)"/u.exec(html)?.[1]
    ?.replaceAll("&amp;", "&");
  expect(encoded).toContain("otpauth://totp/");
  const secret = new URL(encoded!).searchParams.get("secret");
  expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
  return secret!;
}

function recoveryCodes(html: string): string[] {
  return [...html.matchAll(/data-recovery-code="([A-Z0-9-]+)"/gu)].map((match) => match[1]!);
}

async function form(controller: UpdateControlAuthController, path: string, fields: Record<string, string>) {
  return controller.fetch(new Request(new URL(path, BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  }));
}

describe("Update Control local TOTP identity", () => {
  it("bootstraps the first admin locally, emits an Authenticator-compatible QR, encrypts the TOTP seed, blocks timestep replay, and consumes recovery codes once", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-06T21:00:00.000Z"));
    try {
      const { controller, storage } = makeController();
      await bootstrap(controller);

      const enrollment = await controller.fetch(new Request(new URL("/enroll", BASE_URL)));
      expect(enrollment.status).toBe(200);
      const enrollmentHtml = await enrollment.text();
      expect(enrollmentHtml).toContain("<svg");
      expect(enrollmentHtml).toContain("Authenticator QR code");
      expect(enrollmentHtml).not.toContain("login.microsoftonline.com");
      expect(enrollmentHtml).not.toContain("graph.microsoft.com");

      const enrollState = hiddenState(enrollmentHtml);
      const secret = provisioningSecret(enrollmentHtml);
      const firstCode = await totp(secret, Date.now());

      const enrolled = await form(controller, "/enroll", {
        state: enrollState,
        email: "rafael@example.com",
        display_name: "Rafael",
        code: firstCode,
      });
      expect(enrolled.status).toBe(200);
      const enrolledHtml = await enrolled.text();
      const recoveries = recoveryCodes(enrolledHtml);
      expect(recoveries).toHaveLength(8);

      const persisted = JSON.stringify([...storage.values.entries()]);
      expect(persisted).not.toContain(secret);
      expect(persisted).not.toContain(recoveries[0]!);
      expect(persisted).toContain('"provider":"local-totp"');

      const clientId = await registerClient(controller);
      const started = await beginAuthorization(controller, clientId);
      expect(started.response.status).toBe(200);
      const loginHtml = await started.response.text();
      expect(loginHtml).toContain("Verification code");
      expect(loginHtml).not.toContain("Microsoft");
      const loginState = hiddenState(loginHtml);

      const replay = await form(controller, "/authorize", {
        state: loginState,
        email: "rafael@example.com",
        code: firstCode,
      });
      expect(replay.status).toBe(401);
      expect(await replay.json()).toEqual({ error: "invalid_credentials" });

      jest.advanceTimersByTime(30_000);
      const secondStarted = await beginAuthorization(controller, clientId);
      const secondState = hiddenState(await secondStarted.response.text());
      const secondCode = await totp(secret, Date.now());
      const authorized = await form(controller, "/authorize", {
        state: secondState,
        email: "rafael@example.com",
        code: secondCode,
      });
      expect(authorized.status).toBe(302);
      expect(new URL(authorized.headers.get("location")!).searchParams.get("code")).toMatch(/^code-/u);

      const recoveryStarted = await beginAuthorization(controller, clientId);
      const recoveryState = hiddenState(await recoveryStarted.response.text());
      const recovered = await form(controller, "/authorize", {
        state: recoveryState,
        email: "rafael@example.com",
        code: recoveries[0]!,
      });
      expect(recovered.status).toBe(302);

      const recoveryReplayStarted = await beginAuthorization(controller, clientId);
      const recoveryReplayState = hiddenState(await recoveryReplayStarted.response.text());
      const recoveryReplay = await form(controller, "/authorize", {
        state: recoveryReplayState,
        email: "rafael@example.com",
        code: recoveries[0]!,
      });
      expect(recoveryReplay.status).toBe(401);
      expect(await recoveryReplay.json()).toEqual({ error: "invalid_credentials" });
    } finally {
      jest.useRealTimers();
    }
  });

  it("requires the local TOTP encryption key and has no Microsoft Identity runtime configuration", async () => {
    const missingKey = new UpdateControlAuthController({ storage: new MemoryStorage() }, {
      MCP_UPDATE_CONTROL_PUBLIC_URL: BASE_URL,
      UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL: "rafael@example.com",
    });
    const unavailable = await missingKey.fetch(new Request(new URL("/mcp", BASE_URL), { method: "POST" }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "update_control_not_configured" });

    const { controller } = makeController();
    const metadata = await controller.fetch(new Request(new URL("/.well-known/oauth-authorization-server", BASE_URL)));
    expect(metadata.status).toBe(200);
    const body = JSON.stringify(await metadata.json());
    expect(body).not.toContain("microsoft");
    expect(body).not.toContain("login.microsoftonline.com");
  });
});

async function totp(secret: string, nowMs: number): Promise<string> {
  const keyBytes = decodeBase32(secret);
  const counter = Math.floor(nowMs / 30_000);
  const message = new Uint8Array(8);
  let value = BigInt(counter);
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(6, "0");
}

function decodeBase32(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("invalid base32");
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
