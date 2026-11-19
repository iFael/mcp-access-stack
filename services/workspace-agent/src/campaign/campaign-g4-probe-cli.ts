#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  inspectG4Probe, runG4ProbeWorker, runG4SafetyProbe,
} from "./campaign-g4-safety-probe.js";

// Deliberately not part of the public MCP catalog. Privileged installation,
// VM2 use, and release remain separately gated.
const PRIVATE_STATE = "/var/lib/mcp-v3-campaign";

async function main(): Promise<void> {
  const [action, campaignId, workerParent] = process.argv.slice(2);
  if (process.platform !== "linux" || process.getuid?.() === 0 ||
    typeof campaignId !== "string" || process.argv.length < 4 ||
    process.argv.length > 5) {
    throw new Error("G4_PROBE_INVALID_INVOCATION");
  }
  if (action === "worker" && workerParent === PRIVATE_STATE &&
    process.argv.length === 5 && process.send) {
    await runG4ProbeWorker(PRIVATE_STATE, campaignId);
    return;
  }
  if (process.argv.length !== 4) throw new Error("G4_PROBE_INVALID_INVOCATION");
  if (action === "status") {
    process.stdout.write(JSON.stringify(await inspectG4Probe(PRIVATE_STATE, campaignId)) + "\n");
    return;
  }
  if (action !== "run") throw new Error("G4_PROBE_INVALID_INVOCATION");
  process.stdout.write(JSON.stringify(await runG4SafetyProbe({
    stateParent: PRIVATE_STATE,
    campaignId,
    workerScript: fileURLToPath(import.meta.url),
  })) + "\n");
}
void main().catch(error => {
  // No stack, file contents or environment secrets in service logs.
  process.stderr.write("G4_PROBE_FAILED:" + (
    error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
      ? error.message : "UNEXPECTED_FAILURE"
  ) + "\n");
  process.exitCode = 1;
});
