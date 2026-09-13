import { fileURLToPath } from "node:url";
import type { Config } from "jest";
import { createNodeJestProject } from "../../jest.preset.ts";

const rootUrl = new URL("./", import.meta.url);
const testTsconfigUrl = new URL("../../tsconfig.jest.json", import.meta.url);

export const mcpEdgeGatewayProject = createNodeJestProject({
  displayName: "mcp-edge-gateway",
  rootUrl,
  tsconfigUrl: testTsconfigUrl,
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  testTimeout: 10_000,
});

const config: Config = {
  rootDir: fileURLToPath(rootUrl),
  projects: [mcpEdgeGatewayProject],
};

export default config;
