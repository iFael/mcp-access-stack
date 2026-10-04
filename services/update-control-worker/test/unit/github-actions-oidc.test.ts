import { describe, expect, it } from "@jest/globals";
import {
  GitHubActionsOidcAssertionVerifier,
  githubActionsOAuthReprovisionAudience,
} from "../../src/github-actions-oidc.js";
import {
  createTestGitHubActionsAssertion,
  testGitHubActionsJwksFetch,
} from "./github-actions-oidc-fixture.js";

const OPERATION_ID = "e7a9b330-4300-4a15-bdad-b6679b1a95f1";
const OTHER_OPERATION_ID = "4399a147-25b7-4d63-b84f-d0f786321b4f";

describe("GitHub Actions OIDC assertion verifier for fixed OAuth reprovision operation", () => {
  it("accepts a valid workflow_dispatch assertion bound to the exact operation UUID", async () => {
    const verifier = new GitHubActionsOidcAssertionVerifier(testGitHubActionsJwksFetch);
    const token = await createTestGitHubActionsAssertion(OPERATION_ID);
    await expect(verifier.verify(token, OPERATION_ID)).resolves.toBe(true);
    await expect(verifier.verify(token, OTHER_OPERATION_ID)).resolves.toBe(false);
    expect(githubActionsOAuthReprovisionAudience(OPERATION_ID))
      .toBe(`urn:mcp-v3-update-control:oauth-reprovision:${OPERATION_ID}`);
  });

  it.each([
    ["issuer", { iss: "https://github.com" }],
    ["audience", { aud: "urn:mcp-v3-update-control:oauth-reprovision:wrong" }],
    ["repository", { repository: "attacker/mcp-access-stack" }],
    ["workflow_ref", { workflow_ref: "iFael/mcp-access-stack/.github/workflows/other.yml@refs/heads/main" }],
    ["ref", { ref: "refs/heads/feature" }],
    ["event_name", { event_name: "pull_request" }],
    ["environment", { environment: "other-environment" }],
    ["sub", { sub: "repo:iFael/mcp-access-stack:ref:refs/heads/main" }],
    ["expired exp", { exp: Math.floor(Date.now() / 1000) - 1 }],
    ["missing exp", { exp: undefined }],
    ["future nbf", { nbf: Math.floor(Date.now() / 1000) + 60 }],
    ["missing nbf", { nbf: undefined }],
    ["future iat", { iat: Math.floor(Date.now() / 1000) + 60 }],
    ["stale iat", { iat: Math.floor(Date.now() / 1000) - 601 }],
    ["missing iat", { iat: undefined }],
  ])("rejects invalid %s claims", async (_label, claims) => {
    const verifier = new GitHubActionsOidcAssertionVerifier(testGitHubActionsJwksFetch);
    const token = await createTestGitHubActionsAssertion(OPERATION_ID, claims);
    await expect(verifier.verify(token, OPERATION_ID)).resolves.toBe(false);
  });

  it("rejects malformed tokens, unsupported algorithms, and invalid signatures", async () => {
    const verifier = new GitHubActionsOidcAssertionVerifier(testGitHubActionsJwksFetch);
    await expect(verifier.verify("not.a.jwt", OPERATION_ID)).resolves.toBe(false);
    await expect(verifier.verify("x".repeat(8193), OPERATION_ID)).resolves.toBe(false);

    const unsupported = await createTestGitHubActionsAssertion(OPERATION_ID, {}, { alg: "none" });
    await expect(verifier.verify(unsupported, OPERATION_ID)).resolves.toBe(false);

    const valid = await createTestGitHubActionsAssertion(OPERATION_ID);
    const parts = valid.split(".");
    parts[2] = "A".repeat(parts[2]!.length);
    await expect(verifier.verify(parts.join("."), OPERATION_ID)).resolves.toBe(false);
  });

  it("fails closed when GitHub JWKS is unavailable or malformed", async () => {
    const unavailable = new GitHubActionsOidcAssertionVerifier(async () => new Response(null, { status: 503 }));
    await expect(unavailable.verify(await createTestGitHubActionsAssertion(OPERATION_ID), OPERATION_ID))
      .resolves.toBe(false);

    const malformed = new GitHubActionsOidcAssertionVerifier(async () =>
      new Response(JSON.stringify({ keys: [] }), { status: 200 }));
    await expect(malformed.verify(await createTestGitHubActionsAssertion(OPERATION_ID), OPERATION_ID))
      .resolves.toBe(false);
  });
});
