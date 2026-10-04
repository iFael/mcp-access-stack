import {
  type UpdateControlEvent,
  type UpdateControlEvidence,
  type UpdateControlRunSnapshot,
  type UpdateGetRunArguments,
  type UpdateGetRunResult,
  type UpdateListRunsArguments,
  type UpdateListRunsResult,
  type UpdateWaitEventsArguments,
  type UpdateWaitEventsResult,
  UPDATE_CONTROL_GATE_STATUSES,
  UPDATE_CONTROL_RUN_STATUSES,
  UPDATE_CONTROL_STEP_STATUSES,
} from "@mcp-access-stack/update-control-contract";
import { UpdateControlClientError, type UpdateControlReadClient } from "./tools.js";
import {
  ORACLE_CHANNEL_MAX_FRAME_BYTES,
  ORACLE_CHANNEL_RPC_PATH,
  ORACLE_CHANNEL_SCOPE,
  type OracleChannelNamespace,
} from "./oracle-channel.js";

const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const WAIT_RPC_GRACE_MS = 5_000;
const MAX_WAIT_RPC_TIMEOUT_MS = 20_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export class UpdateControlOracleChannelReadClient implements UpdateControlReadClient {
  private readonly stub: { fetch(request: Request): Promise<Response> };

  constructor(namespace: OracleChannelNamespace) {
    if (!namespace || typeof namespace.idFromName !== "function" || typeof namespace.get !== "function") {
      throw new Error("Update Control Oracle channel binding is required.");
    }
    this.stub = namespace.get(namespace.idFromName(ORACLE_CHANNEL_SCOPE));
  }

  async listRuns(input: UpdateListRunsArguments): Promise<UpdateListRunsResult> {
    const value = await this.call("list_runs", input, DEFAULT_RPC_TIMEOUT_MS);
    if (!isListRunsResult(value)) throw unavailable();
    return value;
  }

  async getRun(input: UpdateGetRunArguments): Promise<UpdateGetRunResult> {
    const value = await this.call("get_run", input, DEFAULT_RPC_TIMEOUT_MS);
    if (!isGetRunResult(value)) throw unavailable();
    return value;
  }

  async waitEvents(input: UpdateWaitEventsArguments): Promise<UpdateWaitEventsResult> {
    const timeoutMs = Math.min(
      MAX_WAIT_RPC_TIMEOUT_MS,
      (input.timeoutSeconds ?? 10) * 1_000 + WAIT_RPC_GRACE_MS,
    );
    const value = await this.call("wait_events", input, timeoutMs);
    if (!isWaitEventsResult(value, input)) throw unavailable();
    return value;
  }

  private async call(
    method: "list_runs" | "get_run" | "wait_events",
    args: UpdateListRunsArguments | UpdateGetRunArguments | UpdateWaitEventsArguments,
    timeoutMs: number,
  ): Promise<unknown> {
    try {
      const requestBody = JSON.stringify({ method, arguments: args });
      if (new TextEncoder().encode(requestBody).byteLength > 4 * 1024) throw unavailable();
      const response = await this.stub.fetch(new Request(
        "https://update-control-channel.internal" + ORACLE_CHANNEL_RPC_PATH,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: requestBody,
          signal: AbortSignal.timeout(timeoutMs + 2_000),
          redirect: "error",
          cache: "no-store",
        },
      ));
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) throw unavailable();
      if (response.status === 404) {
        const notFound = JSON.parse(
          await readBoundedText(response, ORACLE_CHANNEL_MAX_FRAME_BYTES),
        ) as unknown;
        if (isRecord(notFound) && hasExactKeys(notFound, ["error"]) &&
            notFound.error === "RUN_NOT_FOUND") {
          throw new UpdateControlClientError("RUN_NOT_FOUND");
        }
        throw unavailable();
      }
      if (!response.ok) throw unavailable();
      const body = await readBoundedText(response, ORACLE_CHANNEL_MAX_FRAME_BYTES);
      const payload = JSON.parse(body) as unknown;
      if (!isRecord(payload) || !hasExactKeys(payload, ["result"]) ||
          !Object.hasOwn(payload, "result")) {
        throw unavailable();
      }
      return payload.result;
    } catch (error) {
      if (error instanceof UpdateControlClientError) throw error;
      throw unavailable();
    }
  }
}

function isListRunsResult(value: unknown): value is UpdateListRunsResult {
  return isRecord(value) &&
    hasExactKeys(value, ["runs", "nextCursor", "hasMore"]) &&
    Array.isArray(value.runs) && value.runs.length <= 25 &&
    (value.nextCursor === null || isBoundedCursor(value.nextCursor)) &&
    typeof value.hasMore === "boolean" &&
    value.runs.every(isRunSnapshot);
}

function isGetRunResult(value: unknown): value is UpdateGetRunResult {
  return isRecord(value) &&
    hasExactKeys(value, ["run", "evidence", "nextEvidenceCursor", "hasMoreEvidence"]) &&
    isRunSnapshot(value.run) &&
    Array.isArray(value.evidence) && value.evidence.length <= 100 &&
    value.evidence.every(isEvidence) &&
    (value.nextEvidenceCursor === null || isBoundedCursor(value.nextEvidenceCursor)) &&
    typeof value.hasMoreEvidence === "boolean";
}

