import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "@jest/globals";
import type { BrowserExecutor } from "@vs-code-gpt/shared";
import type { AgentRelay } from "../../../src/relay/service.js";
import { RelayWorkspaceExecutor } from "../../../src/relay/workspace-executor.js";
import { createMcpServer } from "../../../src/mcp/server.js";

const advancedToolNames = [
  "browser_console",
  "browser_network",
  "browser_trace",
  "browser_video",
  "browser_pdf",
  "browser_diagnostics",
] as const;

describe("advanced browser tools list", () => {
  it("publishes ChatGPT-compatible object schemas for all advanced tools", async () => {
    const server = createMcpServer({
      workspaceExecutor: new RelayWorkspaceExecutor({} as AgentRelay),
      browser: {} as BrowserExecutor,
    });
    const client = new Client(
      { name: "browser-tools-list-test", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const listed = await client.listTools();
      const advanced = listed.tools.filter((tool) =>
        (advancedToolNames as readonly string[]).includes(tool.name),
      );

      expect(advanced.map((tool) => tool.name)).toEqual(advancedToolNames);
      for (const tool of advanced) {
        expect(tool.inputSchema).toMatchObject({ type: "object" });
        expect(tool.outputSchema).toMatchObject({ type: "object" });
        expect(tool.annotations).toEqual({
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
          idempotentHint: false,
        });
        expect(tool._meta).toEqual({
          securitySchemes: [{ type: "noauth" }],
        });
      }

      const network = advanced.find((tool) => tool.name === "browser_network");
      expect(network?.inputSchema).toMatchObject({
        required: ["action", "tabId"],
        properties: {
          action: { enum: ["list", "inspect"] },
          tabId: { type: "string" },
          index: { type: "integer" },
        },
      });

      const trace = advanced.find((tool) => tool.name === "browser_trace");
      expect(trace?.inputSchema).toMatchObject({
        required: ["action", "tabId"],
        properties: {
          action: { enum: ["start", "stop"] },
          tabId: { type: "string" },
        },
      });

      const video = advanced.find((tool) => tool.name === "browser_video");
      expect(video?.inputSchema).toMatchObject({
        required: ["action", "tabId"],
        properties: {
          action: { enum: ["start", "stop"] },
          filename: { type: "string" },
          width: { type: "integer" },
          height: { type: "integer" },
        },
      });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
  it("publishes the complete browser and workspace tool catalog", async () => {
    const server = createMcpServer({
      workspaceExecutor: new RelayWorkspaceExecutor({} as AgentRelay),
      browser: {} as BrowserExecutor,
    });
    const client = new Client(
      { name: "complete-tools-list-test", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);

      expect(names).toHaveLength(50);
      expect(names).toEqual(expect.arrayContaining([
        "browser_open_authorized_site",
        "browser_profile_page",
        "browser_dom_index",
        "browser_frame_sequence",
        "browser_navigate_path",
        "start_background_task",
        "get_background_task",
        "wait_background_task",
        "list_background_tasks",
        "cancel_background_task",
        "read_background_task_logs",
      ]));

      const authorizedSite = listed.tools.find(
        (tool) => tool.name === "browser_open_authorized_site",
      );
      expect(authorizedSite?.outputSchema).toMatchObject({
        type: "object",
        required: ["status", "taskId", "siteId"],
        properties: {
          status: { enum: ["confirmation_required", "opened"] },
          confirmationId: { type: "string" },
          tabId: { type: "string" },
          authentication: { type: "object" },
        },
      });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("rejects invalid browser arguments before invoking the executor", async () => {
    let navigateCalls = 0;
    const browser = {
      navigate: async () => {
        navigateCalls += 1;
        throw new Error("Executor must not receive invalid input.");
      },
    } as unknown as BrowserExecutor;
    const server = createMcpServer({
      workspaceExecutor: new RelayWorkspaceExecutor({} as AgentRelay),
      browser,
    });
    const client = new Client(
      { name: "browser-input-validation-test", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const result = await client.callTool({
        name: "browser_navigate",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(navigateCalls).toBe(0);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
  it("rejects invalid browser structured content after executor completion", async () => {
    const browser = {
      status: async () => ({}),
    } as unknown as BrowserExecutor;
    const server = createMcpServer({
      workspaceExecutor: new RelayWorkspaceExecutor({} as AgentRelay),
      browser,
    });
    const client = new Client(
      { name: "browser-output-validation-test", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const result = await client.callTool({
        name: "browser_status",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringMatching(/Output validation error/u),
        }),
      ]));
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});

describe("workspace command output schemas", () => {
  it("publishes and validates command results as MCP object schemas", async () => {
    const relay = {
      call: async (operation: string) => {
        if (operation === "runCommand" || operation === "runPowerShell") {
          return {
            status: "executed",
            shell: "powershell",
            cwd: ".",
            exitCode: 0,
            stdout: "command-ok\n",
            stderr: "",
            timedOut: false,
          };
        }
        throw new Error("Unexpected relay operation: " + operation);
      },
    } as unknown as AgentRelay;
    const server = createMcpServer({ workspaceExecutor: new RelayWorkspaceExecutor(relay) });
    const client = new Client(
      { name: "workspace-command-schema-test", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const listed = await client.listTools();
      const runCommand = listed.tools.find((entry) => entry.name === "run_command");
      const runCommandInputSchema = JSON.stringify(runCommand?.inputSchema);
      for (const field of [
        "workspaceId",
        "command",
        "shell",
        "objective",
        "executionMode",
        "autoCorrection",
        "expectedOutcome",
      ]) {
        expect(runCommandInputSchema).toContain(`"${field}"`);
      }
      expect(runCommand?.inputSchema).toMatchObject({
        type: "object",
        required: ["workspaceId"],
      });

      const qualifiedResult = await client.callTool({
        name: "run_command",
        arguments: {
          workspaceId: "test",
          executionMode: "qualified",
          objective: "Read the current workspace state.",
          autoCorrection: "off",
        },
      });
      expect(qualifiedResult.isError).not.toBe(true);

      for (const name of ["run_command", "run_powershell"] as const) {
        const tool = listed.tools.find((entry) => entry.name === name);
        expect(tool?.outputSchema).toMatchObject({ type: "object" });

        const result = await client.callTool({
          name,
          arguments:
            name === "run_command"
              ? {
                  workspaceId: "test",
                  shell: "powershell",
                  command: "Write-Output command-ok",
                }
              : {
                  workspaceId: "test",
                  command: "Write-Output command-ok",
                },
        });

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: "executed",
          shell: "powershell",
          exitCode: 0,
          timedOut: false,
        });
      }
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
