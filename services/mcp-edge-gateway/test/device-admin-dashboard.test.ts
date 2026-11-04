import { describe, expect, it } from "@jest/globals";
import { DeviceAdminDashboard } from "../src/control-plane/device-admin-dashboard.js";

const url = "https://edge.example/admin/devices";

function fixture() {
  const values = new Map<string, unknown>();
  let credentialVersion = "v1";
  const calls: string[] = [];
  const dashboard = new DeviceAdminDashboard({
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
  }, {
    authenticate: async (password) => password === "correct-owner-password"
      ? { userId: "owner-a", credentialVersion }
      : null,
    credentialVersion: async () => credentialVersion,
    devices: async (userId) => {
      calls.push(userId);
      return [{
        id: "dev_11111111-1111-4111-8111-111111111111",
        displayName: "<img src=x onerror=alert(1)>",
        platform: "windows",
        status: "online" as const,
        createdAt: "2026-10-01T12:00:00Z",
      }];
    },
  });
  const login = (password = "correct-owner-password", origin = "https://edge.example") =>
    dashboard.handle(new Request(url, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.42" },
      body: new URLSearchParams({ owner_password: password }),
    }));
  return { dashboard, login, calls, values, rotate: () => { credentialVersion = "v2"; } };
}
function cookies(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

describe("DeviceAdminDashboard", () => {
  it("requires the current owner's login before showing devices or device JSON", async () => {
    const { dashboard, calls } = fixture();
    const login = await dashboard.handle(new Request(url));
    expect(login.status).toBe(200);
    expect(await login.text()).toContain("Senha da conta");
    expect((await dashboard.handle(new Request(url + "/data"))).status).toBe(401);
    expect(calls).toEqual([]);
    expect((await dashboard.handle(new Request(url + "/logout", { method: "GET" }))).status).toBe(405);
    expect((await dashboard.handle(new Request("https://edge.example/admin/unknown"))).status).toBe(404);
  });

  it("enforces same-origin POST and throttles invalid logins", async () => {
    const { dashboard, login, values } = fixture();
    expect((await login("correct-owner-password", "https://attacker.example")).status).toBe(403);
    expect((await dashboard.handle(new Request(url, {
      method: "POST",
      headers: { origin: "https://edge.example", "content-type": "application/json" },
      body: "{}",
    }))).status).toBe(403);
    for (let i = 0; i < 5; i++) expect((await login("wrong")).status).toBe(401);
    expect((await login()).status).toBe(429);
    expect([...values.keys()].some((key) => key.startsWith("device-admin-session:"))).toBe(false);
  });

  it("displays only the authenticated user's devices with a private session", async () => {
    const { dashboard, login, calls, values } = fixture();
    const response = await login();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/devices");
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect([...values.keys()].some((key) => key.startsWith("device-admin-session:v1:"))).toBe(true);

    const page = await dashboard.handle(new Request(url, { headers: { cookie: cookies(response) } }));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("script-src");
    expect(page.headers.get("content-security-policy")).toContain("nonce-");
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    const html = await page.text();
    expect(html).toContain("Computadores conectados");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("correct-owner-password");

    const data = await dashboard.handle(new Request(url + "/data", { headers: { cookie: cookies(response) } }));
    expect(data.status).toBe(200);
    expect(data.headers.get("cache-control")).toBe("no-store");
    expect((await data.json() as { devices: Array<{ displayName: string }> }).devices[0]?.displayName)
      .toBe("<img src=x onerror=alert(1)>");
    expect(calls).toEqual(["owner-a"]);
  });

  it("invalidates sessions on credential rotation, expiry or logout", async () => {
    const { dashboard, login, values, rotate } = fixture();
    const first = await login();
    const auth = { cookie: cookies(first) };
    expect((await dashboard.handle(new Request(url + "/data", { headers: auth }))).status).toBe(200);
    rotate();
    expect((await dashboard.handle(new Request(url + "/data", { headers: auth }))).status).toBe(401);

    // A new session can expire or be explicitly ended, without exposing the token.
    const { dashboard: second, login: login2, values: records } = fixture();
    const signed = await login2();
    const sessionKey = [...records.keys()].find((key) => key.startsWith("device-admin-session:v1:"))!;
    const record = records.get(sessionKey) as { expiresAt: number };
    record.expiresAt = Date.now() - 1;
    expect((await second.handle(new Request(url + "/data", { headers: { cookie: cookies(signed) } }))).status).toBe(401);

    const newer = await login2();
    expect((await second.handle(new Request(url + "/logout", {
      method: "POST",
      headers: { cookie: cookies(newer), origin: "https://attacker.example" },
    }))).status).toBe(403);
    const logout = await second.handle(new Request(url + "/logout", {
      method: "POST",
      headers: { cookie: cookies(newer), origin: "https://edge.example" },
    }));
    expect(logout.status).toBe(303);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await second.handle(new Request(url + "/data", { headers: { cookie: cookies(newer) } }))).status).toBe(401);
  });
});
