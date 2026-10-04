import { fileURLToPath } from "node:url";
import type { Config } from "jest";
import { createNodeJestProject } from "../../jest.preset.ts";

const workerRootUrl = new URL("./", import.meta.url);
const testTsconfigUrl = new URL("../../tsconfig.jest.json", import.meta.url);

export const updateControlWorkerProjects: Config[] = [
  createNodeJestProject({
    displayName: "update-control-worker-unit",
    rootUrl: workerRootUrl,
    tsconfigUrl: testTsconfigUrl,
    testMatch: ["<rootDir>/test/unit/**/*.test.ts"],
    testTimeout: 15_000,
  }),
];

const config: Config = {
  rootDir: fileURLToPath(workerRootUrl),
  projects: updateControlWorkerProjects,
};

export default config;
