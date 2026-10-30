// The Windows half of an mcp_update. The execution node publishes the
// companion release, then asks the user's companions, through the Edge, to
// install that tag in their MCP Access Stack workspace: prepare_release and
// promote_release, each once. The node repeats the request while it waits and
// each answer carries the companion's status, so a companion that restarts
// for its own promote is asked again and answers from what it saved.

/** Offered by the Edge to connectors and companions that may send these messages. */
export const COMPANION_UPDATE_FEATURE = "companionUpdateV1" as const;
/** A companion that announces this capability takes update requests from the Edge. */
export const COMPANION_UPDATE_CAPABILITY = "companion-update-v1" as const;

export type CompanionUpdateRequest = {
  updateId: string;
  /** A companion release tag, v<version>-companion.<CI runId>. */
  tag: string;
  /** The confirmation the user approved for the step that asked for one. */
  confirmationId?: string;
  /** Raised by each resume of the update: a companion tries again an install that failed on a lower attempt. */
  attempt?: number;
};

export type CompanionUpdatePhase = "prepare" | "promote";

export type CompanionUpdateStatus = {
  updateId: string;
  phase: CompanionUpdatePhase;
  state: "running" | "succeeded" | "failed" | "needs_confirmation";
  error?: { code: string; message: string };
  confirmation?: { confirmationId: string; reasons: string[]; expiresAt: string };
};

const UPDATE_ID = /^upd_[0-9a-f-]{36}$/u;
export const COMPANION_RELEASE_TAG = /^v\d+\.\d+\.\d+-companion\.[1-9]\d{0,19}$/u;
const CONFIRMATION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

export function parseCompanionUpdateRequest(value: unknown): CompanionUpdateRequest | null {
  if (!isRecord(value) || !onlyKeys(value, ["updateId", "tag", "confirmationId", "attempt"])) return null;
  if (typeof value.updateId !== "string" || !UPDATE_ID.test(value.updateId)) return null;
  if (typeof value.tag !== "string" || !COMPANION_RELEASE_TAG.test(value.tag)) return null;
  if (value.confirmationId !== undefined &&
      (typeof value.confirmationId !== "string" || !CONFIRMATION_ID.test(value.confirmationId))) return null;
  if (value.attempt !== undefined &&
      (typeof value.attempt !== "number" || !Number.isInteger(value.attempt) || value.attempt < 1 || value.attempt > 99)) return null;
  return {
    updateId: value.updateId,
    tag: value.tag,
    ...(value.confirmationId === undefined ? {} : { confirmationId: value.confirmationId as string }),
    ...(value.attempt === undefined ? {} : { attempt: value.attempt as number }),
  };
}

export function parseCompanionUpdateStatus(value: unknown): CompanionUpdateStatus | null {
  if (!isRecord(value) || !onlyKeys(value, ["updateId", "phase", "state", "error", "confirmation"])) return null;
  if (typeof value.updateId !== "string" || !UPDATE_ID.test(value.updateId)) return null;
  if (value.phase !== "prepare" && value.phase !== "promote") return null;
  if (value.state !== "running" && value.state !== "succeeded" && value.state !== "failed" &&
      value.state !== "needs_confirmation") return null;
  const status: CompanionUpdateStatus = { updateId: value.updateId, phase: value.phase, state: value.state };
  if (value.error !== undefined) {
    const error = value.error;
    if (!isRecord(error) || !onlyKeys(error, ["code", "message"]) ||
        typeof error.code !== "string" || !CODE.test(error.code) ||
        typeof error.message !== "string" || error.message.length > 500) return null;
    status.error = { code: error.code, message: error.message };
  }
  if (value.confirmation !== undefined) {
    const confirmation = value.confirmation;
    if (!isRecord(confirmation) || !onlyKeys(confirmation, ["confirmationId", "reasons", "expiresAt"]) ||
        typeof confirmation.confirmationId !== "string" || !CONFIRMATION_ID.test(confirmation.confirmationId) ||
        !Array.isArray(confirmation.reasons) || confirmation.reasons.length > 20 ||
        !confirmation.reasons.every((reason) => typeof reason === "string" && reason.length <= 300) ||
        typeof confirmation.expiresAt !== "string" || confirmation.expiresAt.length > 64) return null;
    status.confirmation = {
      confirmationId: confirmation.confirmationId,
      reasons: [...confirmation.reasons] as string[],
      expiresAt: confirmation.expiresAt,
    };
  }
  return status;
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
