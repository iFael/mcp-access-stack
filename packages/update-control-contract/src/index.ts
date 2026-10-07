export const UPDATE_CONTROL_RUN_STATUSES = [
  "planned",
  "running",
  "paused_outcome_unknown",
  "failed",
  "succeeded",
] as const;
export type UpdateControlRunStatus = (typeof UPDATE_CONTROL_RUN_STATUSES)[number];

export const UPDATE_CONTROL_STEP_STATUSES = [
  "pending",
  "in_progress",
  "outcome_unknown",
  "failed",
  "succeeded",
] as const;
export type UpdateControlStepStatus = (typeof UPDATE_CONTROL_STEP_STATUSES)[number];

export const UPDATE_CONTROL_GATE_STATUSES = [
  "pending",
  "passed",
  "failed",
  "outcome_unknown",
] as const;
export type UpdateControlGateStatus = (typeof UPDATE_CONTROL_GATE_STATUSES)[number];

export interface UpdateControlStepSnapshot {
  readonly stepId: string;
  readonly stage: "build_release" | "deployment" | "homologation";
  readonly action: string;
  readonly executionClass: "read_only" | "external_effect";
  readonly status: UpdateControlStepStatus;
  readonly attemptCount: number;
}

export interface UpdateControlGateSnapshot {
  readonly gateId: string;
  readonly stage: "build_release" | "deployment" | "homologation";
  readonly status: UpdateControlGateStatus;
  readonly requiredEvidenceKinds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface UpdateControlRunSnapshot {
  readonly runId: string;
  readonly blueprintId: string;
  readonly blueprintVersion: number;
  readonly blueprintSha256: string;
  readonly targetRelease: string;
  readonly sourceCommitSha: string;
  readonly status: UpdateControlRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeq: number;
  readonly steps: readonly UpdateControlStepSnapshot[];
  readonly gates: readonly UpdateControlGateSnapshot[];
}

export interface UpdateControlEvidence {
  readonly evidenceId: string;
  readonly runId: string;
  readonly stepId: string | null;
  readonly kind: string;
  readonly sha256: string;
  readonly observedAt: string;
  readonly recordedAt: string;
}

export interface UpdateControlEvent {
  readonly runId: string;
  readonly seq: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
  readonly redacted: boolean;
}

export interface UpdateControlRunCursor {
  readonly createdAt: string;
  readonly runId: string;
}

export interface UpdateControlEvidenceCursor {
  readonly recordedAt: string;
  readonly evidenceId: string;
}

export interface UpdateListRunsArguments {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface UpdateListRunsResult {
  readonly runs: readonly UpdateControlRunSnapshot[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface UpdateGetRunArguments {
  readonly runId: string;
  readonly evidenceLimit?: number;
  readonly evidenceCursor?: string;
}

export interface UpdateGetRunResult {
  readonly run: UpdateControlRunSnapshot;
  readonly evidence: readonly UpdateControlEvidence[];
  readonly nextEvidenceCursor: string | null;
  readonly hasMoreEvidence: boolean;
}

export interface UpdateWaitEventsArguments {
  readonly runId: string;
  readonly afterSeq: number;
  readonly timeoutSeconds?: number;
  readonly limit?: number;
}

export interface UpdateWaitEventsResult {
  readonly outcome: "events" | "timeout";
  readonly runId: string;
  readonly afterSeq: number;
  readonly events: readonly UpdateControlEvent[];
  readonly currentSeq: number;
  readonly hasMore?: boolean;
}

export interface UpdateControlToolDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<{
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: false;
  }>;
  readonly securitySchemes: readonly [{
    readonly type: "oauth2";
    readonly scopes: readonly ["update:read"];
  }];
  readonly _meta: Readonly<{
    securitySchemes: readonly [{
      readonly type: "oauth2";
      readonly scopes: readonly ["update:read"];
    }];
  }>;
}

const annotation = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const oauthSecuritySchemes = [{ type: "oauth2", scopes: ["update:read"] }] as const;
const oauthMeta = { securitySchemes: oauthSecuritySchemes } as const;

export const UPDATE_CONTROL_TOOL_MANIFEST: readonly UpdateControlToolDescriptor[] = [
  {
    name: "update_list_runs",
    title: "List release runs",
    description: "Lists recent MCP V3 release runs from the authoritative Oracle ledger. Results are paginated; this tool performs no lifecycle action.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 25, default: 20 },
        cursor: { type: "string", minLength: 1, maxLength: 512 },
      },
      additionalProperties: false,
    },
    annotations: annotation,
    securitySchemes: oauthSecuritySchemes,
    _meta: oauthMeta,
  },
  {
    name: "update_get_run",
    title: "Get release run",
    description: "Returns the authoritative snapshot and a bounded page of evidence metadata for one release run. Private operation and idempotency keys and evidence source strings are omitted.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", format: "uuid" },
        evidenceLimit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        evidenceCursor: { type: "string", minLength: 1, maxLength: 512 },
      },
      required: ["runId"],
      additionalProperties: false,
    },
    annotations: annotation,
    securitySchemes: oauthSecuritySchemes,
    _meta: oauthMeta,
  },
  {
    name: "update_wait_events",
    title: "Wait for release events",
    description: "Returns the ordered event replay after afterSeq immediately when available, or waits for at most 15 seconds. The result distinguishes new events from timeout and preserves canonical run states, including outcome_unknown.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", format: "uuid" },
        afterSeq: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        timeoutSeconds: { type: "integer", minimum: 0, maximum: 15, default: 10 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
      },
      required: ["runId", "afterSeq"],
      additionalProperties: false,
    },
    annotations: annotation,
    securitySchemes: oauthSecuritySchemes,
    _meta: oauthMeta,
  },
] as const;

