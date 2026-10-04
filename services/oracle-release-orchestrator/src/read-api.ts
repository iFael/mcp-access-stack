import { timingSafeEqual, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ReleaseOrchestratorError } from "./errors.js";
import type { ReleaseOrchestrator } from "./engine/release-orchestrator.js";
import type {
  EvidenceRecord,
  ReleaseRunEvent,
  ReleaseRunSnapshot,
} from "./types.js";

const API_PREFIX = "/internal/v1";
const MAX_CURSOR_LENGTH = 512;
const MAX_LIST_LIMIT = 25;
const MAX_EVENT_LIMIT = 100;
const MAX_EVIDENCE_LIMIT = 100;
const MAX_WAIT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface RunCursor {
  readonly createdAt: string;
  readonly runId: string;
}

export interface EvidenceCursor {
  readonly recordedAt: string;
  readonly evidenceId: string;
}

export interface PublicReleaseStepSnapshot {
  readonly stepId: string;
  readonly stage: string;
  readonly action: string;
  readonly executionClass: string;
  readonly status: string;
  readonly attemptCount: number;
}

export interface PublicReleaseRunSnapshot extends Omit<ReleaseRunSnapshot, "steps"> {
  readonly steps: readonly PublicReleaseStepSnapshot[];
}

export interface PublicReleaseEvidence {
  readonly evidenceId: string;
  readonly runId: string;
  readonly stepId: string | null;
  readonly kind: string;
  readonly sha256: string;
  readonly observedAt: string;
  readonly recordedAt: string;
}

export interface PublicReleaseRunEvent {
  readonly runId: string;
  readonly seq: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
  readonly redacted: boolean;
}

export interface OracleReleaseReadApiOptions {
  readonly orchestrator: ReleaseOrchestrator;
  readonly bearerToken: string;
  readonly maxConcurrentWaits?: number;
  readonly pollIntervalMs?: number;
}

export type OracleReleaseReadApi = (request: Request) => Promise<Response>;

export function createOracleReleaseReadApi(options: OracleReleaseReadApiOptions): OracleReleaseReadApi {
  validateServiceToken(options.bearerToken);
  const maxConcurrentWaits = options.maxConcurrentWaits ?? 32;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  if (!Number.isInteger(maxConcurrentWaits) || maxConcurrentWaits < 1 || maxConcurrentWaits > 256) {
    throw new Error("maxConcurrentWaits must be between 1 and 256.");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 1_000) {
    throw new Error("pollIntervalMs must be between 10 and 1000.");
  }
  let activeWaits = 0;

  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "GET" });
    }
    if (!authorized(request.headers.get("authorization"), options.bearerToken)) {
      return jsonResponse({ error: "unauthorized" }, 401, {
        "www-authenticate": "Bearer",
      });
    }

    try {
      const url = new URL(request.url);
      if (url.pathname === `${API_PREFIX}/runs`) {
        return listRuns(options.orchestrator, url);
      }
      const match = url.pathname.match(
        new RegExp(`^${API_PREFIX}/runs/([^/]+)(?:/events)?$`, "u"),
      );
      if (!match?.[1]) return jsonResponse({ error: "not_found" }, 404);
      const runId = decodePathSegment(match[1]);
      validateRunId(runId);
      if (url.pathname.endsWith("/events")) {
        return await readEvents(options.orchestrator, runId, url, {
          get active() { return activeWaits; },
          increment() { activeWaits += 1; },
          decrement() { activeWaits -= 1; },
        }, maxConcurrentWaits, pollIntervalMs);
      }
      return readRun(options.orchestrator, runId, url);
    } catch (error) {
      if (error instanceof ReadApiInputError) {
        return jsonResponse({ error: error.code }, 400);
      }
      if (error instanceof ReleaseOrchestratorError) {
        if (error.code === "RUN_NOT_FOUND") return jsonResponse({ error: "run_not_found" }, 404);
        if (error.code === "INVALID_ARGUMENT") return jsonResponse({ error: "invalid_argument" }, 400);
      }
      return jsonResponse({ error: "orchestrator_unavailable" }, 503);
    }
  };
}

function listRuns(orchestrator: ReleaseOrchestrator, url: URL): Response {
  assertOnlyQueryKeys(url, ["limit", "cursor"]);
  const limit = readInteger(url.searchParams.get("limit"), 20, 1, MAX_LIST_LIMIT, "invalid_limit");
  const cursorValue = readBoundedString(url.searchParams.get("cursor"), MAX_CURSOR_LENGTH, "invalid_cursor");
  const cursor = cursorValue === null ? undefined : decodeRunCursor(cursorValue);
  const page = orchestrator.listRuns(limit, cursor);
  return jsonResponse({
    runs: page.runs.map(toPublicRun),
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    hasMore: page.nextCursor !== null,
  });
}

