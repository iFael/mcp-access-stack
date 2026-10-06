import { describe, expect, it, jest } from "@jest/globals";
import { exchangeMicrosoftAuthorizationCode } from "../../src/microsoft-identity.js";

const ENV = {
  MCP_UPDATE_CONTROL_PUBLIC_URL: "https://update-control.example/",
  MICROSOFT_CLIENT_ID: "11111111-2222-4333-8444-555555555555",
  MICROSOFT_CLIENT_SECRET: "test-microsoft-client-secret-value",
  MICROSOFT_TENANT: "organizations",
};

describe("Microsoft Identity authorization-code exchange", () => {
  it("uses PKCE plus confidential-client credentials, resolves UserInfo, and returns no Microsoft token", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init: init ?? {} });
      if (url.includes("/oauth2/v2.0/token")) {
        return new Response(JSON.stringify({
          token_type: "Bearer",
          access_token: "microsoft-access-token-value-long-enough",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(url).toBe("https://graph.microsoft.com/oidc/userinfo");
      expect((init?.headers as Record<string, string>).authorization)
        .toBe("Bearer microsoft-access-token-value-long-enough");
      return new Response(JSON.stringify({
        sub: "pairwise-microsoft-subject",
        name: "Rafael",
        email: "rafael@example.com",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await exchangeMicrosoftAuthorizationCode(
      ENV,
      "microsoft-authorization-code",
      "v".repeat(43),
      fetchImpl,
    );

    expect(result).toEqual({
      subject: "pairwise-microsoft-subject",
      displayName: "Rafael",
      email: "rafael@example.com",
    });
    expect(requests).toHaveLength(2);
    const tokenBody = new URLSearchParams(String(requests[0]?.init.body));
    expect(tokenBody.get("client_id")).toBe(ENV.MICROSOFT_CLIENT_ID);
    expect(tokenBody.get("client_secret")).toBe(ENV.MICROSOFT_CLIENT_SECRET);
    expect(tokenBody.get("code_verifier")).toBe("v".repeat(43));
    expect(tokenBody.get("redirect_uri")).toBe("https://update-control.example/auth/microsoft/callback");
    expect(tokenBody.get("scope")).toBe("openid profile email");
    expect(JSON.stringify(result)).not.toContain("microsoft-access-token");
    expect(JSON.stringify(result)).not.toContain(ENV.MICROSOFT_CLIENT_SECRET);
  });

  it("fails closed on malformed configuration before network access", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("network must not be reached");
    }) as unknown as typeof fetch;

    for (const overrides of [
      { MICROSOFT_CLIENT_ID: "not-a-guid" },
      { MICROSOFT_CLIENT_SECRET: "short" },
      { MICROSOFT_TENANT: "arbitrary" },
      { MCP_UPDATE_CONTROL_PUBLIC_URL: "http://update-control.example/" },
    ]) {
      await expect(exchangeMicrosoftAuthorizationCode(
        { ...ENV, ...overrides },
        "code",
        "v".repeat(43),
        fetchImpl,
      )).rejects.toThrow();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects oversized, unsuccessful, and malformed Microsoft responses without reflecting credentials", async () => {
    const oversized = "x".repeat(32 * 1024 + 1);
    await expect(exchangeMicrosoftAuthorizationCode(
      ENV,
      "code",
      "v".repeat(43),
      (async () => new Response(oversized, { status: 200 })) as typeof fetch,
    )).rejects.toThrow("size limit");

    const failure = await exchangeMicrosoftAuthorizationCode(
      ENV,
      "code",
      "v".repeat(43),
      (async () => new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).not.toContain(ENV.MICROSOFT_CLIENT_SECRET);

    const malformedUserInfoFetch = jest.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/token")) {
        return new Response(JSON.stringify({
          access_token: "microsoft-access-token-value-long-enough",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: "Missing subject" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(exchangeMicrosoftAuthorizationCode(
      ENV,
      "code",
      "v".repeat(43),
      malformedUserInfoFetch,
    )).rejects.toThrow("identity could not be resolved");
  });
});
