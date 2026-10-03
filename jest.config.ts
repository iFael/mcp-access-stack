import type { Config } from "jest";
import mcpCoreConfig from "./packages/mcp-core/jest.config.ts";
import { browserWorkerProjects } from "./services/browser-worker/jest.config.ts";
import { mcpEdgeGatewayProject } from "./services/mcp-edge-gateway/jest.config.ts";
import { mcpGatewayProjects } from "./services/mcp-gateway/jest.config.ts";
import { workspaceAgentProjects } from "./services/workspace-agent/jest.config.ts";
import { releaseOrchestratorProjects } from "./services/oracle-release-orchestrator/jest.config.ts";

const config: Config = {
  projects: [
    mcpCoreConfig,
    ...workspaceAgentProjects,
    ...releaseOrchestratorProjects,
    ...mcpGatewayProjects,
    ...browserWorkerProjects,
    mcpEdgeGatewayProject,
  ],
};

export default config;
