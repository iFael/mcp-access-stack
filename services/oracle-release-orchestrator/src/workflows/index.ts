import { fail } from "../errors.js";
import type { ReleaseWorkflowBlueprint } from "../types.js";
import { beta80ReleaseBlueprint } from "./beta80-sequence.v1.js";

const blueprints: readonly ReleaseWorkflowBlueprint[] = [
  beta80ReleaseBlueprint,
];

export function getWorkflowBlueprint(
  blueprintId: string,
  version: number,
): ReleaseWorkflowBlueprint {
  const blueprint = blueprints.find(
    (item) => item.id === blueprintId && item.version === version,
  );
  if (!blueprint) {
    fail(
      "BLUEPRINT_NOT_FOUND",
      `No release blueprint registered for ${blueprintId}@${version}.`,
    );
  }
  return blueprint;
}

export function listWorkflowBlueprints(): readonly ReleaseWorkflowBlueprint[] {
  return blueprints;
}
