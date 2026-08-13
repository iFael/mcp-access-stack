import { describe, expect, test, jest } from "@jest/globals";
import type {
  OperationContext,
  RelayOperation,
  RelayRequest,
} from "@vs-code-gpt/shared";
import { dispatchRelayRequest } from "../../../src/connection/request-dispatcher.js";
import type { LocalAgent } from "../../../src/local-agent.js";

const operations: RelayOperation[] = [
  "listWorkspaces",
  "listFiles",
  "readFile",
  "readBinaryFile",
  "writeFile",
  "patchFile",
  "runValidation",
  "runCommand",
  "runPowerShell",
  "searchFiles",
  "inspectGit",
  "getWorkspaceContext",
  "startBackgroundTask",
  "getBackgroundTask",
  "listBackgroundTasks",
  "cancelBackgroundTask",
  "readBackgroundTaskLogs",
];

describe("connection request dispatcher", () => {
  test("routes every relay operation to the matching LocalAgent method", async () => {
    const methods = new Map<RelayOperation, ReturnType<typeof jest.fn>>();
    const fakeAgent: Record<string, unknown> = {};
    for (const operation of operations) {
      const handler = jest.fn(async (...args: unknown[]) => args);
      methods.set(operation, handler);
      fakeAgent[operation] = handler;
    }
    const agent = fakeAgent as unknown as LocalAgent;
    const context: OperationContext = {
      correlationId: "request-correlation",
      signal: new AbortController().signal,
    };

    for (const operation of operations) {
      const input = { marker: operation };
      const result = await dispatchRelayRequest(
        agent,
        createRequest(operation, input),
        context,
      );

      expect(methods.get(operation)).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        operation === "listWorkspaces"
          ? [context]
          : [input, context],
      );
    }
  });
});

function createRequest(
  operation: RelayOperation,
  input: unknown,
): RelayRequest {
  return {
    version: 1,
    type: "request",
    requestId: `request-${operation}`,
    deadline: {
      requestedTimeoutMs: 5_000,
      effectiveTimeoutMs: 5_000,
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    },
    operation,
    input: input as never,
  };
}
