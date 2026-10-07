import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  BASE_URL,
  bootstrapAndEnrollAdmin,
  beginUserLogin,
  cookiePair,
  cookieValue,
  createHarness,
  csrfFromHtml,
  findStoredUserByEmail,
  joinUser,
  postForm,
  submitUserLogin,
  totp,
} from "../helpers/oauth-session-fixtures.js";

const FIXED_NOW = new Date("2026-10-07T12:00:00.000Z");

describe("human /user session flow", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("GET and POST /user create one generic server-validated session with a hardened cookie", async () => {
    const { controller, storage } = createHarness();
    const enrollment = await bootstrapAndEnrollAdmin(controller, storage);

    const loginForm = await beginUserLogin(controller);
    expect(loginForm.response.status).toBe(200);
    expect(loginForm.state.length > 0).toBe(true);
    expect(loginForm.html).toContain("Verification code");

    jest.advanceTimersByTime(30_000);
    const code = await totp(enrollment.secret, Date.now());
    const login = await submitUserLogin(controller, loginForm.state, enrollment.email, code);
    expect(login.status).toBe(302);

    const setCookie = login.headers.get("set-cookie") ?? "";
    const cookie = cookiePair(login);
    const token = cookieValue(cookie);
    expect(cookie.length > 0).toBe(true);
    expect(/(?:^|;\s*)HttpOnly(?:;|$)/iu.test(setCookie)).toBe(true);
    expect(/(?:^|;\s*)Secure(?:;|$)/iu.test(setCookie)).toBe(true);
    expect(/(?:^|;\s*)SameSite=Lax(?:;|$)/iu.test(setCookie)).toBe(true);
    expect(/(?:^|;\s*)Path=\/(?:;|$)/iu.test(setCookie)).toBe(true);

    const stored = JSON.stringify([...storage.values.entries()]);
    expect(token.length > 0 && stored.includes(token)).toBe(false);

    const admin = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
      headers: { cookie },
    }));
    expect(admin.status).toBe(200);

    const tamperedCookie = cookie.replace(token, token + "x");
    const tampered = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
      headers: { cookie: tamperedCookie },
    }));
    expect(tampered.status === 200).toBe(false);

    const cookieOnlyMcp = await controller.fetch(new Request(new URL("/mcp", BASE_URL), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(cookieOnlyMcp.status).toBe(401);
  });

  it("TOTP and recovery credentials are one-shot, and the login form state cannot be replayed", async () => {
    const { controller, storage } = createHarness();
    const enrollment = await bootstrapAndEnrollAdmin(controller, storage);

    jest.advanceTimersByTime(30_000);
    const code = await totp(enrollment.secret, Date.now());
    const firstForm = await beginUserLogin(controller);
    expect(firstForm.response.status).toBe(200);
    const firstLogin = await submitUserLogin(controller, firstForm.state, enrollment.email, code);
    expect(firstLogin.status).toBe(302);

    const formStateReplay = await submitUserLogin(controller, firstForm.state, enrollment.email, code);
    expect(formStateReplay.status === 302).toBe(false);

    if (await totp(enrollment.secret, Date.now() + 30_000) === code) {
      jest.advanceTimersByTime(30_000);
    }
    const freshFormForReplay = await beginUserLogin(controller);
    const totpReplay = await submitUserLogin(
      controller,
      freshFormForReplay.state,
      enrollment.email,
      code,
    );
    expect(totpReplay.status === 302).toBe(false);

    const recovery = enrollment.recoveryCodes[0] ?? "";
    const recoveryForm = await beginUserLogin(controller);
    const recoveryLogin = await submitUserLogin(
      controller,
      recoveryForm.state,
      enrollment.email,
      recovery,
    );
    expect(recoveryLogin.status).toBe(302);

    const recoveryReplayForm = await beginUserLogin(controller);
    const recoveryReplay = await submitUserLogin(
      controller,
      recoveryReplayForm.state,
      enrollment.email,
      recovery,
    );
    expect(recoveryReplay.status === 302).toBe(false);
  });

  it("legacy operator and viewer records remain user-level and cannot obtain /admin access", async () => {
    for (const legacyRole of ["operator", "viewer"] as const) {
      const { controller, storage } = createHarness();
      const enrollment = await bootstrapAndEnrollAdmin(controller, storage);
      const record = findStoredUserByEmail(storage, enrollment.email);
      expect(record !== undefined).toBe(true);
      if (!record) continue;
      record.role = legacyRole;

      const loginForm = await beginUserLogin(controller);
      expect(loginForm.response.status).toBe(200);
      const login = await submitUserLogin(
        controller,
        loginForm.state,
        enrollment.email,
        enrollment.recoveryCodes[0] ?? "",
      );
      expect(login.status).toBe(302);
      const admin = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
        headers: { cookie: cookiePair(login) },
      }));
      expect(admin.status === 200).toBe(false);
      expect(record.role === "admin").toBe(false);
    }
  });

  it("an unrecognized stored role fails closed and creates no privileged session", async () => {
    const { controller, storage } = createHarness();
    const enrollment = await bootstrapAndEnrollAdmin(controller, storage);
    const record = findStoredUserByEmail(storage, enrollment.email);
    expect(record !== undefined).toBe(true);
    if (!record) return;
    record.role = "root";

    const loginForm = await beginUserLogin(controller);
    expect(loginForm.response.status).toBe(200);
    const login = await submitUserLogin(
      controller,
      loginForm.state,
      enrollment.email,
      enrollment.recoveryCodes[0] ?? "",
    );
    expect(login.status === 302).toBe(false);
    expect((login.headers.get("set-cookie") ?? "").length).toBe(0);
  });

  it("invited users receive role user and a user session never opens /admin", async () => {
    const { controller, storage } = createHarness();
    const adminEnrollment = await bootstrapAndEnrollAdmin(controller, storage);
    const adminLoginForm = await beginUserLogin(controller);
    expect(adminLoginForm.response.status).toBe(200);
    const adminLogin = await submitUserLogin(
      controller,
      adminLoginForm.state,
      adminEnrollment.email,
      adminEnrollment.recoveryCodes[0] ?? "",
    );
    expect(adminLogin.status).toBe(302);

    const userEmail = "ordinary-user@example.invalid";
    const userEnrollment = await joinUser(
      controller,
      storage,
      cookiePair(adminLogin),
      userEmail,
    );
    const userRecord = findStoredUserByEmail(storage, userEmail);
    expect(userRecord?.role).toBe("user");

    const userLoginForm = await beginUserLogin(controller);
    expect(userLoginForm.response.status).toBe(200);
    const userLogin = await submitUserLogin(
      controller,
      userLoginForm.state,
      userEnrollment.email,
      userEnrollment.recoveryCodes[0] ?? "",
    );
    expect(userLogin.status).toBe(302);

    const admin = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
      headers: { cookie: cookiePair(userLogin) },
    }));
    expect(admin.status === 200).toBe(false);
  });

  it("logout is POST-only, requires CSRF, revokes the session, and clears the cookie", async () => {
    const { controller, storage } = createHarness();
    const enrollment = await bootstrapAndEnrollAdmin(controller, storage);
    const loginForm = await beginUserLogin(controller);
    const login = await submitUserLogin(
      controller,
      loginForm.state,
      enrollment.email,
      enrollment.recoveryCodes[0] ?? "",
    );
    expect(login.status).toBe(302);
    const cookie = cookiePair(login);

    const getLogout = await controller.fetch(new Request(new URL("/user/logout", BASE_URL), {
      headers: { cookie },
    }));
    expect(getLogout.status).toBe(405);

    const missingCsrf = await postForm(controller, "/user/logout", {}, cookie);
    expect(missingCsrf.status).toBe(403);
    const userPage = await controller.fetch(new Request(new URL("/user", BASE_URL), {
      headers: { cookie },
    }));
    const csrf = csrfFromHtml(await userPage.text());

    const badCsrf = await postForm(controller, "/user/logout", { csrf: "invalid-csrf" }, cookie);
    expect(badCsrf.status).toBe(403);

    const logout = await postForm(controller, "/user/logout", { csrf }, cookie);
    expect([302, 303].includes(logout.status)).toBe(true);
    const clearedCookie = logout.headers.get("set-cookie") ?? "";
    expect(clearedCookie.length > 0).toBe(true);
    expect(/(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/iu.test(clearedCookie)).toBe(true);

    const replay = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
      headers: { cookie },
    }));
    expect(replay.status === 200).toBe(false);
  });

  it("expires server-side sessions even while the client retains the cookie", async () => {
    const { controller, storage } = createHarness();
    const enrollment = await bootstrapAndEnrollAdmin(controller, storage);
    const loginForm = await beginUserLogin(controller);
    const login = await submitUserLogin(
      controller,
      loginForm.state,
      enrollment.email,
      enrollment.recoveryCodes[0] ?? "",
    );
    expect(login.status).toBe(302);
    const cookie = cookiePair(login);

    const storedSession = [...storage.values.values()].find((value) => {
      if (typeof value !== "object" || value === null) return false;
      const record = value as { userId?: unknown; expiresAt?: unknown };
      return record.userId === enrollment.userId &&
        (typeof record.expiresAt === "string" || typeof record.expiresAt === "number");
    }) as { expiresAt?: string | number } | undefined;
    expect(storedSession !== undefined).toBe(true);
    if (!storedSession) return;
    const expiration = typeof storedSession.expiresAt === "number"
      ? storedSession.expiresAt
      : Date.parse(storedSession.expiresAt ?? "");
    expect(Number.isFinite(expiration)).toBe(true);
    jest.setSystemTime(expiration + 1);

    const expired = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
      headers: { cookie },
    }));
    expect(expired.status === 200).toBe(false);
  });

  it("protects the last admin from demotion and revocation under the new role vocabulary", async () => {
    const { controller, storage } = createHarness();
    const enrollment = await bootstrapAndEnrollAdmin(controller, storage);
    const loginForm = await beginUserLogin(controller);
    const login = await submitUserLogin(
      controller,
      loginForm.state,
      enrollment.email,
      enrollment.recoveryCodes[0] ?? "",
    );
    expect(login.status).toBe(302);
    const cookie = cookiePair(login);
    const adminPage = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
      headers: { cookie },
    }));
    expect(adminPage.status).toBe(200);
    const csrf = csrfFromHtml(await adminPage.text());

    const demote = await postForm(
      controller,
      `/admin/users/${enrollment.userId}/role`,
      { csrf, role: "user" },
      cookie,
    );
    const revoke = await postForm(
      controller,
      `/admin/users/${enrollment.userId}/revoke`,
      { csrf },
      cookie,
    );
    expect([demote.status, revoke.status]).toEqual([409, 409]);
  });
});
