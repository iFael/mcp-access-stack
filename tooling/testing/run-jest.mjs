import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const jestPackageJson = require.resolve("jest/package.json");
const jestBin = path.join(path.dirname(jestPackageJson), "bin", "jest.js");
const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--experimental-vm-modules",
    jestBin,
    ...process.argv.slice(2),
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error !== undefined) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
