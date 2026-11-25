import { describe, expect, it, jest } from "@jest/globals";
import { Script } from "node:vm";
import { BrowserLiveViewer } from "../src/control-plane/browser-live-viewer.js";

const sourceRuntime =
  "rt_11111111-1111-4111-8111-111111111111";
const otherRuntime =
  "rt_22222222-2222-4222-8222-222222222222";
const browserEpoch =
  "33333333-3333-4333-8333-333333333333";
const base =
  `https://edge.example/viewer/runtime/${sourceRuntime}/${browserEpoch}/task-1/tab-1`;

function fixture(manualEnabled = false) {
  const records = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => records.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => {
      records.set(key, value);
    },
    delete: async (key: string) => records.delete(key),
  };
  const access = jest.fn(async (userId: string) => userId === "user-a");
  let deviceAuthorized = true;
  let credentialVersion = "v1";
  const frame = jest.fn(async () =>
    new Response(JSON.stringify({
      seq: 1,
      data: "/9j/",
      width: 320,
      height: 200,
      capturedAt: 1,
    }), {
      headers: { "content-type": "application/json" },
    }),
  );
  const control = jest.fn(async (_request: Request, _userId: string, _scope: unknown, _body: string) => new Response(null, { status: 204 }));
  const viewer = new BrowserLiveViewer(storage, {
    authenticate: async (password) =>
      password === "shared"
        ? { userId: "user-a", credentialVersion: "v1" }
        : null,
    credentialVersion: async () => credentialVersion,
    registerViewerDevice: async () => "viewer-device-1",
    viewerDeviceAuthorized: async (userId, deviceId) =>
      deviceAuthorized &&
      userId === "user-a" &&
      deviceId === "viewer-device-1",
    authorizeSource: access,
    frame,
    ...(manualEnabled ? { control } : {}),
  });
  return {
    viewer,
    control,
    access,
    frame,
    records,
    revokeDevice: () => {
      deviceAuthorized = false;
    },
    rotateCredential: () => {
      credentialVersion = "v2";
    },
  };
}

function loginRequest(url = base): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      origin: "https://edge.example",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      owner_password: "shared",
    }),
  });
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