function readRun(orchestrator: ReleaseOrchestrator, runId: string, url: URL): Response {
  assertOnlyQueryKeys(url, ["evidenceLimit", "evidenceCursor"]);
  const evidenceLimit = readInteger(
    url.searchParams.get("evidenceLimit"),
    50,
    1,
    MAX_EVIDENCE_LIMIT,
    "invalid_evidence_limit",
  );
  const cursorValue = readBoundedString(
    url.searchParams.get("evidenceCursor"),
    MAX_CURSOR_LENGTH,
    "invalid_evidence_cursor",
  );
  const cursor = cursorValue === null ? undefined : decodeEvidenceCursor(cursorValue);
  const snapshot = orchestrator.getRun(runId);
  const evidence = orchestrator.pageEvidence(runId, evidenceLimit, cursor);
  return jsonResponse({
    run: toPublicRun(snapshot),
    evidence: evidence.records.map(toPublicEvidence),
    nextEvidenceCursor: evidence.nextCursor ? encodeCursor(evidence.nextCursor) : null,
    hasMoreEvidence: evidence.nextCursor !== null,
  });
}

async function readEvents(
  orchestrator: ReleaseOrchestrator,
  runId: string,
  url: URL,
  counter: { readonly active: number; increment(): void; decrement(): void },
  maxConcurrentWaits: number,
  pollIntervalMs: number,
): Promise<Response> {
  assertOnlyQueryKeys(url, ["afterSeq", "limit", "waitMs"]);
  const afterSeq = readInteger(
    url.searchParams.get("afterSeq"),
    0,
    0,
    Number.MAX_SAFE_INTEGER,
    "invalid_after_seq",
  );
  const limit = readInteger(url.searchParams.get("limit"), 100, 1, MAX_EVENT_LIMIT, "invalid_event_limit");
  const waitMs = readInteger(url.searchParams.get("waitMs"), 0, 0, MAX_WAIT_MS, "invalid_wait");
  const initialSnapshot = orchestrator.getRun(runId);
  if (afterSeq > initialSnapshot.lastSeq) throw new ReadApiInputError("invalid_after_seq");
  const initialEvents = orchestrator.replayEvents(runId, afterSeq, limit);
  if (initialEvents.length > 0) {
    return jsonResponse(eventResponse(orchestrator, runId, afterSeq, initialEvents, limit));
  }
  if (waitMs === 0) {
    return jsonResponse({ outcome: "timeout", runId, afterSeq, events: [], currentSeq: initialSnapshot.lastSeq });
  }
  if (counter.active >= maxConcurrentWaits) {
    return jsonResponse({ error: "wait_capacity_exceeded" }, 503, { "retry-after": "1" });
  }

  counter.increment();
  try {
    const deadline = performance.now() + waitMs;
    let events = initialEvents;
    while (true) {
      if (events.length > 0) {
        return jsonResponse(eventResponse(orchestrator, runId, afterSeq, events, limit));
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        const finalEvents = orchestrator.replayEvents(runId, afterSeq, limit);
        if (finalEvents.length > 0) {
          return jsonResponse(eventResponse(orchestrator, runId, afterSeq, finalEvents, limit));
        }
        return jsonResponse({
          outcome: "timeout",
          runId,
          afterSeq,
          events: [],
          currentSeq: orchestrator.getRun(runId).lastSeq,
        });
      }
      await delay(Math.min(pollIntervalMs, remaining));
      events = orchestrator.replayEvents(runId, afterSeq, limit);
    }
  } finally {
    counter.decrement();
  }
}

function eventResponse(
  orchestrator: ReleaseOrchestrator,
  runId: string,
  afterSeq: number,
  events: readonly ReleaseRunEvent[],
  limit: number,
) {
  const currentSeq = orchestrator.getRun(runId).lastSeq;
  const publicEvents = events.map(toPublicEvent);
  const lastSeq = publicEvents.at(-1)?.seq ?? afterSeq;
  return {
    outcome: "events",
    runId,
    afterSeq,
    events: publicEvents,
    currentSeq,
    hasMore: publicEvents.length === limit && lastSeq < currentSeq,
  };
}

export function toPublicRun(run: ReleaseRunSnapshot): PublicReleaseRunSnapshot {
  return {
    ...run,
    steps: run.steps.map(({ operationId: _operationId, idempotencyKey: _idempotencyKey, ...step }) => step),
  };
}

export function toPublicEvidence(evidence: EvidenceRecord): PublicReleaseEvidence {
  return {
    evidenceId: evidence.evidenceId,
    runId: evidence.runId,
    stepId: evidence.stepId,
    kind: evidence.kind,
    sha256: evidence.sha256,
    observedAt: evidence.observedAt,
    recordedAt: evidence.recordedAt,
  };
}

