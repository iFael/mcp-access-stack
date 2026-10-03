import { fileURLToPath } from "node:url";
import type { Config } from "jest";
import { createNodeJestProject } from "../../jest.preset.ts";

const orchestratorRootUrl = new URL("./", import.meta.url);
const testTsconfigUrl = new URL("../../tsconfig.jest.json", import.meta.url);

export const releaseOrchestratorProjects: Config[] = [
  createNodeJestProject({
    displayName: "release-orchestrator-unit",
    rootUrl: orchestratorRootUrl,
    tsconfigUrl: testTsconfigUrl,
    testMatch: ["<rootDir>/test/unit/**/*.test.ts"],
    testTimeout: 15_000,
  }),
  createNodeJestProject({
    displayName: "release-orchestrator-integration",
    rootUrl: orchestratorRootUrl,
    tsconfigUrl: testTsconfigUrl,
    testMatch: ["<rootDir>/test/integration/**/*.test.ts"],
    testTimeout: 15_000,
  }),
];

const config: Config = {
  rootDir: fileURLToPath(orchestratorRootUrl),
  projects: releaseOrchestratorProjects,
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
