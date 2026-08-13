import type { Config } from "jest";
import { createNodeJestProject } from "../../jest.preset.ts";

const config: Config = createNodeJestProject({
  displayName: "mcp-core",
  rootUrl: new URL("./", import.meta.url),
  tsconfigUrl: new URL("../../tsconfig.jest.json", import.meta.url),
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  testTimeout: 15_000,
});

export default config;
