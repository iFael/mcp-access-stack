import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, jest } from "@jest/globals";
import type { BrowserExecutor } from "../src/browser-executor.js";
import type { WorkspaceExecutor } from "../src/workspace-executor.js";
import { browserUploadFileSchema } from "../src/browser-contracts.js";
import {
  BROWSER_TOOL_NAMES,
  type BrowserToolName,
  registerBrowserTools,
} from "../src/mcp-browser-tools.js";

const collectedAt = "2026-07-02T00:00:00.000Z";

describe("browser upload file contract", () => {
  it("rejects path separators and NUL in client-provided filenames", () => {
    const file = { contentBase64: "aGVsbG8=" };
    expect(browserUploadFileSchema.safeParse({ ...file, name: "../secret" }).success).toBe(false);
    expect(browserUploadFileSchema.safeParse({ ...file, name: "folder\\secret" }).success).toBe(false);
    expect(browserUploadFileSchema.safeParse({ ...file, name: "secret\0.txt" }).success).toBe(false);
    expect(browserUploadFileSchema.safeParse({ ...file, name: "playbook.md" }).success).toBe(true);
  });
});

interface RegisteredTool {
  annotations?: Record<string, unknown>;
  inputSchema?: unknown;
  outputSchema?: unknown;
  handler(
    input: unknown,
    extra: { authInfo?: AuthInfo },
  ): Promise<CallToolResult>;
}

function mockExecutor(): BrowserExecutor {
  const disconnected = jest.fn(async () => {
    throw new Error("not executed in registration test");
  });
  return {
    status: jest.fn(async () => ({
      state: "disconnected",
      ready: false,
      browser: "chrome",
      profile: "default",
      autoLaunch: true,
      tabGroup: "MCP",
      edgeFallback: "technical-necessity-only",
      tabCount: 0,
    })),
    connect: disconnected,
    tabs: jest.fn(async () => ({ tabs: [] })),
    open: disconnected,
    openAuthorizedSite: jest.fn(async () => ({
      status: "confirmation_required" as const,
      taskId: "task-1",
      siteId: "private-site",
      confirmationId: "site-confirm-1",
      expiresAt: collectedAt,
      reasons: ["Authorize private site access."],
    })),
    navigate: disconnected,
    snapshot: disconnected,
    click: disconnected,
    fill: disconnected,
    press: disconnected,
    wait: disconnected,
    extract: disconnected,
    sequence: disconnected,
    screenshot: disconnected,
    goBack: disconnected,
    goForward: disconnected,
    closeTab: disconnected,
    finishTask: jest.fn(async () => ({
      completed: true as const,
      closedTabs: 0,
      browserClosed: true,
    })),
    download: disconnected,
    upload: jest.fn(async ({ tabId, files }: Parameters<BrowserExecutor["upload"]>[0]) => ({
      tabId,
      completed: true as const,
      fileCount: files.length,
      totalBytes: files.reduce(
        (total, file) => total + Buffer.from(file.contentBase64, "base64").byteLength,
        0,
      ),
    })),
    console: jest.fn(async ({ tabId }) => ({
      tabId,
      text: "console output",
      truncated: false,
      collectedAt,
    })),
    networkList: jest.fn(async ({ tabId }) => ({
      tabId,
      text: "1 GET https://example.test/api",
      truncated: false,
      collectedAt,
    })),
    networkInspect: jest.fn(async ({ tabId }) => ({
      tabId,
      text: "content-type: application/json",
      truncated: false,
      collectedAt,
    })),
    traceStart: jest.fn(async ({ tabId }) => ({ tabId, active: true })),
    traceStop: jest.fn(async ({ tabId }) => ({
      tabId,
      kind: "trace",
      files: [{
        kind: "trace",
        path: "C:/private/trace.zip",
        sizeBytes: 100,
        createdAt: collectedAt,
      }],
      totalBytes: 100,
      createdAt: collectedAt,
    })),
    videoStart: jest.fn(async ({ tabId }) => ({
      tabId,
      path: "C:/private/video.webm",
      active: true,
    })),
    videoStop: jest.fn(async ({ tabId }) => ({
      tabId,
      kind: "video",
      path: "C:/private/video.webm",
      sizeBytes: 200,
      createdAt: collectedAt,
    })),
    pdf: jest.fn(async ({ tabId }) => ({
      tabId,
      kind: "pdf",
      path: "C:/private/page.pdf",
      sizeBytes: 300,
      createdAt: collectedAt,
    })),
    diagnostics: jest.fn(async ({ tabId }) => ({
      tabId,
      console: {
        text: "console output",
        truncated: false,
        collectedAt,
      },
      network: {
        text: "network output",
        truncated: false,
        collectedAt,
      },
      traceActive: false,
      videoActive: false,
      collectedAt,
    })),
  } as unknown as BrowserExecutor;
}