export const UPDATE_CONTROL_CATALOG_METADATA = {
  contractRevision: "update-control-v1",
  toolSetRevision: "update-control-tools-v1",
  toolCount: 3,
} as const;

export class UpdateControlInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateControlInputError";
  }
}

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseUpdateListRunsArguments(value: unknown): UpdateListRunsArguments {
  const input = strictObject(value, ["limit", "cursor"]);
  const limit = optionalInteger(input.limit, 20, 1, 25, "limit");
  const cursor = optionalCursor(input.cursor, "cursor");
  return { limit, ...(cursor === undefined ? {} : { cursor }) };
}

export function parseUpdateGetRunArguments(value: unknown): UpdateGetRunArguments {
  const input = strictObject(value, ["runId", "evidenceLimit", "evidenceCursor"]);
  const runId = requiredRunId(input.runId);
  const evidenceLimit = optionalInteger(input.evidenceLimit, 50, 1, 100, "evidenceLimit");
  const evidenceCursor = optionalCursor(input.evidenceCursor, "evidenceCursor");
  return {
    runId,
    evidenceLimit,
    ...(evidenceCursor === undefined ? {} : { evidenceCursor }),
  };
}

export function parseUpdateWaitEventsArguments(value: unknown): UpdateWaitEventsArguments {
  const input = strictObject(value, ["runId", "afterSeq", "timeoutSeconds", "limit"]);
  const runId = requiredRunId(input.runId);
  const afterSeq = requiredInteger(input.afterSeq, 0, Number.MAX_SAFE_INTEGER, "afterSeq");
  const timeoutSeconds = optionalInteger(input.timeoutSeconds, 10, 0, 15, "timeoutSeconds");
  const limit = optionalInteger(input.limit, 100, 1, 100, "limit");
  return { runId, afterSeq, timeoutSeconds, limit };
}

function strictObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new UpdateControlInputError("Arguments must be an object.");
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new UpdateControlInputError("Arguments contain an unsupported property.");
  }
  return value;
}

function requiredRunId(value: unknown): string {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw new UpdateControlInputError("runId must be a UUID.");
  }
  return value;
}

function requiredInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new UpdateControlInputError(`${name} is outside the allowed integer range.`);
  }
  return value as number;
}

function optionalInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  return value === undefined ? fallback : requiredInteger(value, minimum, maximum, name);
}

function optionalCursor(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 512 ||
      !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new UpdateControlInputError(`${name} is invalid.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export * from "./oracle-channel.js";
