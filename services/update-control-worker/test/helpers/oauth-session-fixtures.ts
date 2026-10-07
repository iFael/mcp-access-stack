import type { UpdateControlDurableState, UpdateControlDurableStorage } from "../../src/auth-state.js";
import { UpdateControlAuthController } from "../../src/auth-state.js";

export const BASE_URL = "https://update-control.example/";
export const ADMIN_OPERATION_HEADER = "x-update-control-internal-admin-operation-authenticated";
export const INTERNAL_OPERATION_MARKER = "v1";
export const TOTP_ENCRYPTION_KEY = "e".repeat(64);
export const ADMIN_EMAIL = "admin@example.invalid";
export const CHATGPT_REDIRECT = "https://chatgpt.com/connector/oauth/synthetic-test";
export const RESOURCE = new URL("/mcp", BASE_URL).href;

export class MemoryStorage implements UpdateControlDurableStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async listPrefix(prefix: string, limit: number): Promise<Map<string, unknown>> {
    return new Map([...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .slice(0, limit));
  }

  async deleteMany(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) if (this.values.delete(key)) deleted += 1;
    return deleted;
  }
}

export function createHarness(storage = new MemoryStorage()) {
  const state: UpdateControlDurableState = { storage };
  const controller = new UpdateControlAuthController(state, {
    MCP_UPDATE_CONTROL_PUBLIC_URL: BASE_URL,
    UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
    UPDATE_CONTROL_TOTP_ENCRYPTION_KEY: TOTP_ENCRYPTION_KEY,
  });
  return { controller, storage };
}

export type Enrollment = {
  readonly email: string;
  readonly secret: string;
  readonly recoveryCodes: string[];
  readonly userId: string;
};

export async function bootstrapAndEnrollAdmin(
  controller: UpdateControlAuthController,
  storage: MemoryStorage,
): Promise<Enrollment> {
  const operationId = "11111111-2222-4333-8444-555555555555";
  const response = await controller.fetch(new Request(new URL("/_operations/admin/bootstrap", BASE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [ADMIN_OPERATION_HEADER]: INTERNAL_OPERATION_MARKER,
    },
    body: JSON.stringify({ operationId }),
  }));
  if (response.status !== 200) throw new Error("Admin bootstrap fixture did not complete.");

  return enrollFromPage(controller, storage, "/enroll", "/enroll", ADMIN_EMAIL, "Admin");
}

export async function enrollFromPage(
  controller: UpdateControlAuthController,
  storage: MemoryStorage,
  pageUrl: string,
  postPath: string,
  email: string,
  displayName: string,
): Promise<Enrollment> {
  const page = await controller.fetch(new Request(new URL(pageUrl, BASE_URL)));
  const html = await page.text();
  const state = hiddenField(html, "state");
  const secret = provisioningSecret(html);
  const completed = await postForm(controller, postPath, {
    state,
    email,
    display_name: displayName,
    code: await totp(secret, Date.now()),
  });
  if (completed.status !== 200) throw new Error("Local TOTP enrollment fixture did not complete.");
  const completedHtml = await completed.text();
  const recoveryCodes = [...completedHtml.matchAll(/data-recovery-code="([A-Z0-9-]+)"/gu)]
    .map((match) => match[1]!);
  const user = findStoredUserByEmail(storage, email);
  if (!user) throw new Error("Enrolled fixture user is missing.");
  return { email, secret, recoveryCodes, userId: user.id };
}

export async function beginUserLogin(
  controller: UpdateControlAuthController,
  url = "/user",
  cookie?: string,
): Promise<{ response: Response; html: string; state: string }> {
  const response = await controller.fetch(new Request(new URL(url, BASE_URL), {
    ...(cookie ? { headers: { cookie } } : {}),
  }));
  const html = await response.text();
  const state = /name="state" value="([^"]+)"/u.exec(html)?.[1] ?? "";
  return { response, html, state };
}

export async function submitUserLogin(
  controller: UpdateControlAuthController,
  state: string,
  email: string,
  code: string,
  cookie?: string,
): Promise<Response> {
  return postForm(
    controller,
    "/user",
    { state, email, code },
    cookie ?? `update_control_login=${state}`,
  );
}

export async function postForm(
  controller: UpdateControlAuthController,
  path: string,
  fields: Record<string, string>,
  cookie?: string,
): Promise<Response> {
  return controller.fetch(new Request(new URL(path, BASE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields),
  }));
}