function registeredTools(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as {
    _registeredTools: Record<string, RegisteredTool>;
  })._registeredTools;
}

async function callTool(
  server: McpServer,
  name: BrowserToolName,
  input: unknown,
): Promise<CallToolResult> {
  const tool = registeredTools(server)[name];
  if (!tool) throw new Error(`Tool ${name} is not registered.`);
  return tool.handler(input, {});
}

describe("registerBrowserTools", () => {
  it("registers the complete explicit browser tool surface", () => {
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerBrowserTools(server, mockExecutor(), {
      securitySchemes: [{ type: "noauth" }],
    });
    expect(Object.keys(registeredTools(server)).sort()).toEqual(
      [...BROWSER_TOOL_NAMES].sort(),
    );
  });

  it("routes private-site confirmation through the typed executor", async () => {
    const executor = mockExecutor();
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerBrowserTools(server, executor);

    await expect(callTool(server, "browser_open_authorized_site", {
      siteId: "private-site",
      purpose: "read-report",
    })).resolves.toMatchObject({
      structuredContent: {
        status: "confirmation_required",
        taskId: "task-1",
        siteId: "private-site",
        confirmationId: "site-confirm-1",
      },
    });
    expect(executor.openAuthorizedSite).toHaveBeenCalledWith({
      siteId: "private-site",
      purpose: "read-report",
    });
  });

  it("keeps canonical authorized-site output validation behind the published object schema", async () => {
    const executor = mockExecutor();
    executor.openAuthorizedSite = jest.fn(async () => ({
      status: "opened",
      taskId: "task-1",
      siteId: "private-site",
    })) as unknown as BrowserExecutor["openAuthorizedSite"];
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerBrowserTools(server, executor);

    const result = await callTool(server, "browser_open_authorized_site", {
      siteId: "private-site",
      purpose: "read-report",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringMatching(/Output validation error/u),
      }),
    ]));
  });

  it("can expose a safe subset", () => {
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerBrowserTools(server, mockExecutor(), {
      includeTools: ["browser_status", "browser_tabs"],
    });
    expect(Object.keys(registeredTools(server)).sort()).toEqual([
      "browser_status",
      "browser_tabs",
    ]);
  });

  it("publishes advanced tools with explicit mutating annotations", () => {
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerBrowserTools(server, mockExecutor());

    for (const name of [
      "browser_console",
      "browser_network",
      "browser_trace",
      "browser_video",
      "browser_pdf",
      "browser_diagnostics",
    ] as const) {
      const tool = registeredTools(server)[name];
      expect(typeof tool?.inputSchema).toBe("object");
      expect(typeof tool?.outputSchema).toBe("object");
      expect(tool?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      });
    }
  });

  it("routes the public advanced tool actions to the typed executor", async () => {
    const executor = mockExecutor();
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerBrowserTools(server, executor);

    await expect(callTool(server, "browser_console", {
      tabId: "tab-1",
      level: "debug",
      clear: true,
    })).resolves.toMatchObject({
      structuredContent: { tabId: "tab-1", text: "console output" },
    });
    expect(executor.console).toHaveBeenCalledWith({
      tabId: "tab-1",
      level: "debug",
      clear: true,
    });

    await callTool(server, "browser_network", {
      action: "list",
      tabId: "tab-1",
      includeStatic: true,
      filter: "api",
      clear: true,
    });
    expect(executor.networkList).toHaveBeenCalledWith({
      tabId: "tab-1",
      includeStatic: true,
      filter: "api",
      clear: true,
    });

    await callTool(server, "browser_network", {
      action: "inspect",
      tabId: "tab-1",
      index: 2,
      detail: "response-headers",
    });
    expect(executor.networkInspect).toHaveBeenCalledWith({
      tabId: "tab-1",
      index: 2,
      detail: "response-headers",
    });

    await expect(callTool(server, "browser_trace", {
      action: "start",
      tabId: "tab-1",
    })).resolves.toMatchObject({
      structuredContent: { action: "start", tabId: "tab-1", active: true },
    });
    await expect(callTool(server, "browser_trace", {
      action: "stop",
      tabId: "tab-1",
    })).resolves.toMatchObject({
      structuredContent: {
        action: "stop",
        tabId: "tab-1",
        kind: "trace",
        totalBytes: 100,
      },
    });

    await expect(callTool(server, "browser_video", {
      action: "start",
      tabId: "tab-1",
      filename: "video.webm",
      width: 800,
      height: 600,
    })).resolves.toMatchObject({
      structuredContent: {
        action: "start",
        tabId: "tab-1",
        active: true,
      },
    });
    expect(executor.videoStart).toHaveBeenCalledWith({
      tabId: "tab-1",
      filename: "video.webm",
      width: 800,
      height: 600,
    });

    await expect(callTool(server, "browser_video", {
      action: "stop",
      tabId: "tab-1",
    })).resolves.toMatchObject({
      structuredContent: {
        action: "stop",
        tabId: "tab-1",
        kind: "video",
        sizeBytes: 200,
      },
    });

    await callTool(server, "browser_pdf", {
      tabId: "tab-1",
      filename: "page.pdf",
    });
    expect(executor.pdf).toHaveBeenCalledWith({
      tabId: "tab-1",
      filename: "page.pdf",
    });

    await callTool(server, "browser_diagnostics", {
      tabId: "tab-1",
      consoleLevel: "warning",
      includeStaticRequests: true,
      clearAfterRead: true,
    });
    expect(executor.diagnostics).toHaveBeenCalledWith({
      tabId: "tab-1",
      consoleLevel: "warning",
      includeStaticRequests: true,
      clearAfterRead: true,
    });
  });

  it("loads authorized workspace bytes and routes browser_upload", async () => {
    const executor = mockExecutor();
    const workspaceExecutor = {
      readBinaryFile: jest.fn(async () => ({
        path: "docs/playbook.md",
        contentBase64: "aGVsbG8=",
        sizeBytes: 5,
        sha256: "0".repeat(64),
      })),
    } as unknown as WorkspaceExecutor;
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerBrowserTools(server, executor, { workspaceExecutor });

    await expect(callTool(server, "browser_upload", {
      tabId: "tab-1",
      workspaceId: "workspace",
      paths: ["docs/playbook.md"],
      selector: "input[type=file]",
      confirmationId: "confirmation",
    })).resolves.toMatchObject({
      structuredContent: {
        tabId: "tab-1",
        completed: true,
        fileCount: 1,
        totalBytes: 5,
      },
    });
    expect(workspaceExecutor.readBinaryFile).toHaveBeenCalledWith({
      workspaceId: "workspace",
      path: "docs/playbook.md",
    });
    expect(executor.upload).toHaveBeenCalledWith(expect.objectContaining({
      tabId: "tab-1",
      files: [{
        name: "playbook.md",
        contentBase64: "aGVsbG8=",
        mimeType: "text/markdown",
      }],
    }));
  });

  it("rejects fields that do not belong to the selected advanced action", async () => {
    const executor = mockExecutor();
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerBrowserTools(server, executor);

    const invalidNetwork = await callTool(server, "browser_network", {
      action: "inspect",
      tabId: "tab-1",
      includeStatic: true,
    });
    expect(invalidNetwork.isError).toBe(true);
    expect(executor.networkInspect).not.toHaveBeenCalled();

    const invalidVideo = await callTool(server, "browser_video", {
      action: "stop",
      tabId: "tab-1",
      filename: "unexpected.webm",
    });
    expect(invalidVideo.isError).toBe(true);
    expect(executor.videoStop).not.toHaveBeenCalled();
  });
});
