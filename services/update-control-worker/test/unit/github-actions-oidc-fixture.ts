import { GITHUB_ACTIONS_OIDC_ISSUER } from "../../src/github-actions-oidc.js";

export const TEST_GITHUB_ACTIONS_KID = "test-github-actions-key-1";
let keyPairPromise: Promise<CryptoKeyPair> | undefined;
let publicJwkPromise: Promise<Record<string, unknown>> | undefined;

async function getKeyPair(): Promise<CryptoKeyPair> {
  keyPairPromise ??= crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
  return keyPairPromise;
}

async function getPublicJwk(): Promise<Record<string, unknown>> {
  publicJwkPromise ??= (async () => ({
    ...await crypto.subtle.exportKey("jwk", (await getKeyPair()).publicKey),
    kid: TEST_GITHUB_ACTIONS_KID,
    alg: "RS256",
    use: "sig",
    key_ops: ["verify"],
  }))();
  return publicJwkPromise;
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

export async function createTestGitHubActionsAssertion(
  operationId: string,
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({
    alg: "RS256",
    typ: "JWT",
    kid: TEST_GITHUB_ACTIONS_KID,
    ...headerOverrides,
  });
  const claims = base64UrlJson({
    iss: GITHUB_ACTIONS_OIDC_ISSUER,
    aud: `urn:mcp-v3-update-control:oauth-reprovision:${operationId}`,
    sub: "repo:iFael@185357494/mcp-access-stack@1379020190:environment:update-control-production",
    repository: "iFael/mcp-access-stack",
    repository_owner_id: "185357494",
    repository_id: "1379020190",
    workflow_ref: "iFael/mcp-access-stack/.github/workflows/update-control-oauth-reprovision.yml@refs/heads/main",
    ref: "refs/heads/main",
    event_name: "workflow_dispatch",
    environment: "update-control-production",
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    jti: crypto.randomUUID(),
    ...overrides,
  });
  const signingInput = header + "." + claims;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    (await getKeyPair()).privateKey,
    new TextEncoder().encode(signingInput),
  );
  return signingInput + "." + base64UrlBytes(new Uint8Array(signature));
}

export async function testGitHubActionsJwksFetch(input: RequestInfo | URL): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== "https://token.actions.githubusercontent.com/.well-known/jwks") {
    return new Response(null, { status: 404 });
  }
  return new Response(JSON.stringify({ keys: [await getPublicJwk()] }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}
