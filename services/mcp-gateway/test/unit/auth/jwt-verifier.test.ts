import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "jose";
import { beforeAll, describe, expect, it } from "@jest/globals";
import {
  AuthenticationError,
  JwtAccessTokenVerifier,
} from "../../../src/auth/jwt-verifier.js";
import { makeGatewayConfig } from "../../support/helpers.js";

describe("JWT access token verification", () => {
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let jwk: JWK;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    privateKey = pair.privateKey;
    jwk = await exportJWK(pair.publicKey);
    jwk.kid = "test-key";
    jwk.alg = "RS256";
  });

  it("accepts a signed token with the expected claims", async () => {
    const verifier = createVerifier(jwk);
    const token = await signToken(privateKey);

    const auth = await verifier.verify(token);

    expect(auth.clientId).toBe("test-client");
    expect(auth.scopes).toContain("workspaces:read");
    expect(auth.extra).toEqual({ subject: "allowed-user" });
  });

  it.each([
    ["issuer", { issuer: "https://wrong.example/" }],
    ["audience", { audience: "https://wrong.example" }],
    ["expiration", { expirationTime: Math.floor(Date.now() / 1_000) - 10 }],
  ])("rejects an invalid %s", async (_name, overrides) => {
    const verifier = createVerifier(jwk);
    const token = await signToken(privateKey, overrides);

    await expect(verifier.verify(token)).rejects.toMatchObject({
      status: 401,
      oauthError: "invalid_token",
    });
  });

  it.each([
    ["scope", { scope: "profile" }],
    ["subject", { subject: "other-user" }],
  ])("rejects an unauthorized %s", async (_name, overrides) => {
    const verifier = createVerifier(jwk);
    const token = await signToken(privateKey, overrides);

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(verifier.verify(token)).rejects.toMatchObject({
      status: 403,
      oauthError: "insufficient_scope",
    });
  });
});

function createVerifier(jwk: JWK): JwtAccessTokenVerifier {
  const config = makeGatewayConfig();
  if (!config.oauth) {
    throw new Error("Test config must include OAuth settings.");
  }
  return new JwtAccessTokenVerifier(
    config.oauth,
    createLocalJWKSet({ keys: [jwk] }),
  );
}

async function signToken(
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
  overrides: {
    issuer?: string;
    audience?: string;
    expirationTime?: number;
    scope?: string;
    subject?: string;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    scope: overrides.scope ?? "openid workspaces:read",
    azp: "test-client",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(overrides.issuer ?? "https://issuer.example/")
    .setAudience(overrides.audience ?? "https://mcp.example")
    .setSubject(overrides.subject ?? "allowed-user")
    .setIssuedAt(now)
    .setExpirationTime(overrides.expirationTime ?? now + 300)
    .sign(privateKey);
}
