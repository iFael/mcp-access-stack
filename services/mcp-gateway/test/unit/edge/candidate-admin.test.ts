import { describe, expect, it } from "@jest/globals";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateAdminLedger } from "../../../src/admin/candidate-admin-ledger.js";
import { candidateProvisionInputSchema, CandidateServiceAdmin } from "../../../src/admin/candidate-service.js";
import { createCandidateAdminServer } from "../../../src/admin/candidate-admin-cli.js";

describe("private candidate admin", () => {
  const input = { operationId: "123e4567-e89b-42d3-a456-426614174000", candidateReleaseId: "1.1.0-beta.84-connector.1" as const, expectedManifestSha256: "a".repeat(64), expectedActivePid: 540237, execute: false };
  it("rejects malformed and unauthorized inputs", () => {
    expect(candidateProvisionInputSchema.safeParse({ ...input, operationId: "bad" }).success).toBe(false);
    expect(candidateProvisionInputSchema.safeParse({ ...input, candidateReleaseId: "../other" }).success).toBe(false);
    expect(candidateProvisionInputSchema.safeParse({ ...input, unitName: "arbitrary.service" }).success).toBe(false);
    expect(candidateProvisionInputSchema.safeParse({ ...input, expectedActivePid: 0 }).success).toBe(false);
  });
  it("rejects commands without local operator authority", async () => {
    const admin = new CandidateServiceAdmin(async () => { throw Error("RUN_FORBIDDEN"); }, async () => { throw Error("OWNER_DENIED"); });
    await expect(admin.provision(input)).rejects.toThrow("OWNER_DENIED");
  });
  it("runs only the fixed provisioner and reconciles uncertain outcomes", async () => {
    if (process.platform !== "linux") return;
    const seen: string[][] = [];
    const admin = new CandidateServiceAdmin(async (exe, args) => {
      seen.push([exe, ...args]);
      return { exitCode: 0, timedOut: false, stdout: `status=validated\noperationId=${input.operationId}\ncandidateRelease=${input.candidateReleaseId}\nactiveServicePreserved=true\n` };
    }, async () => {});
    await expect(admin.provision(input)).resolves.toMatchObject({ status: "validated" });
    expect(seen[0]?.[0]).toBe("/usr/bin/bash");
    expect(seen[0]?.[1]).toContain("Provision-McpConnectorCandidateService.sh");
    expect(seen[0]).not.toContain("--execute");
    const dir = await mkdtemp(join(tmpdir(), "candidate-admin-ledger-"));
    try {
      const ledger = new CandidateAdminLedger(join(dir, "ledger"));
      const timedOut = new CandidateServiceAdmin(async () => ({
        exitCode: null, timedOut: true, stdout: "",
      }), async () => {}, ledger);
      await expect(timedOut.provision({ ...input, execute: true })).rejects.toThrow("RECONCILIATION");
      await expect(ledger.reconcile(input.operationId)).resolves.toMatchObject({
        outcome: "outcome_unknown",
      });
      await expect(timedOut.provision({ ...input, execute: true })).rejects.toThrow("ALREADY_CLAIMED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("stores a successful claim once and permits read-only reconciliation", async () => {
    if (process.platform !== "linux") return;
    const dir = await mkdtemp(join(tmpdir(), "candidate-admin-ledger-"));
    try {
      const ledger = new CandidateAdminLedger(join(dir, "ledger"));
      await expect(ledger.reconcile(input.operationId)).resolves.toMatchObject({ outcome: "not_found" });
      await ledger.claim({ ...input, execute: true });
      await expect(ledger.reconcile(input.operationId)).resolves.toMatchObject({ outcome: "started" });
      await expect(ledger.claim({ ...input, execute: true })).rejects.toThrow("ALREADY_CLAIMED");
      await ledger.finish(input.operationId, "succeeded");
      await expect(ledger.reconcile(input.operationId)).resolves.toMatchObject({ outcome: "succeeded" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects linked ledger directories and malformed operation IDs", async () => {
    if (process.platform !== "linux") return;
    const dir = await mkdtemp(join(tmpdir(), "candidate-admin-ledger-"));
    try {
      await symlink(dir, join(dir, "ledger"));
      const ledger = new CandidateAdminLedger(join(dir, "ledger"));
      await expect(ledger.claim({ ...input, execute: true })).rejects.toThrow("UNTRUSTED");
      await expect(ledger.reconcile("../../etc/passwd")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("keeps a failure record rather than retrying a completed host mutation", async () => {
    if (process.platform !== "linux") return;
    const dir = await mkdtemp(join(tmpdir(), "candidate-admin-ledger-"));
    try {
      const ledger = new CandidateAdminLedger(join(dir, "ledger"));
      let calls = 0;
      const admin = new CandidateServiceAdmin(async () => {
        calls += 1;
        return { exitCode: 0, timedOut: false, stdout: `status=provisioned\noperationId=${input.operationId}\ncandidateRelease=${input.candidateReleaseId}\nactiveServicePreserved=true\n` };
      }, async () => {}, ledger);
      await expect(admin.provision({ ...input, execute: true })).resolves.toMatchObject({ status: "provisioned" });
      await expect(admin.provision({ ...input, execute: true })).rejects.toThrow("ALREADY_CLAIMED");
      expect(calls).toBe(1);
      await expect(admin.operationStatus(input.operationId)).resolves.toMatchObject({ outcome: "succeeded" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("registers a separate private tool catalog", () => {
    const server = createCandidateAdminServer();
    const registry = server as unknown as { _registeredTools: Record<string, unknown> };
    expect(Object.keys(registry._registeredTools).sort()).toEqual(["candidate_operation_status", "candidate_service_status", "provision_candidate_service"]);
  });
});
