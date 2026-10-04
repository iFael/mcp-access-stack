import {
  UPDATE_CONTROL_GATE_STATUSES,
  UPDATE_CONTROL_RUN_STATUSES,
  UPDATE_CONTROL_STEP_STATUSES,
  type UpdateControlEvidence,
  type UpdateControlEvent,
  type UpdateControlRunSnapshot,
  type UpdateGetRunArguments,
  type UpdateGetRunResult,
  type UpdateListRunsArguments,
  type UpdateListRunsResult,
  type UpdateWaitEventsArguments,
  type UpdateWaitEventsResult,
} from "@mcp-access-stack/update-control-contract";
import { UpdateControlClientError, type UpdateControlReadClient } from "./tools.js";

export interface OracleReleaseReadClientConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly accessClientId: string;
  readonly accessClientSecret: string;
  readonly maxResponseBytes?: number;
  readonly fetcher?: typeof fetch;
}

const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export class OracleReleaseReadClient implements UpdateControlReadClient {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly maxResponseBytes: number;

  constructor(private readonly config: OracleReleaseReadClientConfig, fetcher?: typeof fetch) {
    this.baseUrl = validateConfig(config);
    this.fetcher = fetcher ?? config.fetcher ?? globalThis.fetch.bind(globalThis);
    this.maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isInteger(this.maxResponseBytes) ||
        this.maxResponseBytes < 1 ||
        this.maxResponseBytes > DEFAULT_MAX_RESPONSE_BYTES) {
      throw new Error("maxResponseBytes must be between 1 and 262144.");
    }
  }

  async listRuns(input: UpdateListRunsArguments): Promise<UpdateListRunsResult> {
    const url = new URL("/internal/v1/runs", this.baseUrl);
    if (input.limit !== undefined) url.searchParams.set("limit", String(input.limit));
    if (input.cursor !== undefined) url.searchParams.set("cursor", input.cursor);
    const value = await this.getJson(url, 5_000);
    if (!isRecord(value) || !Array.isArray(value.runs) || value.runs.length > 25 ||
        !(value.nextCursor === null || isBoundedCursor(value.nextCursor)) ||
        typeof value.hasMore !== "boolean" ||
        !value.runs.every(isRunSnapshot)) {
      throw new UpdateControlClientError("UPDATE_ORCHESTRATOR_UNAVAILABLE");
    }
    return value as unknown as UpdateListRunsResult;
  }

  async getRun(input: UpdateGetRunArguments): Promise<UpdateGetRunResult> {
    const url = new URL(`/internal/v1/runs/${encodeURIComponent(input.runId)}`, this.baseUrl);
    if (input.evidenceLimit !== undefined) url.searchParams.set("evidenceLimit", String(input.evidenceLimit));
    if (input.evidenceCursor !== undefined) url.searchParams.set("evidenceCursor", input.evidenceCursor);
    const value = await this.getJson(url, 5_000);
    if (!isRecord(value) || !isRunSnapshot(value.run) ||
        !Array.isArray(value.evidence) || value.evidence.length > 100 ||
        !value.evidence.every(isEvidence) ||
        !(value.nextEvidenceCursor === null || isBoundedCursor(value.nextEvidenceCursor)) ||
        typeof value.hasMoreEvidence !== "boolean") {
      throw new UpdateControlClientError("UPDATE_ORCHESTRATOR_UNAVAILABLE");
    }
    return value as unknown as UpdateGetRunResult;
  }

  async waitEvents(input: UpdateWaitEventsArguments): Promise<UpdateWaitEventsResult> {
    const timeoutMs = (input.timeoutSeconds ?? 10) * 1_000;
    const limit = input.limit ?? 100;
    const url = new URL(
      `/internal/v1/runs/${encodeURIComponent(input.runId)}/events`,
      this.baseUrl,
    );
    url.searchParams.set("afterSeq", String(input.afterSeq));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("waitMs", String(timeoutMs));
    const value = await this.getJson(url, timeoutMs + 5_000);
    if (!isRecord(value)) {
      throw new UpdateControlClientError("UPDATE_ORCHESTRATOR_UNAVAILABLE");
    }
    const events = value.events;
    if ((value.outcome !== "events" && value.outcome !== "timeout") ||
        value.runId !== input.runId ||
        value.afterSeq !== input.afterSeq ||
        !Number.isSafeInteger(value.currentSeq) ||
        (value.currentSeq as number) < input.afterSeq ||
        !Array.isArray(events) ||
        events.length > limit ||
        !events.every((event, index) =>
          isEvent(event, input.runId, input.afterSeq) &&
          (index === 0 || event.seq > (events[index - 1] as UpdateControlEvent).seq))) {
      throw new UpdateControlClientError("UPDATE_ORCHESTRATOR_UNAVAILABLE");
    }
    if ((value.outcome === "timeout" && events.length !== 0) ||
        (value.outcome === "events" && events.length === 0) ||
        (events.length > 0 &&
          (value.currentSeq as number) < (events[events.length - 1] as UpdateControlEvent).seq)) {
      throw new UpdateControlClientError("UPDATE_ORCHESTRATOR_UNAVAILABLE");
    }
    return value as unknown as UpdateWaitEventsResult;
  }

  private async getJson(url: URL, timeoutMs: number): Promise<unknown> {
    try {
      const response = await this.fetcher(url.href, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.config.bearerToken}`,
          "cf-access-client-id": this.config.accessClientId,
          "cf-access-client-secret": this.config.accessClientSecret,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
        cache: "no-store",
      });
      if (response.status === 404) {
        throw new UpdateControlClientError("RUN_NOT_FOUND");
      }
      if (!response.ok || !(response.headers.get("content-type") ?? "")
        .toLowerCase().startsWith("application/json")) {
        throw new UpdateControlClientError("UPDATE_ORCHESTRATOR_UNAVAILABLE");
      }
      const text = await readBoundedText(response, this.maxResponseBytes);
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof UpdateControlClientError) throw error;
      throw new UpdateControlClientError("UPDATE_ORCHESTRATOR_UNAVAILABLE");
    }
  }
}

function validateConfig(config: OracleReleaseReadClientConfig): URL {
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error("ORCHESTRATOR_READ_API_URL must be an absolute HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("ORCHESTRATOR_READ_API_URL must be a credential-free HTTPS origin.");
  }
  if (typeof config.bearerToken !== "string" || config.bearerToken.length < 32 ||
      config.bearerToken.length > 2048 || /[\r\n\0]/u.test(config.bearerToken)) {
    throw new Error("UPDATE_CONTROL_ORCHESTRATOR_TOKEN is missing or invalid.");
  }
  if (typeof config.accessClientId !== "string" || config.accessClientId.length < 8 ||
      config.accessClientId.length > 1024 || /[\r\n\0]/u.test(config.accessClientId)) {
    throw new Error("ORACLE_ACCESS_CLIENT_ID is missing or invalid.");
  }
  if (typeof config.accessClientSecret !== "string" || config.accessClientSecret.length < 32 ||
      config.accessClientSecret.length > 2048 || /[\r\n\0]/u.test(config.accessClientSecret)) {
    throw new Error("ORACLE_ACCESS_CLIENT_SECRET is missing or invalid.");
  }
  return url;
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    await response.body?.cancel();
    throw new UpdateControlClientError("UPDATE_ORCHESTRATOR_UNAVAILABLE");
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
        throw new UpdateControlClientError("UPDATE_ORCHESTRATOR_UNAVAILABLE");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
