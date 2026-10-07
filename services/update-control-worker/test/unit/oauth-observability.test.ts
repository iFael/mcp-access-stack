import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  BASE_URL,
  CHATGPT_REDIRECT,
  RESOURCE,
  MemoryStorage,
  createHarness,
} from "../helpers/oauth-session-fixtures.js";

const CANARIES = [
  "email-canary-718@example.invalid",
  "totp-canary-593104",
  "cookie-canary-opaque-93",
  "oauth-state-canary-448",
  "authorization-code-canary-557",
  "pkce-verifier-canary-228",
  "bearer-canary-911",
  "refresh-canary-384",
  "storage-error-canary-663",
  "oauth-client-canary-205",
] as const;

class ErrorInjectingStorage extends MemoryStorage {
  failReads = false;

  override async get<T>(key: string): Promise<T | undefined> {
    if (this.failReads) throw new Error(CANARIES[8]);
    return super.get<T>(key);
  }
}

type SafeEvent = Record<string, unknown>;

describe("OAuth observability sanitization", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("emits stage-level allowlisted events and never writes credentials, OAuth values, or raw errors", async () => {
    const calls: unknown[][] = [];
    const capture = (...args: unknown[]) => {
      calls.push(args);
    };
    jest.spyOn(console, "log").mockImplementation(capture);
    jest.spyOn(console, "info").mockImplementation(capture);
    jest.spyOn(console, "warn").mockImplementation(capture);
    jest.spyOn(console, "error").mockImplementation(capture);
    jest.spyOn(console, "debug").mockImplementation(capture);

    const storage = new ErrorInjectingStorage();
    const { controller } = createHarness(storage);

    await controller.fetch(new Request(new URL("/user", BASE_URL)));
    await controller.fetch(new Request(new URL("/user", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        state: CANARIES[3],
        email: CANARIES[0],
        code: CANARIES[1],
      }),
    }));

    await controller.fetch(new Request(new URL("/admin", BASE_URL), {
      headers: { cookie: "update_control_human_session=" + CANARIES[2] },
    }));

    const oauth = new URL("/oauth", BASE_URL);
    oauth.search = new URLSearchParams({
      response_type: "code",
      client_id: CANARIES[9],
      redirect_uri: CHATGPT_REDIRECT,
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
      scope: "update:read",
      resource: RESOURCE,
      state: CANARIES[3],
    }).toString();
    await controller.fetch(new Request(oauth));

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CANARIES[9],
      code: CANARIES[4],
      redirect_uri: CHATGPT_REDIRECT,
      code_verifier: CANARIES[5],
      resource: RESOURCE,
    });
    await controller.fetch(new Request(new URL("/token", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    }));

    await controller.fetch(new Request(new URL("/token", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CANARIES[9],
        refresh_token: CANARIES[7],
        resource: RESOURCE,
      }),
    }));

    await controller.fetch(new Request(new URL("/revoke", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: CANARIES[7], token_type_hint: "refresh_token" }),
    }));

    await controller.fetch(new Request(new URL("/mcp", BASE_URL), {
      method: "POST",
      headers: {
        authorization: "Bearer " + CANARIES[6],
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));

    storage.failReads = true;
    await controller.fetch(new Request(new URL("/oauth", BASE_URL)));

    const output = calls.flatMap((args) => args.map(logValue)).join("\n");
    const canaryLeak = CANARIES.some((canary) => output.includes(canary));
    expect(canaryLeak).toBe(false);

    const events = calls.flatMap(extractEvents);
    const allowed = new Set([
      "flowId", "stage", "method", "pathname", "status", "result", "duration", "durationMs",
    ]);
    const paths = new Set(["/user", "/user/logout", "/oauth", "/authorize", "/token", "/register", "/revoke", "/mcp"]);
    const closedEvents = events.length > 0 && events.every((event) => {
      const keys = Object.keys(event);
      const flowId = event.flowId;
      const stage = event.stage;
      const method = event.method;
      const pathname = event.pathname;
      const status = event.status;
      const result = event.result;
      const hasDuration = typeof event.duration === "number" || typeof event.durationMs === "number";
      const durationKeys = Number(typeof event.duration === "number") +
        Number(typeof event.durationMs === "number");
      return keys.every((key) => allowed.has(key)) &&
        typeof flowId === "string" && /^[A-Za-z0-9_-]{8,80}$/u.test(flowId) &&
        typeof stage === "string" && /^[a-z][a-z0-9_.-]{0,47}$/iu.test(stage) &&
        (method === "GET" || method === "POST") &&
        typeof pathname === "string" && paths.has(pathname) &&
        typeof status === "number" && status >= 100 && status <= 599 &&
        typeof result === "string" && /^[a-z][a-z0-9_-]{0,31}$/iu.test(result) &&
        hasDuration && durationKeys === 1;
    });
    expect(closedEvents).toBe(true);

    const stagesWereSeparated = events.some((event) => event.pathname === "/oauth") &&
      events.some((event) => event.pathname === "/token");
    expect(stagesWereSeparated).toBe(true);
  });
});

function logValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.name + ":" + value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractEvents(args: unknown[]): SafeEvent[] {
  const events: SafeEvent[] = [];
  for (const value of args) {
    if (isRecord(value)) {
      events.push(value);
      continue;
    }
    if (typeof value !== "string") continue;
    const candidates = [value];
    const opening = value.indexOf("{");
    const closing = value.lastIndexOf("}");
    if (opening >= 0 && closing > opening) candidates.push(value.slice(opening, closing + 1));
    for (const candidate of candidates) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (isRecord(parsed)) events.push(parsed);
      } catch {
        // Plain text logger arguments are checked for canary leakage above.
      }
    }
  }
  return events;
}

function isRecord(value: unknown): value is SafeEvent {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
