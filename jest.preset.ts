import { fileURLToPath } from "node:url";
import type { Config } from "jest";
import { createDefaultEsmPreset } from "ts-jest";

export interface NodeJestProjectOptions {
  displayName: string;
  rootUrl: URL;
  tsconfigUrl: URL;
  testMatch: string[];
  testTimeout?: number;
  detectOpenHandles?: boolean;
  sharedSourceUrl?: URL;
}

export function createNodeJestProject(
  options: NodeJestProjectOptions,
): Config {
  const preset = createDefaultEsmPreset({
    tsconfig: fileURLToPath(options.tsconfigUrl),
  });
  const moduleNameMapper: Record<string, string> = {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    ...(options.sharedSourceUrl === undefined
      ? {}
      : {
          "^@vs-code-gpt/shared$": fileURLToPath(options.sharedSourceUrl),
        }),
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
    ...(options.testTimeout === undefined
      ? {}
      : { testTimeout: options.testTimeout }),
    ...(options.detectOpenHandles === undefined
      ? {}
      : { detectOpenHandles: options.detectOpenHandles }),
  };
}
