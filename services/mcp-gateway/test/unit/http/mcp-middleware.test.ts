import { EventEmitter } from "node:events";
import { describe, expect, test, jest } from "@jest/globals";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import {
  createMcpRequestLifecycleMiddleware,
  createOriginMiddleware,
  type AuthenticatedRequest,
} from "../../../src/http/mcp-middleware.js";

describe("MCP HTTP middleware helpers", () => {
  test("reserves 256 Browser samples after 600 non-Browser requests parsed after arrival", () => {
    const info = jest.fn();
    const middleware = createMcpRequestLifecycleMiddleware({ info } as unknown as Logger);
    const bodies = [
      { method: "initialize", params: {} },
      { method: "tools/list" },
      { method: "tools/call", params: { name: "list_devices", arguments: {} } },
    ];
    const complete = (body: unknown) => {
      const request = Object.assign(new EventEmitter(), { method: "POST", path: "/mcp", header: () => undefined }) as unknown as AuthenticatedRequest;
      const response = Object.assign(new EventEmitter(), { setHeader: jest.fn(), statusCode: 200, headersSent: true, writableEnded: true }) as unknown as Response;
      middleware(request, response, jest.fn());
      // express.json runs after the arrival middleware in the real application.
      request.body = body;
      (response as unknown as EventEmitter).emit("finish");
      (response as unknown as EventEmitter).emit("close");
    };
    for (let n = 0; n < 600; n++) complete(bodies[n % bodies.length]);
    expect(info).toHaveBeenCalledTimes(1200);
    expect(info.mock.calls.some(call => (call[0] as Record<string, unknown>).latencyCaptureIndex !== undefined)).toBe(false);
    for (let n = 0; n < 300; n++) complete({ method: "tools/call", params: { name: "browser_fill", arguments: { value: "private draft" } } });
    expect(info).toHaveBeenCalledTimes(1800);
    const captured = info.mock.calls.map(call => call[0] as Record<string, unknown>).filter(event => event.latencyCaptureIndex !== undefined);
    expect(captured).toHaveLength(256);
    expect(captured[0]).toMatchObject({ event: "mcp_http_request_completed", operation: "browser_fill", latencyCaptureIndex: 1, latencyCaptureLimit: 256 });
    expect(captured[255]).toMatchObject({ latencyCaptureIndex: 256 });
    expect(JSON.stringify(info.mock.calls)).not.toContain("private draft");
  });
  test("binds validated relay and root IDs to local lifecycle without logging private headers", () => {
    const info=jest.fn();
    const root="11111111-1111-4111-8111-111111111111", relay="22222222-2222-4222-8222-222222222222";
    const request=Object.assign(new EventEmitter(), { method:"POST", path:"/mcp", header:(name:string) => ({ "x-mcp-browser-latency-id":root,"x-mcp-browser-relay-id":relay,"authorization":"secret-token","content-length":"123" } as Record<string,string>)[name] }) as unknown as AuthenticatedRequest;
    const response=Object.assign(new EventEmitter(), { setHeader:jest.fn(), statusCode:200,headersSent:true,writableEnded:true,getHeader:() => "456" }) as unknown as Response;
    createMcpRequestLifecycleMiddleware({ info } as unknown as Logger)(request,response,jest.fn());
    request.body = { method: "tools/call", params: { name: "browser_fill", arguments: {} } };
    expect(request.mcpLatency).toEqual({ requestId:root,relayRequestId:relay,gatewayRequestId:request.mcpRequestId, gatewayStartedAt:expect.any(Number) });
    (response as unknown as EventEmitter).emit("finish");
    expect(info.mock.calls[1]?.[0]).toMatchObject({ latencyRequestId:root,relayRequestId:relay,requestBytes:123,responseBytes:456 });
    expect(JSON.stringify(info.mock.calls)).not.toContain("secret-token");
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

    createMcpRequestLifecycleMiddleware(logger)(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(request.mcpTransportMode).toBe("stateless");
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
      mcpTransportMode: "stateless",
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

    createMcpRequestLifecycleMiddleware(logger)(
      request,
      response,
      jest.fn(),
    );
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
