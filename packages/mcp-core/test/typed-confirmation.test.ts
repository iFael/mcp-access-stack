import { describe, expect, it } from "@jest/globals";
import {
  MAX_TYPED_CONFIRMATION_TTL_MS,
  TypedConfirmationRegistry,
  canonicalSourceControlArgumentsDigest,
  type TypedConfirmationBinding,
} from "../src/typed-confirmation.js";

function binding(
  overrides: Partial<TypedConfirmationBinding> = {},
): TypedConfirmationBinding {
  return {
    workspaceId: "repo",
    operation: "git_push_branch",
    targetResource: "origin/feature/task3",
    canonicalArgumentsDigest: canonicalSourceControlArgumentsDigest({
      branch: "feature/task3",
      expectedLocalSha: "a".repeat(40),
    }),
    ...overrides,
  };
}

describe("TypedConfirmationRegistry", () => {
  it("caps confirmation lifetime at ten minutes", () => {
    expect(MAX_TYPED_CONFIRMATION_TTL_MS).toBe(10 * 60 * 1_000);
    expect(
      () => new TypedConfirmationRegistry({ ttlMs: MAX_TYPED_CONFIRMATION_TTL_MS + 1 }),
    ).toThrow(/10 minutes|600000/i);
  });

  it("creates opaque ids and consumes a matching grant only once", () => {
    const now = 1_800_000_000_000;
    const registry = new TypedConfirmationRegistry({ now: () => now });
    const expected = binding();

    const grant = registry.create(expected);

    expect(grant.confirmationId).toMatch(/^[A-Za-z0-9_-]{20,}$/u);
    expect(grant.confirmationId).not.toContain(expected.workspaceId);
    expect(grant.confirmationId).not.toContain(expected.targetResource);
    expect(grant.expiresAt).toBe(
      new Date(now + MAX_TYPED_CONFIRMATION_TTL_MS).toISOString(),
    );

    expect(() => registry.consume(grant.confirmationId, expected)).not.toThrow();
    expect(() => registry.consume(grant.confirmationId, expected)).toThrow(
      expect.objectContaining({ code: "SOURCE_CONTROL_CONFIRMATION_INVALID" }),
    );
  });

  it("expires grants without accepting them", () => {
    let now = 1_800_000_000_000;
    const registry = new TypedConfirmationRegistry({ ttlMs: 1_000, now: () => now });
    const expected = binding();
    const grant = registry.create(expected);

    now += 1_001;

    expect(() => registry.consume(grant.confirmationId, expected)).toThrow(
      expect.objectContaining({ code: "SOURCE_CONTROL_CONFIRMATION_INVALID" }),
    );
  });

  it.each([
    ["workspace", { workspaceId: "other" }],
    ["operation", { operation: "github_create_pull_request" as const }],
    ["target", { targetResource: "origin/other" }],
    [
      "digest",
      {
        canonicalArgumentsDigest: canonicalSourceControlArgumentsDigest({
          branch: "feature/other",
        }),
      },
    ],
  ])("rejects a mismatched %s without consuming the matching grant", (_name, mismatch) => {
    const registry = new TypedConfirmationRegistry();
    const expected = binding();
    const grant = registry.create(expected);

    expect(() => registry.consume(grant.confirmationId, binding(mismatch))).toThrow(
      expect.objectContaining({ code: "SOURCE_CONTROL_CONFIRMATION_INVALID" }),
    );
    expect(() => registry.consume(grant.confirmationId, expected)).not.toThrow();
  });
});

describe("canonicalSourceControlArgumentsDigest", () => {
  it("is independent of object key order", () => {
    expect(canonicalSourceControlArgumentsDigest({ a: 1, b: 2 })).toBe(
      canonicalSourceControlArgumentsDigest({ b: 2, a: 1 }),
    );
  });

  it("changes when semantic arguments change", () => {
    expect(canonicalSourceControlArgumentsDigest({ a: 1 })).not.toBe(
      canonicalSourceControlArgumentsDigest({ a: 2 }),
    );
  });

  it("does not bind the one-shot confirmation id into the canonical arguments", () => {
    expect(
      canonicalSourceControlArgumentsDigest({
        branch: "feature/task3",
        confirmationId: "grant-a",
      }),
    ).toBe(
      canonicalSourceControlArgumentsDigest({
        confirmationId: "grant-b",
        branch: "feature/task3",
      }),
    );
  });

  it.each([
    { token: "secret" },
    { authorization: "Bearer secret" },
    { credential: "secret" },
    { nested: { accessToken: "secret" } },
    { githubToken: "secret" },
    { authorizationHeader: "Bearer secret" },
  ])("rejects credential-like material instead of hashing it: %j", (value) => {
    expect(() => canonicalSourceControlArgumentsDigest(value)).toThrow(/sensitive|credential/i);
  });
});
