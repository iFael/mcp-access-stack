import { fail } from "../errors.js";
import {
  RELEASE_ACTIONS,
  RELEASE_STAGES,
  type ReleaseWorkflowBlueprint,
} from "../types.js";

export function validateWorkflowBlueprint(
  blueprint: ReleaseWorkflowBlueprint,
): void {
  if (
    !isIdentifier(blueprint.id) ||
    !Number.isInteger(blueprint.version) ||
    blueprint.version < 1 ||
    !blueprint.name.trim() ||
    !blueprint.historicalReference.trim()
  ) {
    fail("BLUEPRINT_INVALID", "Blueprint identity and version are invalid.");
  }
  if (blueprint.stages.length !== RELEASE_STAGES.length) {
    fail("BLUEPRINT_INVALID", "Blueprint must declare all canonical release stages.");
  }
  for (const stage of RELEASE_STAGES) {
    if (!blueprint.stages.includes(stage)) {
      fail("BLUEPRINT_INVALID", `Blueprint is missing stage ${stage}.`);
    }
  }

  const gates = new Set<string>();
  for (const gate of blueprint.gates) {
    if (
      !isIdentifier(gate.id) ||
      gates.has(gate.id) ||
      !blueprint.stages.includes(gate.stage) ||
      gate.requiredEvidenceKinds.length === 0 ||
      new Set(gate.requiredEvidenceKinds).size !== gate.requiredEvidenceKinds.length ||
      gate.requiredEvidenceKinds.some((kind) => !isIdentifier(kind))
    ) {
      fail("BLUEPRINT_INVALID", `Invalid or duplicate health gate ${gate.id}.`);
    }
    gates.add(gate.id);
  }

  const steps = new Map<string, number>();
  blueprint.steps.forEach((step, ordinal) => {
    if (
      !isIdentifier(step.id) ||
      steps.has(step.id) ||
      !blueprint.stages.includes(step.stage) ||
      !(RELEASE_ACTIONS as readonly string[]).includes(step.action) ||
      !["read_only", "external_effect"].includes(step.executionClass)
    ) {
      fail("BLUEPRINT_INVALID", `Invalid or duplicate workflow step ${step.id}.`);
    }
    if (step.healthGateId && !gates.has(step.healthGateId)) {
      fail("BLUEPRINT_INVALID", `Step ${step.id} references an unknown health gate.`);
    }
    for (const gateId of step.requiredGates) {
      if (!gates.has(gateId)) {
        fail("BLUEPRINT_INVALID", `Step ${step.id} requires an unknown health gate.`);
      }
    }
    steps.set(step.id, ordinal);
  });

  for (const step of blueprint.steps) {
    for (const dependency of step.dependsOn) {
      if (!steps.has(dependency) || dependency === step.id) {
        fail("BLUEPRINT_INVALID", `Step ${step.id} has an invalid dependency.`);
      }
    }
  }
  assertAcyclic(blueprint);
}

function assertAcyclic(blueprint: ReleaseWorkflowBlueprint): void {
  const byId = new Map(blueprint.steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (stepId: string): void => {
    if (visiting.has(stepId)) {
      fail("BLUEPRINT_INVALID", `Workflow dependency cycle includes ${stepId}.`);
    }
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    const step = byId.get(stepId);
    if (!step) fail("BLUEPRINT_INVALID", `Missing step ${stepId}.`);
    for (const dependency of step.dependsOn) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };

  for (const step of blueprint.steps) visit(step.id);
}

function isIdentifier(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,79}$/u.test(value);
}
