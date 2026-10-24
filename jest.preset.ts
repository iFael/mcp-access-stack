import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "jest";
import { createDefaultEsmPreset, pathsToModuleNameMapper } from "ts-jest";

export interface NodeJestProjectOptions {
  displayName: string;
  rootUrl: URL;
  tsconfigUrl: URL;
  testMatch: string[];
  testTimeout?: number;
  detectOpenHandles?: boolean;
}

const repositoryRootUrl = new URL("./", import.meta.url);
const projectTimeoutSetupUrl = new URL("./tooling/testing/jest-project-timeout.ts", import.meta.url);
const rootTsconfig = JSON.parse(
  readFileSync(new URL("./tsconfig.json", import.meta.url), "utf8"),
) as {
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
};
const internalPackageModuleNameMapper = pathsToModuleNameMapper(
  rootTsconfig.compilerOptions?.paths ?? {},
  { prefix: fileURLToPath(repositoryRootUrl) },
);

export function createNodeJestProject(
  options: NodeJestProjectOptions,
): Config {
  const preset = createDefaultEsmPreset({
    tsconfig: fileURLToPath(options.tsconfigUrl),
  });
  const moduleNameMapper: Config["moduleNameMapper"] = {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    ...internalPackageModuleNameMapper,
  };

  return {
    ...preset,
    displayName: options.displayName,
    rootDir: fileURLToPath(options.rootUrl),
    testEnvironment: "node",
    clearMocks: true,
    restoreMocks: true,
    testMatch: options.testMatch,
    moduleNameMapper,
    // Jest ignores testTimeout inside a project, so each project sets it in a setup file.
    ...(options.testTimeout === undefined
      ? {}
      : {
          globals: { __PROJECT_TEST_TIMEOUT_MS__: options.testTimeout },
          setupFilesAfterEnv: [fileURLToPath(projectTimeoutSetupUrl)],
        }),
    ...(options.detectOpenHandles === undefined
      ? {}
      : { detectOpenHandles: options.detectOpenHandles }),
  };
}
