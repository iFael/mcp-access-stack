import { describe, expect, it } from "@jest/globals";
import { beta80ReleaseBlueprint } from "../../src/workflows/beta80-sequence.v1.js";
import { validateWorkflowBlueprint } from "../../src/workflows/validate-blueprint.js";
import type { ReleaseWorkflowBlueprint } from "../../src/types.js";

describe("beta.80 release blueprint", () => {
  it("is valid, versioned workflow data with explicit deployment and homologation stages", () => {
    expect(() => validateWorkflowBlueprint(beta80ReleaseBlueprint)).not.toThrow();
    expect(beta80ReleaseBlueprint.historicalReference).toBe("v1.1.0-beta.80");
    expect(beta80ReleaseBlueprint.stages).toEqual([
      "build_release",
      "deployment",
      "homologation",
    ]);
    expect(beta80ReleaseBlueprint.steps.map((step) => step.id)).toContain(
      "reconcile_final_pointers",
    );
  });

  it("requires the Oracle health gate before Windows promotion", () => {
    const promotion = beta80ReleaseBlueprint.steps.find(
      (step) => step.id === "promote_windows",
    );
    expect(promotion?.dependsOn).toContain("verify_oracle_health");
    expect(promotion?.requiredGates).toContain("oracle_healthy");
  });

  it("rejects dependency cycles before persisting a workflow", () => {
    const invalid = structuredClone(beta80ReleaseBlueprint) as ReleaseWorkflowBlueprint;
    const steps = invalid.steps.map((step) =>
      step.id === "resolve_main_commit"
        ? { ...step, dependsOn: ["verify_canonical_ci"] }
        : step,
    );
    expect(() =>
      validateWorkflowBlueprint({ ...invalid, steps }),
    ).toThrow(expect.objectContaining({ code: "BLUEPRINT_INVALID" }));
  });
});
