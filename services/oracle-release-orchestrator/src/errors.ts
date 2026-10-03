export type OrchestratorErrorCode =
  | "INVALID_ARGUMENT"
  | "BLUEPRINT_NOT_FOUND"
  | "BLUEPRINT_INVALID"
  | "BLUEPRINT_VERSION_CONFLICT"
  | "RUN_NOT_FOUND"
  | "STEP_NOT_FOUND"
  | "GATE_NOT_FOUND"
  | "INVALID_TRANSITION"
  | "DEPENDENCY_NOT_SATISFIED"
  | "GATE_NOT_PASSED"
  | "RECONCILIATION_REQUIRED"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "OPERATION_NOT_FOUND"
  | "EVIDENCE_NOT_FOUND"
  | "LEDGER_PATH_INVALID"
  | "LEDGER_SCHEMA_INVALID";

export class ReleaseOrchestratorError extends Error {
  public constructor(
    public readonly code: OrchestratorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReleaseOrchestratorError";
  }
}

export function fail(
  code: OrchestratorErrorCode,
  message: string,
): never {
  throw new ReleaseOrchestratorError(code, message);
}