function isWaitEventsResult(
  value: unknown,
  input: UpdateWaitEventsArguments,
): value is UpdateWaitEventsResult {
  if (!isRecord(value) ||
      !(hasExactKeys(value, ["outcome", "runId", "afterSeq", "events", "currentSeq"]) ||
        hasExactKeys(value, ["outcome", "runId", "afterSeq", "events", "currentSeq", "hasMore"])) ||
      (Object.hasOwn(value, "hasMore") && typeof value.hasMore !== "boolean") ||
      (value.outcome !== "events" && value.outcome !== "timeout") ||
      value.runId !== input.runId ||
      value.afterSeq !== input.afterSeq ||
      !Number.isSafeInteger(value.currentSeq) ||
      (value.currentSeq as number) < input.afterSeq ||
      !Array.isArray(value.events)) {
    return false;
  }
  const resultEvents = value.events as unknown[];
  const limit = input.limit ?? 100;
  if (resultEvents.length > limit ||
      !resultEvents.every((event, index) =>
        isEvent(event, input.runId, input.afterSeq) &&
        (index === 0 || event.seq > (resultEvents[index - 1] as UpdateControlEvent).seq))) {
    return false;
  }
  if ((value.outcome === "timeout" && resultEvents.length !== 0) ||
      (value.outcome === "events" && resultEvents.length === 0) ||
      (resultEvents.length > 0 &&
        (value.currentSeq as number) < (resultEvents[resultEvents.length - 1] as UpdateControlEvent).seq)) {
    return false;
  }
  return true;
}

function isRunSnapshot(value: unknown): value is UpdateControlRunSnapshot {
  if (!isRecord(value) ||
      typeof value.runId !== "string" || !UUID_PATTERN.test(value.runId) ||
      typeof value.blueprintId !== "string" ||
      !Number.isInteger(value.blueprintVersion) ||
      typeof value.blueprintSha256 !== "string" || !HASH_PATTERN.test(value.blueprintSha256) ||
      typeof value.targetRelease !== "string" ||
      typeof value.sourceCommitSha !== "string" ||
      typeof value.status !== "string" ||
      !(UPDATE_CONTROL_RUN_STATUSES as readonly string[]).includes(value.status) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
      !Number.isSafeInteger(value.lastSeq) ||
      !Array.isArray(value.steps) || value.steps.length > 100 ||
      !Array.isArray(value.gates) || value.gates.length > 100) return false;
  return value.steps.every((step) => isRecord(step) &&
      typeof step.stepId === "string" &&
      typeof step.stage === "string" &&
      typeof step.action === "string" &&
      (step.executionClass === "read_only" || step.executionClass === "external_effect") &&
      typeof step.status === "string" &&
      (UPDATE_CONTROL_STEP_STATUSES as readonly string[]).includes(step.status) &&
      Number.isSafeInteger(step.attemptCount)) &&
    value.gates.every((gate) => isRecord(gate) &&
      typeof gate.gateId === "string" &&
      typeof gate.stage === "string" &&
      typeof gate.status === "string" &&
      (UPDATE_CONTROL_GATE_STATUSES as readonly string[]).includes(gate.status) &&
      Array.isArray(gate.requiredEvidenceKinds) &&
      gate.requiredEvidenceKinds.length <= 100 &&
      Array.isArray(gate.evidenceIds) &&
      gate.evidenceIds.length <= 200);
}

function isEvidence(value: unknown): value is UpdateControlEvidence {
  return isRecord(value) &&
    typeof value.evidenceId === "string" && UUID_PATTERN.test(value.evidenceId) &&
    typeof value.runId === "string" && UUID_PATTERN.test(value.runId) &&
    (value.stepId === null || typeof value.stepId === "string") &&
    typeof value.kind === "string" &&
    typeof value.sha256 === "string" && HASH_PATTERN.test(value.sha256) &&
    typeof value.observedAt === "string" && Number.isFinite(Date.parse(value.observedAt)) &&
    typeof value.recordedAt === "string" && Number.isFinite(Date.parse(value.recordedAt)) &&
    !Object.hasOwn(value, "source");
}

function isEvent(value: unknown, runId: string, afterSeq: number): value is UpdateControlEvent {
  return isRecord(value) &&
    value.runId === runId &&
    Number.isSafeInteger(value.seq) && (value.seq as number) > afterSeq &&
    typeof value.eventId === "string" && UUID_PATTERN.test(value.eventId) &&
    typeof value.eventType === "string" &&
    isRecord(value.payload) &&
    typeof value.occurredAt === "string" && Number.isFinite(Date.parse(value.occurredAt)) &&
    typeof value.redacted === "boolean";
}

function isBoundedCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    /^[A-Za-z0-9_-]+$/u.test(value);
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    await response.body?.cancel();
    throw unavailable();
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw unavailable();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const normalized = [...expected].sort();
  return actual.length === normalized.length && actual.every((key, index) => key === normalized[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(): UpdateControlClientError {
  return new UpdateControlClientError("UPDATE_ORCHESTRATOR_UNAVAILABLE");
}
