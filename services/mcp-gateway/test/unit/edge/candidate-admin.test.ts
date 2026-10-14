import { describe, expect, it } from "@jest/globals";
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
    const seen: string[][] = [];
    const admin = new CandidateServiceAdmin(async (exe, args) => {
      seen.push([exe, ...args]);
      return { exitCode: 0, timedOut: false, stdout: `status=validated\noperationId=${input.operationId}\ncandidateRelease=${input.candidateReleaseId}\nactiveServicePreserved=true\n` };
    }, async () => {});
    await expect(admin.provision(input)).resolves.toMatchObject({ status: "validated" });
    expect(seen[0]?.[0]).toBe("/usr/bin/bash");
    expect(seen[0]?.[1]).toContain("Provision-McpConnectorCandidateService.sh");
    expect(seen[0]).not.toContain("--execute");
    const timedOut = new CandidateServiceAdmin(async () => ({ exitCode: null, timedOut: true, stdout: "" }), async () => {});
    await expect(timedOut.provision({ ...input, execute: true })).rejects.toThrow("RECONCILIATION");
  });
  it("registers a separate two-tool catalog", () => {
    const server = createCandidateAdminServer();
    const registry = server as unknown as { _registeredTools: Record<string, unknown> };
    expect(Object.keys(registry._registeredTools).sort()).toEqual(["candidate_service_status", "provision_candidate_service"]);
  });
});
