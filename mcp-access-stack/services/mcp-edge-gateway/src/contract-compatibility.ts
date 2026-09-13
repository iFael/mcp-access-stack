import type { ConnectorRuntimeIdentity } from "@mcp-access-stack/edge-protocol";
import { EDGE_MCP_CATALOG_METADATA } from "./generated/mcp-tool-manifest.js";

/**
 * Canonical MCP execution contract revision projected from mcp-core into the Edge build.
 * The protocol-v3 wire field keeps its historical catalogContractRevision name, but this
 * single revision is the only authority used to decide Edge/connector compatibility.
 */
export const EXPECTED_MCP_CONTRACT_REVISION = EDGE_MCP_CATALOG_METADATA.contractRevision;

export function isConnectorContractCompatible(
  runtime: Pick<ConnectorRuntimeIdentity, "catalogContractRevision"> | undefined,
): boolean {
  return runtime?.catalogContractRevision === EXPECTED_MCP_CONTRACT_REVISION;
}