describe("BrowserLiveViewer", () => {
  it("requires a same-origin authenticated runtime viewer and binds control to its exact tab", async () => {
    const { viewer, control, revokeDevice } = fixture(true);
    const login = await viewer.handle(loginRequest());
    const cookie = cookieHeader(login);
    const page = await viewer.handle(new Request(base, { headers: { cookie } }));
    const html = await page.text();
    expect(html).toContain("Assumir controle");
    expect(html).toContain("Manter sessão até o reinício");
    expect(() => new Script(html.split("<script>")[1]!.split("</script>")[0]!)).not.toThrow();
    const send = (body: unknown, useCookie = cookie, origin = "https://edge.example", url = base) =>
      viewer.handle(new Request(url + "/control", { method: "POST",
        headers: { cookie: useCookie, origin, "content-type": "application/json" },
        body: JSON.stringify(body) }));
    expect((await send({ action: "take" }, "")).status).toBe(401);
    expect((await send({ action: "take" }, cookie, "https://evil.example")).status).toBe(403);
    expect((await send({ action: "take", tabId: "other" })).status).toBe(400);
    expect((await send({ action: "take" }, cookie, "https://edge.example", base.replace("tab-1", "tab-2"))).status).toBe(401);
    expect(control).not.toHaveBeenCalled();
    expect((await send({ action: "take" })).status).toBe(204);
    const first = JSON.parse(control.mock.calls[0]![3]);
    expect(first).toEqual({ action: "take", taskId: "task-1", tabId: "tab-1", controlId: expect.any(String) });
    expect((await send({ action: "release", keepSession: true })).status).toBe(204);
    expect(JSON.parse(control.mock.calls[1]![3])).toEqual({ ...first, action: "release", keepSession: true });
    revokeDevice();
    expect((await send({ action: "take" })).status).toBe(401);
    expect(control).toHaveBeenCalledTimes(2);
  });

  it("does not expose remote control on personal device viewers", async () => {
    const { viewer, control } = fixture(true);
    const deviceUrl = "https://edge.example/viewer/device/dev_11111111-1111-4111-8111-111111111111/task-1/tab-1";
    const cookie = cookieHeader(await viewer.handle(loginRequest(deviceUrl)));
    const page = await viewer.handle(new Request(deviceUrl, { headers: { cookie } }));
    expect(await page.text()).not.toContain("Assumir controle");
    const response = await viewer.handle(new Request(deviceUrl + "/control", { method: "POST",
      headers: { cookie, origin: "https://edge.example", "content-type": "application/json" },
      body: '{"action":"take"}' }));
    expect(response.status).toBe(403);
    expect(control).not.toHaveBeenCalled();
  });

  it("keeps separate session cookies for two live tabs", async () => {
    const { viewer } = fixture();
    const second =
      `https://edge.example/viewer/runtime/${sourceRuntime}/${browserEpoch}/task-1/tab-2`;
    const firstLogin = await viewer.handle(loginRequest());
    const secondLogin = await viewer.handle(loginRequest(second));

    expect(firstLogin.headers.getSetCookie()[0]).toContain(
      `Path=/viewer/runtime/${sourceRuntime}/${browserEpoch}/task-1/tab-1;`,
    );
    expect(secondLogin.headers.getSetCookie()[0]).toContain(
      `Path=/viewer/runtime/${sourceRuntime}/${browserEpoch}/task-1/tab-2;`,
    );
    expect(firstLogin.headers.getSetCookie()[0]).not.toBe(
      secondLogin.headers.getSetCookie()[0],
    );
  });

  it("rate limits repeated failed logins without creating a viewer session", async () => {
    const { viewer, records } = fixture();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await viewer.handle(new Request(base, {
        method: "POST",
        headers: {
          origin: "https://edge.example",
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "203.0.113.2",
        },
        body: new URLSearchParams({
          owner_password: "wrong",
        }),
      }));
      expect(response.status).toBe(401);
    }

    const blocked = await viewer.handle(new Request(base, {
      method: "POST",
      headers: {
        origin: "https://edge.example",
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.2",
      },
      body: new URLSearchParams({
        owner_password: "shared",
      }),
    }));
    expect(blocked.status).toBe(429);
    expect(
      [...records.keys()].some((key) =>
        key.startsWith("browser-viewer-session:"),
      ),
    ).toBe(false);
  });

  it("keeps an authorized session across a temporary source disconnect", async () => {
    const { viewer, frame } = fixture();
    const login = await viewer.handle(loginRequest());
    const cookie = cookieHeader(login);
    frame.mockImplementationOnce(async () => new Response(null, { status: 503 }));

    expect(
      (await viewer.handle(new Request(`${base}/frame`, {
        headers: { cookie },
      }))).status,
    ).toBe(503);
    expect(
      (await viewer.handle(new Request(`${base}/frame`, {
        headers: { cookie },
      }))).status,
    ).toBe(200);
  });

  it("binds the viewer session to one runtime/task/tab and returns frames only after login", async () => {
    const { viewer, frame } = fixture();

    const loginPage = await viewer.handle(new Request(base));
    expect(loginPage.status).toBe(200);
    expect(loginPage.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    const loginHtml = await loginPage.text();
    expect(loginHtml).toContain("Access password");
    expect(loginHtml).not.toContain("Profile name");
    expect(loginHtml).not.toContain("Personal password");
    expect((await viewer.handle(new Request(`${base}/frame`))).status).toBe(401);

    const login = await viewer.handle(loginRequest());
    expect(login.status).toBe(303);
    const cookies = login.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies[0]).toContain("SameSite=Strict");
    const sessionCookie = cookieHeader(login);

    expect(
      (await viewer.handle(new Request(`${base}/frame`, {
        headers: { cookie: cookies[0]!.split(";")[0]! },
      }))).status,
    ).toBe(401);

    const authorized = await viewer.handle(
      new Request(`${base}/frame?afterSeq=0`, {
        headers: { cookie: sessionCookie },
      }),
    );
    expect(authorized.status).toBe(200);
    expect(frame).toHaveBeenCalledWith(
      expect.any(Request),
      "user-a",
      {
        kind: "runtime",
        runtimeId: sourceRuntime,
        browserEpoch,
        taskId: "task-1",
        tabId: "tab-1",
      },
      0,
    );

    expect(
      (await viewer.handle(new Request(
        `https://edge.example/viewer/runtime/${otherRuntime}/${browserEpoch}/task-1/tab-1/frame`,
        { headers: { cookie: sessionCookie } },
      ))).status,
    ).toBe(401);

    expect(
      (await viewer.handle(new Request(base, {
        method: "POST",
        headers: { cookie: sessionCookie },
      }))).status,
    ).toBe(403);
  });

  it("denies ended sources, revoked viewer devices and rotated credentials", async () => {
    const {
      viewer,
      access,
      frame,
      revokeDevice,
      rotateCredential,
    } = fixture();

    access.mockImplementation(async () => false);
    expect((await viewer.handle(loginRequest())).status).toBe(404);

    access.mockImplementation(async () => true);
    const login = await viewer.handle(loginRequest());
    const cookie = cookieHeader(login);

    access.mockImplementation(async () => false);
    expect(
      (await viewer.handle(new Request(`${base}/frame`, {
        headers: { cookie },
      }))).status,
    ).toBe(404);

    access.mockImplementation(async () => true);
    revokeDevice();
    expect(
      (await viewer.handle(new Request(`${base}/frame`, {
        headers: { cookie },
      }))).status,
    ).toBe(401);

    rotateCredential();
    expect(
      (await viewer.handle(new Request(`${base}/frame`, {
        headers: { cookie },
      }))).status,
    ).toBe(401);
    expect(frame).not.toHaveBeenCalled();
  });
});