export async function registerClient(
  controller: UpdateControlAuthController,
  redirectUri = CHATGPT_REDIRECT,
): Promise<string> {
  const response = await controller.fetch(new Request(new URL("/register", BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT synthetic callback",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  }));
  if (response.status !== 201) throw new Error("Dynamic client registration fixture did not complete.");
  return (await response.json() as { client_id: string }).client_id;
}

export async function registerClientRaw(
  controller: UpdateControlAuthController,
  metadata: unknown,
): Promise<Response> {
  return controller.fetch(new Request(new URL("/register", BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(metadata),
  }));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function authorizationUrl(
  clientId: string,
  values: Partial<Record<
    "response_type" | "redirect_uri" | "code_challenge" | "code_challenge_method" |
    "scope" | "resource" | "state",
    string
  >> = {},
  path = "/oauth",
): URL {
  const url = new URL(path, BASE_URL);
  url.search = new URLSearchParams({
    response_type: values.response_type ?? "code",
    client_id: clientId,
    redirect_uri: values.redirect_uri ?? CHATGPT_REDIRECT,
    code_challenge: values.code_challenge ?? "A".repeat(43),
    code_challenge_method: values.code_challenge_method ?? "S256",
    scope: values.scope ?? "update:read",
    resource: values.resource ?? RESOURCE,
    state: values.state ?? "client-state-synthetic",
  }).toString();
  return url;
}

export async function beginOAuth(
  controller: UpdateControlAuthController,
  clientId: string,
  options: {
    readonly path?: string;
    readonly verifier?: string;
    readonly state?: string;
    readonly redirectUri?: string;
    readonly resource?: string;
  } = {},
): Promise<{ response: Response; verifier: string; state: string; requestUrl: URL }> {
  const verifier = options.verifier ?? "v".repeat(64);
  const state = options.state ?? "client-state-synthetic";
  const requestUrl = authorizationUrl(clientId, {
    code_challenge: await pkceChallenge(verifier),
    state,
    ...(options.redirectUri ? { redirect_uri: options.redirectUri } : {}),
    ...(options.resource ? { resource: options.resource } : {}),
  }, options.path);
  const response = await controller.fetch(new Request(requestUrl));
  return { response, verifier, state, requestUrl };
}

export function cookiePair(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";", 1)[0] ?? "";
}

export function cookieValue(cookiePairValue: string): string {
  const separator = cookiePairValue.indexOf("=");
  return separator < 0 ? "" : cookiePairValue.slice(separator + 1);
}

export function csrfFromHtml(html: string): string {
  return hiddenField(html, "csrf");
}

export function hiddenField(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = new RegExp(`name="${escaped}" value="([^"]+)"`, "u").exec(html)?.[1];
  if (!value) throw new Error("Expected hidden form field is missing.");
  return value;
}

export function provisioningSecret(html: string): string {
  const secret = /data-manual-totp-secret="([A-Z2-7]+)"/u.exec(html)?.[1];
  if (!secret || !/^[A-Z2-7]{32}$/u.test(secret)) {
    throw new Error("Provisioning secret is missing from enrollment fixture.");
  }
  return secret;
}

export async function totp(secret: string, nowMs: number): Promise<string> {
  const secretBytes = decodeBase32(secret);
  const counter = Math.floor(nowMs / 30_000);
  const message = new Uint8Array(8);
  let value = BigInt(counter);
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secretBytes),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, toArrayBuffer(message)));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function findStoredUserByEmail(
  storage: MemoryStorage,
  email: string,
): { id: string; email: string; role: string; status: string } | undefined {
  for (const value of storage.values.values()) {
    if (typeof value !== "object" || value === null || !("email" in value)) continue;
    const candidate = value as { id?: unknown; email?: unknown; role?: unknown; status?: unknown };
    if (typeof candidate.email === "string" && candidate.email.toLowerCase() === email.toLowerCase() &&
        typeof candidate.id === "string" && typeof candidate.role === "string" &&
        typeof candidate.status === "string") {
      return candidate as { id: string; email: string; role: string; status: string };
    }
  }
  return undefined;
}

export async function joinUser(
  controller: UpdateControlAuthController,
  storage: MemoryStorage,
  adminCookieHeader: string,
  email: string,
): Promise<Enrollment> {
  const adminPage = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
    headers: { cookie: adminCookieHeader },
  }));
  const csrf = csrfFromHtml(await adminPage.text());
  const invitation = await postForm(controller, "/admin/invites", { csrf, role: "user" }, adminCookieHeader);
  const invitationHtml = await invitation.text();
  const joinUrl = /href="(https:[^"]+\/join\?invite=[^"]+)"/u.exec(invitationHtml)?.[1];
  if (!joinUrl) throw new Error("User invitation fixture did not include a join URL.");
  return enrollFromPage(controller, storage, joinUrl, "/join", email, "User");
}

function decodeBase32(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("Invalid Base32 in enrollment fixture.");
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
