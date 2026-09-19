import { AppError } from "@vs-code-gpt/shared";
import {
  EDGE_INTERNAL_ASSERTION_HEADER,
  EDGE_INTERNAL_PRINCIPAL_HEADER,
  encodeEdgeAuthenticatedPrincipal,
} from "./internal-trust.js";

const LOOPBACK_HEALTH_REQUEST_ID = "loopback-health";
const LOOPBACK_HEALTH_PRINCIPAL = {
  subject: "cutover-health",
  scopes: ["workspaces:read"],
};

export async function assertLoopbackMcpCompatibility(
  localBaseUrl: URL,
  internalAssertion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = new URL("/mcp", localBaseUrl);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        [EDGE_INTERNAL_ASSERTION_HEADER]: internalAssertion,
        [EDGE_INTERNAL_PRINCIPAL_HEADER]: encodeEdgeAuthenticatedPrincipal(LOOPBACK_HEALTH_PRINCIPAL),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: LOOPBACK_HEALTH_REQUEST_ID,
        method: "tools/list",
        params: {},
      }),
      redirect: "manual",
    });
  } catch (error) {
    throw new AppError(
      "AGENT_UNAVAILABLE",
      "Loopback Gateway compatibility check failed: " +
        (error instanceof Error ? error.message : "request failed") +
        ".",
    );
  }

  if (!response.ok) {
    throw new AppError(
      "AGENT_UNAVAILABLE",
      "Loopback Gateway compatibility check failed with HTTP " + response.status + ".",
    );
  }
  if (response.headers.has("mcp-session-id")) {
    throw new AppError(
      "AGENT_UNAVAILABLE",
      "Loopback Gateway compatibility check unexpectedly created an MCP session.",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AppError(
      "AGENT_UNAVAILABLE",
      "Loopback Gateway compatibility check returned invalid JSON.",
    );
  }

  if (
    !isRecord(payload) ||
    payload.jsonrpc !== "2.0" ||
    payload.id !== LOOPBACK_HEALTH_REQUEST_ID ||
    !isRecord(payload.result) ||
    !Array.isArray(payload.result.tools)
  ) {
    throw new AppError(
      "AGENT_UNAVAILABLE",
      "Loopback Gateway compatibility check returned an invalid tools/list response.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
