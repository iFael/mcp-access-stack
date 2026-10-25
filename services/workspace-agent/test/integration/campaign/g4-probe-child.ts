import { runG4ProbeWorker } from "../../../src/campaign/campaign-g4-safety-probe.js";

if (process.argv[2] !== "worker" || !process.argv[3] || !process.argv[4]) {
  throw new Error("G4_PROBE_FIXTURE_INVALID_INVOCATION");
}
await runG4ProbeWorker(process.argv[4], process.argv[3]);
