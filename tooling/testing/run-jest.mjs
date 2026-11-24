import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { totalmem } from "node:os";

const require = createRequire(import.meta.url);
const jestPackageJson = require.resolve("jest/package.json");
const jestBin = path.join(path.dirname(jestPackageJson), "bin", "jest.js");
// On small execution nodes, a single long-lived Jest VM accumulates heap
// across suites. Keep serial execution but let Jest recycle its one worker.
// Explicit diagnostic runs keep their original in-band semantics.
const args = process.argv.slice(2);
const memoryLimit = Math.min(totalmem(), process.constrainedMemory() || Infinity);
const serial = args.includes("--runInBand") || args.includes("-i");
const explicitMode = args.some((arg) =>
  /^(?:--(?:detectOpenHandles|detect-open-handles|logHeapUsage|log-heap-usage|maxWorkers|max-workers|workerIdleMemoryLimit|worker-idle-memory-limit|watch|watchAll|watch-all|runInBand=)|-w)(?:=|$)/u.test(arg),
);
const jestArgs = memoryLimit <= 2 * 1024 ** 3 && serial && !explicitMode
  ? [...args.filter((arg) => arg !== "--runInBand" && arg !== "-i"),
      "--maxWorkers=1", "--workerIdleMemoryLimit=256MB"]
  : args;

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--experimental-vm-modules",
    jestBin,
    ...jestArgs,
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
