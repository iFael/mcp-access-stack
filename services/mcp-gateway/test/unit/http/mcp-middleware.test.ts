import { EventEmitter } from "node:events";
import { describe, expect, test, jest } from "@jest/globals";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import {
  createChallenge,
  createMcpRequestLifecycleMiddleware,
  createOriginMiddleware,
  isToolCall,
  type AuthenticatedRequest,
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

  test("logs final transport mode and only session-id presence", () => {
    const info = jest.fn();
    const logger = { info } as unknown as Logger;
    const request = Object.assign(new EventEmitter(), {
      method: "POST",
      path: "/mcp",
      header: (name: string) =>
        name.toLowerCase() === "mcp-session-id"
          ? "sensitive-session-id-must-not-be-logged"
          : undefined,
    }) as unknown as AuthenticatedRequest;
    const response = Object.assign(new EventEmitter(), {
      setHeader: jest.fn(),
      statusCode: 200,
      headersSent: true,
      writableEnded: true,
    }) as unknown as Response;
    const next = jest.fn();

    createMcpRequestLifecycleMiddleware(
      logger,
      "stateful-experiment",
    )(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(request.mcpTransportMode).toBe("stateful");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      event: "mcp_http_request_started",
      hasMcpSessionId: true,
    });
    expect(info.mock.calls[0]?.[0]).not.toHaveProperty("mcpTransportMode");

    (response as unknown as EventEmitter).emit("finish");

    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[1]?.[0]).toMatchObject({
      event: "mcp_http_request_completed",
      mcpTransportMode: "stateful",
      hasMcpSessionId: true,
      status: "completed",
      statusCode: 200,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain(
      "sensitive-session-id-must-not-be-logged",
    );
  });

  test("keeps stateless mode when a session header is sent while stateful support is disabled", () => {
    const info = jest.fn();
    const logger = { info } as unknown as Logger;
    const request = Object.assign(new EventEmitter(), {
      method: "POST",
      path: "/mcp",
      header: (name: string) =>
        name.toLowerCase() === "mcp-session-id"
          ? "ignored-session-header"
          : undefined,
    }) as unknown as AuthenticatedRequest;
    const response = Object.assign(new EventEmitter(), {
      setHeader: jest.fn(),
      statusCode: 200,
      headersSent: true,
      writableEnded: true,
    }) as unknown as Response;

    createMcpRequestLifecycleMiddleware(
      logger,
      "stateless",
    )(request, response, jest.fn());
    (response as unknown as EventEmitter).emit("finish");

    expect(request.mcpTransportMode).toBe("stateless");
    expect(info.mock.calls[1]?.[0]).toMatchObject({
      event: "mcp_http_request_completed",
      mcpTransportMode: "stateless",
      hasMcpSessionId: true,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain(
      "ignored-session-header",
    );
  });

  test("defaults final transport observability to stateless when no stateful route was selected", () => {
    const info = jest.fn();
    const logger = { info } as unknown as Logger;
    const request = Object.assign(new EventEmitter(), {
      method: "POST",
      path: "/mcp",
      header: () => undefined,
    }) as unknown as AuthenticatedRequest;
    const response = Object.assign(new EventEmitter(), {
      setHeader: jest.fn(),
      statusCode: 400,
      headersSent: true,
      writableEnded: true,
    }) as unknown as Response;

    createMcpRequestLifecycleMiddleware(logger)(request, response, jest.fn());
    (response as unknown as EventEmitter).emit("finish");

    expect(info.mock.calls[1]?.[0]).toMatchObject({
      event: "mcp_http_request_completed",
      mcpTransportMode: "stateless",
      hasMcpSessionId: false,
    });
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
