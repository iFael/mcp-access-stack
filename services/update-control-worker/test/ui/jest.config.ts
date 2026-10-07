import { fileURLToPath } from "node:url";
import type { Config } from "jest";
import { createNodeJestProject } from "../../../../jest.preset.ts";

const workerRootUrl = new URL("../../", import.meta.url);
const testTsconfigUrl = new URL("../../../../tsconfig.jest.json", import.meta.url);

const config: Config = {
  rootDir: fileURLToPath(workerRootUrl),
  projects: [
    createNodeJestProject({
      displayName: "update-control-worker-ui",
      rootUrl: workerRootUrl,
      tsconfigUrl: testTsconfigUrl,
      testMatch: ["<rootDir>/test/ui/**/*.test.ts"],
      testTimeout: 15_000,
    }),
  ],
};

export default config;
