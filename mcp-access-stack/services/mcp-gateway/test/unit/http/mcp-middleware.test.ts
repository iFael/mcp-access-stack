import { describe, expect, test, jest } from "@jest/globals";
import type { Request, Response } from "express";
import {
  createChallenge,
  createOriginMiddleware,
  isToolCall,
} from "../../../src/http/mcp-middleware.js";

describe("MCP HTTP middleware helpers", () => {
  test("builds the OAuth challenge and detects only tool calls", () => {
    expect(
      createChallenge(
        new URL("https://gateway.example/.well-known/oauth-protected-resource/mcp"),
        "workspaces:read",
      ),
    ).toBe(
      'Bearer resource_metadata="https://gateway.example/.well-known/oauth-protected-resource/mcp", scope="workspaces:read"',
    );
    expect(isToolCall({ method: "tools/call" })).toBe(true);
    expect(isToolCall({ method: "tools/list" })).toBe(false);
    expect(isToolCall(null)).toBe(false);
  });

  test("allows missing or trusted origins and rejects an untrusted origin", () => {
    const middleware = createOriginMiddleware(new Set(["https://chatgpt.com"]));
    const next = jest.fn();
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    middleware(
      { header: () => undefined } as unknown as Request,
      response,
      next,
    );
    middleware(
      { header: () => "https://chatgpt.com" } as unknown as Request,
      response,
      next,
    );
    middleware(
      { header: () => "https://evil.example" } as unknown as Request,
      response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(2);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({ error: "origin_not_allowed" });
  });
});
