import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "@jest/globals";
import type { AgentRelay } from "../../../src/relay/service.js";
import { RelayWorkspaceExecutor } from "../../../src/relay/workspace-executor.js";
import { createMcpServer } from "../../../src/mcp/server.js";

async function withClient(
  relay: AgentRelay,
  callback: (client: Client) => Promise<void>,
): Promise<void> {
  const executor = new RelayWorkspaceExecutor(relay);
  const server = createMcpServer({
    workspaceExecutor: executor,
    sourceControlExecutor: executor,
  });
  const client = new Client(
    { name: "post-cutover-contract-regression-test", version: "0.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    await callback(client);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

describe("post-cutover MCP contract regressions", () => {
  it("accepts only known stale direct run_command transport fields while publishing the canonical schema", async () => {
    let runCommandCalls = 0;
    const relay = {
      call: async (operation: string) => {
        if (operation === "runCommand") {
          runCommandCalls += 1;
          return {
            status: "executed",
            shell: "powershell",
            cwd: ".",
            exitCode: 0,
            stdout: "transport-ok\n",
            stderr: "",
            timedOut: false,
          };
        }
        throw new Error("Unexpected relay operation: " + operation);
      },
    } as unknown as AgentRelay;

    await withClient(relay, async (client) => {
      const listed = await client.listTools();
      const runCommand = listed.tools.find((tool) => tool.name === "run_command");
      const publishedInput = JSON.stringify(runCommand?.inputSchema);

      for (const staleField of [
        "objective",
        "executionMode",
        "autoCorrection",
        "preferredShell",
        "expectedOutcome",
      ]) {
        expect(publishedInput).not.toContain(`"${staleField}"`);
      }

      const staleDirect = await client.callTool({
        name: "run_command",
        arguments: {
          workspaceId: "test",
          shell: "powershell",
          command: "Write-Output transport-ok",
          executionMode: "direct",
          objective: "legacy helper text",
          autoCorrection: "safe",
          preferredShell: "auto",
          expectedOutcome: [{ kind: "exit_code", value: 0 }],
        },
      });

      expect(staleDirect.isError).not.toBe(true);
      expect(staleDirect.structuredContent).toMatchObject({
        status: "executed",
        exitCode: 0,
      });
      expect(runCommandCalls).toBe(1);

      const unknown = await client.callTool({
        name: "run_command",
        arguments: {
          workspaceId: "test",
          shell: "powershell",
          command: "Write-Output must-not-run",
          unknownCompatibilityField: true,
        },
      });
      expect(unknown.isError).toBe(true);
      expect(runCommandCalls).toBe(1);

      const qualified = await client.callTool({
        name: "run_command",
        arguments: {
          workspaceId: "test",
          shell: "powershell",
          command: "Write-Output must-not-run",
          executionMode: "qualified",
        },
      });
      expect(qualified.isError).toBe(true);
      expect(runCommandCalls).toBe(1);
    });
  });

  it("returns start_background_task results through the MCP SDK output-validation path", async () => {
    let backgroundCalls = 0;
    const relay = {
      call: async (operation: string, input: Record<string, unknown>) => {
        if (operation === "startBackgroundTask") {
          backgroundCalls += 1;
          return {
            status: "background_task_started",
            task: {
              version: 1,
              id: "123e4567-e89b-42d3-a456-426614174000",
              workspaceId: input.workspaceId,
              operation: input.operation,
              commandHash: "0".repeat(64),
              command: input.command,
              shell: input.shell,
              cwd: input.cwd ?? ".",
              state: "running",
              createdAt: "2026-09-15T22:00:00.000Z",
              startedAt: "2026-09-15T22:00:01.000Z",
              timeoutMs: input.timeoutMs ?? 120_000,
              pid: 4242,
            },
          };
        }
        throw new Error("Unexpected relay operation: " + operation);
      },
    } as unknown as AgentRelay;

    await withClient(relay, async (client) => {
      const listed = await client.listTools();
      const startBackground = listed.tools.find(
        (tool) => tool.name === "start_background_task",
      );
      expect(startBackground?.outputSchema).toMatchObject({ type: "object" });

      const result = await client.callTool({
        name: "start_background_task",
        arguments: {
          workspaceId: "test",
          operation: "homologation",
          shell: "powershell",
          command: "Write-Output background-ok",
          timeoutMs: 120_000,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: "background_task_started",
        task: {
          state: "running",
          command: "Write-Output background-ok",
        },
      });
      expect(backgroundCalls).toBe(1);
    });
  });
});
