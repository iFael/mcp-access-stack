import { describe, expect, it, jest } from "@jest/globals";
import type { OperationContext, RelayRequest } from "@vs-code-gpt/shared";
import { AgentRequestExecutor } from "../../../src/connection/request-executor.js";
import type { LocalAgent } from "../../../src/local-agent.js";

const SHA = "a".repeat(40);

describe("source-control relay context at the Workspace Agent", () => {
  it("preserves exactly the serializable context fields while keeping signal and deadline local", async () => {
    const githubGetRepository = jest.fn(async (_input: unknown, context: OperationContext) => {
      expect(context).toMatchObject({
        correlationId: "corr-wire",
        invocationId: "inv-wire",
        idempotencyKey: "idem-wire",
        ownerScope: "owner-wire",
        deadline: expect.objectContaining({ requestedTimeoutMs: 5_000 }),
        signal: expect.any(AbortSignal),
      });
      return {
        owner: "octo",
        name: "repo",
        fullName: "octo/repo",
        defaultBranch: "main",
        visibility: "private",
        url: "https://github.com/octo/repo",
      };
    });
    const executor = new AgentRequestExecutor(
      { githubGetRepository } as unknown as LocalAgent,
    );
    const request: RelayRequest = {
      version: 1,
      type: "request",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      deadline: {
        requestedTimeoutMs: 5_000,
        effectiveTimeoutMs: 5_000,
        deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      },
      context: {
        correlationId: "corr-wire",
        invocationId: "inv-wire",
        idempotencyKey: "idem-wire",
        ownerScope: "owner-wire",
      },
      operation: "githubGetRepository",
      input: {
        workspaceId: "test",
        owner: "octo",
        repository: "repo",
      },
    };

    const response = await executor.execute(request, 9);

    expect(response).toMatchObject({ ok: true, result: { fullName: "octo/repo" } });
    expect(githubGetRepository).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(request)).not.toContain("AbortSignal");
    expect(JSON.stringify(request)).not.toContain(SHA);
  });
});
