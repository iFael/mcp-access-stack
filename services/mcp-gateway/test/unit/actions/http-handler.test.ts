import { EventEmitter } from "node:events";
import { describe, expect, jest, test } from "@jest/globals";
import type { OperationContext } from "@vs-code-gpt/shared";
import type { RequestHandler, Response } from "express";
import { z } from "zod";
import {
  assertWorkspaceAllowed,
  createActionHandler,
  withoutConsoleRunId,
} from "../../../src/actions/handler.js";
import {
  statusForActionError,
  type ActionRequest,
} from "../../../src/actions/http.js";
import type { GatewayActionsConfig } from "../../../src/config.js";
import { silentLogger } from "../../support/helpers.js";

const actions: GatewayActionsConfig = {
  tokenSha256: "a".repeat(64),
  workspaceIds: ["project", "legacySite"],
  allowWrite: true,
  allowShell: true,
};

class FakeActionRequest extends EventEmitter {
  body: unknown = {};
  actionRequestId = "request-1";
}

class FakeActionResponse extends EventEmitter {
  writableEnded = false;
  headersSent = false;
  destroyed = false;
  statusCode = 200;
  body: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    this.writableEnded = true;
    return this;
  }
}

describe("GPT Actions HTTP and handler helpers", () => {
  test("maps public application errors to stable HTTP statuses", () => {
    expect(statusForActionError("AUTHENTICATION_FAILED")).toBe(401);
    expect(statusForActionError("PERMISSION_DENIED")).toBe(403);
    expect(statusForActionError("FILE_NOT_FOUND")).toBe(404);
    expect(statusForActionError("COMMAND_CONFIRMATION_INVALID")).toBe(409);
    expect(statusForActionError("LIMIT_EXCEEDED")).toBe(413);
    expect(statusForActionError("AGENT_BUSY")).toBe(429);
    expect(statusForActionError("OPERATION_CANCELLED")).toBe(499);
    expect(statusForActionError("AGENT_UNAVAILABLE")).toBe(503);
    expect(statusForActionError("AGENT_TIMEOUT")).toBe(504);
    expect(statusForActionError("INVALID_ARGUMENT")).toBe(400);
    expect(statusForActionError("INTERNAL_ERROR")).toBe(500);
  });

  test("propagates HTTP client disconnection with structured lifecycle data", async () => {
    const request = new FakeActionRequest();
    const response = new FakeActionResponse();
    request.body = { timeoutMs: 60_000 };
    let activeContext: OperationContext | undefined;
    let markContextReady!: () => void;
    const contextReady = new Promise<void>((resolve) => {
      markContextReady = resolve;
    });
    const handler = createActionHandler(
      z.object({ timeoutMs: z.number().int().positive() }).strict(),
      silentLogger(),
      async (_input, context) => {
        activeContext = context;
        markContextReady();
        return new Promise((_resolve, reject) => {
          const signal = context.signal!;
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      },
    );
    const execution = Promise.resolve(
      handler(
        request as unknown as ActionRequest,
        response as unknown as Response,
        jest.fn(),
      ),
    );

    await contextReady;
    request.emit("aborted");
    await execution;

    expect(activeContext?.signal?.aborted).toBe(true);
    expect(response.statusCode).toBe(499);
    expect(response.body).toMatchObject({
      error: {
        code: "OPERATION_CANCELLED",
        lifecycle: {
          terminatedBy: "http_server",
          reason: "client_disconnected",
        },
      },
    });
  });

  test("enforces the closed workspace allowlist", () => {
    expect(() => assertWorkspaceAllowed(actions, "project")).not.toThrow();
    expect(() => assertWorkspaceAllowed(actions, "legacySite")).not.toThrow();
    expect(() => assertWorkspaceAllowed(actions, "development")).toThrow(
      expect.objectContaining({ code: "PERMISSION_DENIED" }),
    );
  });

  test("removes only the conversational console reference from relay payloads", () => {
    expect(
      withoutConsoleRunId({
        runId: "MT-20260724-0011223344556677",
        workspaceId: "project",
        root: ".",
      }),
    ).toEqual({ workspaceId: "project", root: "." });
  });
});
