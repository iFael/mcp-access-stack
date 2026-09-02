import { describe, expect, it } from "@jest/globals";
import { canonicalSourceControlArgumentsDigest } from "../src/typed-confirmation.js";
import {
  InMemoryMutationReceiptStore,
  type MutationReceiptIdentity,
} from "../src/mutation-receipts.js";

function identity(
  overrides: Partial<MutationReceiptIdentity> = {},
): MutationReceiptIdentity {
  return {
    workspaceId: "repo",
    operation: "git_commit",
    targetResource: "feature/task3",
    canonicalArgumentsDigest: canonicalSourceControlArgumentsDigest({
      expectedHeadSha: "a".repeat(40),
      expectedIndexTreeSha: "b".repeat(40),
      message: "feat: task 3",
    }),
    idempotencyKey: "idem-task3",
    ...overrides,
  };
}

describe("InMemoryMutationReceiptStore", () => {
  it("supports reserve -> executing -> completed and completed replay", async () => {
    const store = new InMemoryMutationReceiptStore();
    const expected = identity();

    const reservation = await store.reserve(expected);
    expect(reservation).toMatchObject({
      disposition: "execute",
      receipt: { state: "reserved", identity: expected },
    });

    const executing = await store.markExecuting(expected);
    expect(executing.state).toBe("executing");

    const completed = await store.markCompleted(expected, {
      branch: "feature/task3",
      commitSha: "c".repeat(40),
    });
    expect(completed).toMatchObject({
      state: "completed",
      result: {
        branch: "feature/task3",
        commitSha: "c".repeat(40),
      },
    });

    const replay = await store.reserve(expected);
    expect(replay).toMatchObject({
      disposition: "replay_completed",
      receipt: {
        state: "completed",
        result: {
          branch: "feature/task3",
          commitSha: "c".repeat(40),
        },
      },
    });
  });

  it("rejects the same idempotency key when canonical identity changes", async () => {
    const store = new InMemoryMutationReceiptStore();
    await store.reserve(identity());

    await expect(
      store.reserve(
        identity({
          operation: "git_merge_branch",
          canonicalArgumentsDigest: canonicalSourceControlArgumentsDigest({
            sourceBranch: "feature/other",
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_IDEMPOTENCY_CONFLICT" });
  });

  it("never returns backend execution intent for an already executing mutation", async () => {
    const store = new InMemoryMutationReceiptStore();
    const expected = identity();
    await store.reserve(expected);
    await store.markExecuting(expected);

    const second = await store.reserve(expected);

    expect(second.disposition).toBe("reconciliation_required");
    expect(second.receipt.state).toBe("executing");
  });

  it("keeps reconciliation_required explicit and can complete only after reconciliation", async () => {
    const store = new InMemoryMutationReceiptStore();
    const expected = identity();
    await store.reserve(expected);
    await store.markExecuting(expected);

    const reconciling = await store.markReconciliationRequired(expected);
    expect(reconciling.state).toBe("reconciliation_required");

    const repeated = await store.reserve(expected);
    expect(repeated.disposition).toBe("reconciliation_required");
    expect(repeated.receipt.state).toBe("reconciliation_required");

    const completed = await store.markCompleted(expected, {
      branch: "feature/task3",
      commitSha: "d".repeat(40),
    });
    expect(completed.state).toBe("completed");
  });

  it.each([
    { token: "secret" },
    { authorization: "Bearer secret" },
    { confirmationId: "opaque-grant" },
    { nested: { refreshToken: "secret" } },
    { githubToken: "secret" },
    { authorizationHeader: "Bearer secret" },
  ])("rejects sensitive fields from completed public results: %j", async (result) => {
    const store = new InMemoryMutationReceiptStore();
    const expected = identity();
    await store.reserve(expected);
    await store.markExecuting(expected);

    await expect(store.markCompleted(expected, result)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect((await store.get(expected.idempotencyKey))?.state).toBe("executing");
  });

  it("rejects invalid receipt transitions", async () => {
    const store = new InMemoryMutationReceiptStore();
    const expected = identity();

    await expect(store.markExecuting(expected)).rejects.toMatchObject({
      code: "EXECUTION_STATE_INVALID",
    });

    await store.reserve(expected);
    await expect(
      store.markCompleted(expected, { commitSha: "c".repeat(40) }),
    ).rejects.toMatchObject({ code: "EXECUTION_STATE_INVALID" });
  });
});