export function toPublicEvent(event: ReleaseRunEvent): PublicReleaseRunEvent {
  const { payload, redacted } = projectEventPayload(event.eventType, event.payload);
  return {
    runId: event.runId,
    seq: event.seq,
    eventId: event.eventId,
    eventType: event.eventType,
    payload,
    occurredAt: event.occurredAt,
    redacted,
  };
}

function projectEventPayload(
  eventType: string,
  value: Readonly<Record<string, unknown>>,
): { payload: Readonly<Record<string, unknown>>; redacted: boolean } {
  const allowlists: Record<string, readonly string[]> = {
    "run.created": ["blueprintId", "blueprintVersion", "blueprintSha256", "targetRelease", "sourceCommitSha"],
    "run.started": [],
    "step.intent_recorded": ["stepId", "action", "attemptNumber", "executionClass"],
    "step.succeeded": ["stepId", "attemptNumber", "outcomeCode", "evidenceIds"],
    "step.failed": ["stepId", "attemptNumber", "outcomeCode", "evidenceIds"],
    "operation.outcome_unknown": ["stepId", "attemptNumber", "reasonCode"],
    "operation.recovered_as_unknown": ["stepId", "attemptNumber"],
    "operation.reconciled_applied": ["stepId", "attemptNumber", "evidenceIds"],
    "operation.reconciled_not_applied": ["stepId", "attemptNumber", "evidenceIds"],
    "operation.reconciled_still_unknown": ["stepId", "attemptNumber", "evidenceIds"],
    "health_gate.passed": ["gateId", "evidenceIds"],
    "health_gate.failed": ["gateId", "evidenceIds"],
    "run.succeeded": [],
  };
  const allowed = allowlists[eventType];
  if (!allowed) return { payload: {}, redacted: true };
  const projected = Object.fromEntries(allowed
    .filter((key) => Object.hasOwn(value, key))
    .map((key) => [key, value[key]]));
  return { payload: projected, redacted: Object.keys(value).some((key) => !allowed.includes(key)) };
}

function authorized(header: string | null, expected: string): boolean {
  if (!header || !header.startsWith("Bearer ") || header.length > 4096) return false;
  const actual = header.slice(7).trim();
  if (!actual || actual.length > 2048) return false;
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

function validateServiceToken(value: string): void {
  if (typeof value !== "string" || value.length < 32 || value.length > 2048 || /[\r\n\0]/u.test(value)) {
    throw new Error("Internal read API bearer token must be 32 to 2048 safe characters.");
  }
}

function readInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (value === null) return fallback;
  if (!/^\d{1,16}$/u.test(value)) throw new ReadApiInputError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ReadApiInputError(code);
  }
  return parsed;
}

function assertOnlyQueryKeys(url: URL, allowed: readonly string[]): void {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) throw new ReadApiInputError("unsupported_query");
    if (seen.has(key)) throw new ReadApiInputError("duplicate_query");
    seen.add(key);
  }
}

function readBoundedString(value: string | null, maximum: number, code: string): string | null {
  if (value === null) return null;
  if (value.length === 0 || value.length > maximum) throw new ReadApiInputError(code);
  return value;
}

function validateRunId(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new ReadApiInputError("invalid_run_id");
}

function decodePathSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes("/") || decoded.includes("\\") || decoded.length > 128) {
      throw new ReadApiInputError("invalid_path");
    }
    return decoded;
  } catch {
    throw new ReadApiInputError("invalid_path");
  }
}

function decodeRunCursor(value: string): RunCursor {
  const decoded = decodeCursor(value);
  if (typeof decoded.createdAt !== "string" || !Number.isFinite(Date.parse(decoded.createdAt)) ||
      typeof decoded.runId !== "string" || !UUID_PATTERN.test(decoded.runId)) {
    throw new ReadApiInputError("invalid_cursor");
  }
  return { createdAt: decoded.createdAt, runId: decoded.runId };
}

function decodeEvidenceCursor(value: string): EvidenceCursor {
  const decoded = decodeCursor(value);
  if (typeof decoded.recordedAt !== "string" || !Number.isFinite(Date.parse(decoded.recordedAt)) ||
      typeof decoded.evidenceId !== "string" || !UUID_PATTERN.test(decoded.evidenceId)) {
    throw new ReadApiInputError("invalid_evidence_cursor");
  }
  return { recordedAt: decoded.recordedAt, evidenceId: decoded.evidenceId };
}

function decodeCursor(value: string): Record<string, unknown> {
  if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ReadApiInputError("invalid_cursor");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isRecord(parsed)) throw new Error("cursor");
    return parsed;
  } catch {
    throw new ReadApiInputError("invalid_cursor");
  }
}

function encodeCursor(value: RunCursor | EvidenceCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESPONSE_BYTES) {
    return new Response(JSON.stringify({ error: "response_too_large" }), {
      status: 413,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(encoded, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ReadApiInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReadApiInputError";
  }
}
