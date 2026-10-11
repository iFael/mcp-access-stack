import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";
import { inspectG4Probe, runG4SafetyProbe } from "../../../src/campaign/campaign-g4-safety-probe.js";

const workerScript = fileURLToPath(new URL("./g4-probe-child.ts", import.meta.url));

describe("G4 native synthetic OS probe", () => {
  it("observes SIGTERM in-flight and reconciles the same ID without redispatch", async () => {
    const stateParent = await mkdtemp(path.join(tmpdir(), "g4-native-"));
    const campaignId = randomUUID();
    try {
      expect((await inspectG4Probe(stateParent, campaignId)).state).toBe("not_started");
      const result = await runG4SafetyProbe({
        stateParent, campaignId, workerScript, workerExecArgv: ["--import", "tsx"],
      });
      expect(result.stop).toBe("all_completed");
      expect(result.revision).toBe(3);
      expect(result.redispatches).toBe(0);
      expect(result.sigterm).toBe("observed");
      expect(result.outcomeUnknown).toBe("observed");
      expect(result.crossVm).toBe("not_tested_local_lease_only");
      expect(result.memoryRssBytes).toBeGreaterThan(32 * 1024 * 1024);
      expect(result.memoryRssBytes).toBeLessThan(256 * 1024 * 1024);
      expect(await inspectG4Probe(stateParent, campaignId)).toEqual({
        campaignId, state: "completed", revision: 3, operationId: result.operationId,
      });
      await expect(runG4SafetyProbe({
        stateParent, campaignId, workerScript, workerExecArgv: ["--import", "tsx"],
      })).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readdir(stateParent)).toEqual(["g4-inflight-" + campaignId]);
    } finally {
      await rm(stateParent, { recursive: true, force: true });
    }
  }, 30000);

  it("rejects an invalid UUID before creating a fixture", async () => {
    const stateParent = await mkdtemp(path.join(tmpdir(), "g4-bad-id-"));
    try {
      await expect(runG4SafetyProbe({
        stateParent, campaignId: "invalid", workerScript,
      })).rejects.toThrow("G4_PROBE_INVALID_ID");
      expect(await readdir(stateParent)).toEqual([]);
    } finally {
      await rm(stateParent, { recursive: true, force: true });
    }
  });
});
