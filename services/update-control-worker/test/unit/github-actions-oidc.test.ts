import { describe, expect, it, jest } from "@jest/globals";
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
    ["repository_owner_id", { repository_owner_id: "999999999" }],
    ["repository_id", { repository_id: "999999999" }],
    ["workflow_ref", { workflow_ref: "iFael/mcp-access-stack/.github/workflows/other.yml@refs/heads/main" }],
    ["ref", { ref: "refs/heads/feature" }],
    ["event_name", { event_name: "pull_request" }],
    ["environment", { environment: "other-environment" }],
    ["legacy sub", { sub: "repo:iFael/mcp-access-stack:environment:update-control-production" }],
    ["wrong immutable sub", { sub: "repo:iFael@185357494/mcp-access-stack@999999999:environment:update-control-production" }],
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

  it("invokes injected fetch without an unrelated receiver", async () => {
    const receiverSensitiveFetch = function(this: unknown, input: RequestInfo | URL): Promise<Response> {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return testGitHubActionsJwksFetch(input);
    } as typeof fetch;
    const verifier = new GitHubActionsOidcAssertionVerifier(receiverSensitiveFetch);
    const token = await createTestGitHubActionsAssertion(OPERATION_ID);
    await expect(verifier.verify(token, OPERATION_ID)).resolves.toBe(true);
  });

  it("reports bounded internal failure stages without exposing token material", async () => {
    const token = await createTestGitHubActionsAssertion(OPERATION_ID);
    const unavailable = new GitHubActionsOidcAssertionVerifier(async () => new Response(null, { status: 503 }));
    await expect(unavailable.verifyWithStage(token, OPERATION_ID))
      .resolves.toEqual({ valid: false, stage: "jwks_http" });

    const malformed = new GitHubActionsOidcAssertionVerifier(async () =>
      new Response(JSON.stringify({ keys: [] }), { status: 200 }));
    await expect(malformed.verifyWithStage(token, OPERATION_ID))
      .resolves.toEqual({ valid: false, stage: "jwks_shape" });

    const invalid = token.split(".");
    invalid[2] = "A".repeat(invalid[2]!.length);
    const signature = new GitHubActionsOidcAssertionVerifier(testGitHubActionsJwksFetch);
    await expect(signature.verifyWithStage(invalid.join("."), OPERATION_ID))
      .resolves.toEqual({ valid: false, stage: "signature" });
  });

  it("classifies request setup failures without invoking fetch", async () => {
    const token = await createTestGitHubActionsAssertion(OPERATION_ID);
    const fetchImpl = jest.fn(testGitHubActionsJwksFetch);
    const timeoutSpy = jest.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      throw new TypeError("unsafe request setup detail");
    });
    try {
      const verifier = new GitHubActionsOidcAssertionVerifier(fetchImpl);
      const result = await verifier.verifyWithStage(token, OPERATION_ID);
      expect(result).toEqual({
        valid: false,
        stage: "jwks_fetch",
        jwksFetchFailureCategory: "request_setup",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("unsafe request setup detail");
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("classifies a synchronous fetch throw without preserving the error", async () => {
    const token = await createTestGitHubActionsAssertion(OPERATION_ID);
    const fetchImpl = (() => {
      throw new TypeError("unsafe synchronous fetch detail");
    }) as typeof fetch;
    const result = await new GitHubActionsOidcAssertionVerifier(fetchImpl)
      .verifyWithStage(token, OPERATION_ID);
    expect(result).toEqual({
      valid: false,
      stage: "jwks_fetch",
      jwksFetchFailureCategory: "fetch_sync_throw",
    });
    expect(JSON.stringify(result)).not.toContain("unsafe synchronous fetch detail");
  });

  it("classifies a rejected fetch promise without preserving the error", async () => {
    const token = await createTestGitHubActionsAssertion(OPERATION_ID);
    const fetchImpl = (async () => {
      throw new TypeError("unsafe rejected fetch detail");
    }) as typeof fetch;
    const result = await new GitHubActionsOidcAssertionVerifier(fetchImpl)
      .verifyWithStage(token, OPERATION_ID);
    expect(result).toEqual({
      valid: false,
      stage: "jwks_fetch",
      jwksFetchFailureCategory: "fetch_rejected",
      jwksFetchRejectionClass: "type_error",
      jwksFetchTypeErrorReason: "unknown_type_error",
    });
    expect(JSON.stringify(result)).not.toContain("unsafe rejected fetch detail");
  });

  it.each([
    ["documented network failure", "Network connection lost", "network_connection_lost"],
    ["unrecognized TypeError message", "raw-message-sentinel", "unknown_type_error"],
  ])("maps only the exact documented TypeError reason for %s", async (_label, rawMessage, expectedReason) => {
    const token = await createTestGitHubActionsAssertion(OPERATION_ID);
    const rawStack = "raw-stack-sentinel";
    const rawCause = "raw-cause-sentinel";
    const rejected = new TypeError(rawMessage);
    rejected.stack = rawStack;
    Object.defineProperty(rejected, "cause", { value: rawCause });
    const fetchImpl = (async () => {
      throw rejected;
    }) as typeof fetch;
    const result = await new GitHubActionsOidcAssertionVerifier(fetchImpl)
      .verifyWithStage(token, OPERATION_ID);
    expect(result).toEqual({
      valid: false,
      stage: "jwks_fetch",
      jwksFetchFailureCategory: "fetch_rejected",
      jwksFetchRejectionClass: "type_error",
      jwksFetchTypeErrorReason: expectedReason,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(rawMessage);
    expect(serialized).not.toContain(rawStack);
    expect(serialized).not.toContain(rawCause);
  });

  it.each([
    ["Error", new Error("unsafe rejection detail"), "error"],
    ["TypeError", new TypeError("unsafe rejection detail"), "type_error"],
    ["DOMException AbortError", new DOMException("unsafe rejection detail", "AbortError"), "abort_error"],
    ["DOMException TimeoutError", new DOMException("unsafe rejection detail", "TimeoutError"), "timeout_error"],
    ["unlisted Error name", Object.assign(new Error("unsafe rejection detail"), { name: "UnlistedDiagnosticName" }), "other_error"],
    ["non-Error value", { name: "TypeError", message: "unsafe rejection detail" }, "non_error"],
  ])("returns only the closed rejection class for %s", async (_label, rejected, rejectionClass) => {
    const token = await createTestGitHubActionsAssertion(OPERATION_ID);
    const fetchImpl = (async () => {
      throw rejected;
    }) as typeof fetch;
    const result = await new GitHubActionsOidcAssertionVerifier(fetchImpl)
      .verifyWithStage(token, OPERATION_ID);
    expect(result).toEqual({
      valid: false,
      stage: "jwks_fetch",
      jwksFetchFailureCategory: "fetch_rejected",
      jwksFetchRejectionClass: rejectionClass,
      ...(rejectionClass === "type_error"
        ? { jwksFetchTypeErrorReason: "unknown_type_error" }
        : {}),
    });
    expect(JSON.stringify(result)).not.toContain("unsafe rejection detail");
    expect(JSON.stringify(result)).not.toContain("UnlistedDiagnosticName");
  });

  it("classifies an aborted timeout signal deterministically without waiting", async () => {
    const token = await createTestGitHubActionsAssertion(OPERATION_ID);
    const timeoutController = new AbortController();
    const timeoutSpy = jest.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      timeoutController.abort(new DOMException("simulated timeout", "TimeoutError"));
      return timeoutController.signal;
    });
    const fetchImpl = (async () => {
      throw timeoutController.signal.reason;
    }) as typeof fetch;
    try {
      const result = await new GitHubActionsOidcAssertionVerifier(fetchImpl)
        .verifyWithStage(token, OPERATION_ID);
      expect(result).toEqual({
        valid: false,
        stage: "jwks_fetch",
        jwksFetchFailureCategory: "timeout",
      });
      expect(result.jwksFetchRejectionClass).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("simulated timeout");
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("keeps an unrelated rejection classified as fetch_rejected after signal abort", async () => {
    const token = await createTestGitHubActionsAssertion(OPERATION_ID);
    const timeoutController = new AbortController();
    const timeoutSpy = jest.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      timeoutController.abort(new DOMException("simulated timeout", "TimeoutError"));
      return timeoutController.signal;
    });
    const fetchImpl = (async () => {
      throw new TypeError("unrelated rejection detail");
    }) as typeof fetch;
    try {
      const result = await new GitHubActionsOidcAssertionVerifier(fetchImpl)
        .verifyWithStage(token, OPERATION_ID);
      expect(result).toEqual({
        valid: false,
        stage: "jwks_fetch",
        jwksFetchFailureCategory: "fetch_rejected",
        jwksFetchRejectionClass: "type_error",
        jwksFetchTypeErrorReason: "unknown_type_error",
      });
      expect(JSON.stringify(result)).not.toContain("unrelated rejection detail");
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
