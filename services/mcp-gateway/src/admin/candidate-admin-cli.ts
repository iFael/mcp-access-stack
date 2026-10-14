#!/usr/bin/env node
// Separate local stdio MCP endpoint. Never imported by the public Edge createMcpServer.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CandidateServiceAdmin, candidateProvisionInputSchema } from "./candidate-service.js";

export function createCandidateAdminServer(admin = new CandidateServiceAdmin()) {
  const server = new McpServer(
    { name: "mcp-v3-connector99-private-admin", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.registerTool("candidate_service_status", {
    title: "Inspect connector 99 candidate systemd service",
    description: "Local operator-only status for one fixed candidate unit and the original active connector.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => {
    try {
      const structuredContent = await admin.status();
      return { content: [{ type: "text", text: "Candidate service state reconciled." }], structuredContent };
    } catch {
      return { isError: true, content: [{ type: "text", text: "PRIVATE_SERVICE_STATUS_UNAVAILABLE" }] };
    }
  });
  server.registerTool("provision_candidate_service", {
    title: "Provision fixed connector 99 candidate service",
    description: "Local operator-only; exact candidate ID, SHA/CAS, active PID and explicit execute flag. Reconcile status on uncertain outcomes.",
    inputSchema: candidateProvisionInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async (input) => {
    try {
      const structuredContent = await admin.provision(input);
      return { content: [{ type: "text", text: "Candidate service operation completed." }], structuredContent };
    } catch {
      return { isError: true, content: [{ type: "text", text: "PRIVATE_PROVISION_RECONCILIATION_REQUIRED" }] };
    }
  });
  return server;
}

if (process.argv[1]?.endsWith("candidate-admin-cli.js")) {
  const server = createCandidateAdminServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch(() => { process.exitCode = 1; });
}
