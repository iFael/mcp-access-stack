import { fileURLToPath } from "node:url";
import type { Config } from "jest";
import { createNodeJestProject } from "../../jest.preset.ts";

const agentRootUrl = new URL("./", import.meta.url);
const testTsconfigUrl = new URL("../../tsconfig.jest.json", import.meta.url);
const sharedSourceUrl = new URL(
  "../../packages/mcp-core/src/index.ts",
  import.meta.url,
);

export const workspaceAgentProjects: Config[] = [
  createNodeJestProject({
    displayName: "workspace-agent-unit",
    rootUrl: agentRootUrl,
    tsconfigUrl: testTsconfigUrl,
    sharedSourceUrl,
    testMatch: ["<rootDir>/test/unit/**/*.test.ts"],
    testTimeout: 10_000,
  }),
  createNodeJestProject({
    displayName: "workspace-agent-integration",
    rootUrl: agentRootUrl,
    tsconfigUrl: testTsconfigUrl,
    sharedSourceUrl,
    testMatch: ["<rootDir>/test/integration/**/*.test.ts"],
    testTimeout: 30_000,
  }),
  createNodeJestProject({
    displayName: "workspace-agent-e2e",
    rootUrl: agentRootUrl,
    tsconfigUrl: testTsconfigUrl,
    sharedSourceUrl,
    testMatch: ["<rootDir>/test/e2e/**/*.test.ts"],
    testTimeout: 30_000,
    detectOpenHandles: true,
  }),
];

const config: Config = {
  rootDir: fileURLToPath(agentRootUrl),
  projects: workspaceAgentProjects,
  collectCoverageFrom: [
    "<rootDir>/src/**/*.ts",
    "!<rootDir>/dist/**",
    "!<rootDir>/test/**",
    "!<rootDir>/jest.config.ts",
  ],
  coverageDirectory: "<rootDir>/coverage",
  coverageProvider: "v8",
};

export default config;
