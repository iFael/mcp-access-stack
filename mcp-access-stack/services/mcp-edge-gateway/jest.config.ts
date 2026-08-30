import { fileURLToPath } from "node:url";
import type { Config } from "jest";
import { createNodeJestProject } from "../../jest.preset.ts";

const rootUrl = new URL("./", import.meta.url);
const testTsconfigUrl = new URL("../../tsconfig.jest.json", import.meta.url);
const sharedSourceUrl = new URL("../../packages/mcp-core/src/index.ts", import.meta.url);

const project = createNodeJestProject({
  displayName: "mcp-edge-gateway",
  rootUrl,
  tsconfigUrl: testTsconfigUrl,
  sharedSourceUrl,
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  testTimeout: 10_000,
});

const config: Config = {
  rootDir: fileURLToPath(rootUrl),
  projects: [project],
};

export default config;