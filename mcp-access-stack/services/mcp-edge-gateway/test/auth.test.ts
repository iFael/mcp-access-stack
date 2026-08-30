import { describe, expect, it, beforeAll } from "@jest/globals";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";
import {
  EdgeAuthenticationError,
  createExternalOAuthAuthenticator,
} from "../src/control-plane/auth.js";
import { createMcpControlPlane } from "../src/control-plane/mcp-control-plane.js";

const issuer = "https://issuer.example/";
const audience = "https://edge.example/mcp";
const requiredScope = "mcp:tools";
let privateKey: KeyLike;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  getKey = createLocalJWKSet({ keys: [jwk] });
});

describe("Edge external OAuth authentication", () => {
  it("accepts only signed tokens with exact issuer, audience, subject and required scope", async () => {
    const authenticator = createExternalOAuthAuthenticator({
      issuer,
      audience,
      jwksUrl: new URL("https://issuer.example/jwks"),
      allowedSubjects: new Set(["owner-subject"]),
      requiredScope,
      resourceMetadataUrl: new URL("https://edge.example/.well-known/oauth-protected-resource/mcp"),
    }, getKey);

    const valid = await token({ subject: "owner-subject", audience, scope: `${requiredScope} extra` });
    await expect(authenticator.authenticate(requestWithToken(valid))).resolves.toEqual({
      subject: "owner-subject",
      scopes: [requiredScope, "extra"],
    });

    const wrongAudience = await token({ subject: "owner-subject", audience: "https://other.example/", scope: requiredScope });
    await expect(authenticator.authenticate(requestWithToken(wrongAudience))).rejects.toMatchObject({
      status: 401,
      oauthError: "invalid_token",
    });

    const wrongSubject = await token({ subject: "other-subject", audience, scope: requiredScope });
    await expect(authenticator.authenticate(requestWithToken(wrongSubject))).rejects.toMatchObject({
      status: 403,
      oauthError: "insufficient_scope",
    });

    const wrongScope = await token({ subject: "owner-subject", audience, scope: "other" });
    await expect(authenticator.authenticate(requestWithToken(wrongScope))).rejects.toMatchObject({
      status: 403,
      oauthError: "insufficient_scope",
    });
  });

  it("returns the OAuth challenge instead of leaking an unauthenticated catalog", async () => {
    const authenticator = createExternalOAuthAuthenticator({
      issuer,
      audience,
      jwksUrl: new URL("https://issuer.example/jwks"),
      allowedSubjects: new Set(["owner-subject"]),
      requiredScope,
      resourceMetadataUrl: new URL("https://edge.example/.well-known/oauth-protected-resource/mcp"),
    }, getKey);
    const controlPlane = createMcpControlPlane({
      authenticator,
      execution: {
        isReady: () => false,
        getGeneration: () => null,
        execute: async () => { throw new Error("must not execute"); },
      },
      manifest: [{ name: "list_workspaces", inputSchema: { type: "object" } }],
      catalogMetadata: { toolSetRevision: "stable" },
      serverIdentity: { name: "vs-code-gpt", version: "test" },
    });

    const response = await controlPlane.handle(new Request("https://edge.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(await response.json()).toEqual({ error: "invalid_token" });
  });
});

async function token(input: { subject: string; audience: string; scope: string }): Promise<string> {
  return new SignJWT({ scope: input.scope })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(input.audience)
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function requestWithToken(value: string): Request {
  return new Request("https://edge.example/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${value}` },
  });
}

void EdgeAuthenticationError;