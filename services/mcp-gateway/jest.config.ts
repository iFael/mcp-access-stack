import { fileURLToPath } from "node:url";
import type { Config } from "jest";
import { createNodeJestProject } from "../../jest.preset.ts";

const gatewayRootUrl = new URL("./", import.meta.url);
const testTsconfigUrl = new URL("../../tsconfig.jest.json", import.meta.url);
const sharedSourceUrl = new URL(
  "../../packages/mcp-core/src/index.ts",
  import.meta.url,
);

export const mcpGatewayProjects: Config[] = [
  createNodeJestProject({
    displayName: "mcp-gateway-unit",
    rootUrl: gatewayRootUrl,
    tsconfigUrl: testTsconfigUrl,
    sharedSourceUrl,
    testMatch: ["<rootDir>/test/unit/**/*.test.ts"],
    testTimeout: 10_000,
  }),
  createNodeJestProject({
    displayName: "mcp-gateway-integration",
    rootUrl: gatewayRootUrl,
    tsconfigUrl: testTsconfigUrl,
    sharedSourceUrl,
    testMatch: ["<rootDir>/test/integration/**/*.test.ts"],
    testTimeout: 30_000,
  }),
  createNodeJestProject({
    displayName: "mcp-gateway-e2e",
    rootUrl: gatewayRootUrl,
    tsconfigUrl: testTsconfigUrl,
    sharedSourceUrl,
    testMatch: ["<rootDir>/test/e2e/**/*.test.ts"],
    testTimeout: 30_000,
    detectOpenHandles: true,
  }),
];

const config: Config = {
  rootDir: fileURLToPath(gatewayRootUrl),
  projects: mcpGatewayProjects,
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
