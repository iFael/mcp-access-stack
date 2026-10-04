import { describe, expect, it } from "@jest/globals";
import { CloudflareAccessAssertionVerifier } from "../../src/cloudflare-access-assertion.js";
import {
  createTestAccessAssertion,
  TEST_ACCESS_AUDIENCE,
  TEST_ACCESS_ISSUER,
  testAccessJwksFetch,
} from "./access-assertion-fixture.js";

describe("Cloudflare Access assertion verifier", () => {
  it("accepts only a signed RS256 assertion with the configured issuer and audience", async () => {
    const verifier = new CloudflareAccessAssertionVerifier(testAccessJwksFetch);
    const assertion = await createTestAccessAssertion();
    await expect(verifier.verify(assertion, TEST_ACCESS_ISSUER, TEST_ACCESS_AUDIENCE)).resolves.toBe(true);
    await expect(verifier.verify(assertion, TEST_ACCESS_ISSUER, "different-audience")).resolves.toBe(false);
    await expect(verifier.verify(assertion, "https://other.cloudflareaccess.com", TEST_ACCESS_AUDIENCE)).resolves.toBe(false);
  });

  it("rejects invalid signatures, expiry, future not-before, unsupported algorithms, and oversized values", async () => {
    const verifier = new CloudflareAccessAssertionVerifier(testAccessJwksFetch);
    const assertion = await createTestAccessAssertion();
    const parts = assertion.split(".");
    parts[2] = "A".repeat(parts[2]!.length);
    await expect(verifier.verify(parts.join("."), TEST_ACCESS_ISSUER, TEST_ACCESS_AUDIENCE)).resolves.toBe(false);
    await expect(verifier.verify(
      await createTestAccessAssertion({ exp: Math.floor(Date.now() / 1000) - 600 }),
      TEST_ACCESS_ISSUER,
      TEST_ACCESS_AUDIENCE,
    )).resolves.toBe(false);
    await expect(verifier.verify(
      await createTestAccessAssertion({ nbf: Math.floor(Date.now() / 1000) + 600 }),
      TEST_ACCESS_ISSUER,
      TEST_ACCESS_AUDIENCE,
    )).resolves.toBe(false);

    const unsupported = assertion.split(".");
    const header = btoa(JSON.stringify({ alg: "none", kid: "test-access-key-1" }))
      .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    unsupported[0] = header;
    await expect(verifier.verify(unsupported.join("."), TEST_ACCESS_ISSUER, TEST_ACCESS_AUDIENCE)).resolves.toBe(false);
    await expect(verifier.verify("x".repeat(8193), TEST_ACCESS_ISSUER, TEST_ACCESS_AUDIENCE)).resolves.toBe(false);
  });

  it("fails closed when the Access key endpoint is unavailable or malformed", async () => {
    const unavailable = new CloudflareAccessAssertionVerifier(async () => new Response(null, { status: 503 }));
    await expect(unavailable.verify(
      await createTestAccessAssertion(),
      TEST_ACCESS_ISSUER,
      TEST_ACCESS_AUDIENCE,
    )).resolves.toBe(false);

    const malformed = new CloudflareAccessAssertionVerifier(async () => new Response(
      JSON.stringify({ keys: [] }),
      { status: 200 },
    ));
    await expect(malformed.verify(
      await createTestAccessAssertion(),
      TEST_ACCESS_ISSUER,
      TEST_ACCESS_AUDIENCE,
    )).resolves.toBe(false);
  });
});
