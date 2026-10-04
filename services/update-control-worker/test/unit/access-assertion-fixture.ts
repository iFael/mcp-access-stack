export const TEST_ACCESS_ISSUER = "https://test-team.cloudflareaccess.com";
export const TEST_ACCESS_AUDIENCE = "test-update-control-audience";
export const TEST_ACCESS_KID = "test-access-key-1";

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
    kid: TEST_ACCESS_KID,
    alg: "RS256",
    use: "sig",
  }))();
  return publicJwkPromise;
}

export async function createTestAccessAssertion(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlText(JSON.stringify({ alg: "RS256", typ: "JWT", kid: TEST_ACCESS_KID }));
  const payload = base64UrlText(JSON.stringify({
    iss: TEST_ACCESS_ISSUER,
    aud: [TEST_ACCESS_AUDIENCE],
    iat: now,
    nbf: now - 10,
    exp: now + 300,
    sub: "synthetic-github-workflow",
    ...overrides,
  }));
  const input = header + "." + payload;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    (await getKeyPair()).privateKey,
    new TextEncoder().encode(input),
  );
  return input + "." + base64UrlBytes(new Uint8Array(signature));
}

export async function testAccessJwksFetch(input: RequestInfo | URL): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== TEST_ACCESS_ISSUER + "/cdn-cgi/access/certs") {
    return new Response(null, { status: 404 });
  }
  return new Response(JSON.stringify({ keys: [await getPublicJwk()] }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    },
  });
}

function base64UrlText(value: string): string {
  return base64UrlBytes(new TextEncoder().encode(value));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
