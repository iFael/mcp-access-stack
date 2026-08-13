import { fileURLToPath } from "node:url";
import type { Config } from "jest";
import { createNodeJestProject } from "../../jest.preset.ts";

const workerRootUrl = new URL("./", import.meta.url);
const testTsconfigUrl = new URL("./tsconfig.test.json", import.meta.url);
const sharedSourceUrl = new URL(
  "../../packages/mcp-core/src/index.ts",
  import.meta.url,
);

export const browserWorkerProjects: Config[] = [
  {
    ...createNodeJestProject({
      displayName: "browser-worker-unit",
      rootUrl: workerRootUrl,
      tsconfigUrl: testTsconfigUrl,
      sharedSourceUrl,
      testMatch: ["<rootDir>/test/unit/**/*.test.ts"],
      testTimeout: 10_000,
    }),
    setupFilesAfterEnv: ["<rootDir>/test/setup/unit-timeout.ts"],
  },
  {
    ...createNodeJestProject({
      displayName: "browser-worker-integration",
      rootUrl: workerRootUrl,
      tsconfigUrl: testTsconfigUrl,
      sharedSourceUrl,
      testMatch: ["<rootDir>/test/integration/**/*.test.ts"],
      testTimeout: 60_000,
    }),
    setupFilesAfterEnv: ["<rootDir>/test/setup/integration-timeout.ts"],
  },
  {
    ...createNodeJestProject({
      displayName: "browser-worker-e2e",
      rootUrl: workerRootUrl,
      tsconfigUrl: testTsconfigUrl,
      sharedSourceUrl,
      testMatch: ["<rootDir>/test/e2e/**/*.test.ts"],
      testTimeout: 90_000,
      detectOpenHandles: true,
    }),
    setupFilesAfterEnv: ["<rootDir>/test/setup/e2e-timeout.ts"],
  },
];

const config: Config = {
  rootDir: fileURLToPath(workerRootUrl),
  projects: browserWorkerProjects,
  collectCoverageFrom: [
    "<rootDir>/**/*.ts",
    "!<rootDir>/dist/**",
    "!<rootDir>/test/**",
    "!<rootDir>/jest.config.ts",
  ],
  coverageDirectory: "<rootDir>/coverage",
  coverageProvider: "v8",
};

export default config;
