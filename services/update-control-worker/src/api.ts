import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol";
import {
  UpdateControlInputError,
  parseUpdateGetRunArguments,
  parseUpdateListRunsArguments,
  parseUpdateWaitEventsArguments,
} from "@mcp-access-stack/update-control-contract";
import { UpdateControlClientError, type UpdateControlReadClient } from "./tools.js";

const API_PREFIX = "/api/v1";
const MAX_API_RESPONSE_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface UpdateControlApiHandlerOptions {
  readonly authenticate: (request: Request) => Promise<AuthenticatedEdgePrincipal>;
  readonly client: UpdateControlReadClient;
}

export type UpdateControlApiHandler = (request: Request) => Promise<Response>;

export function createUpdateControlApiHandler(
  options: UpdateControlApiHandlerOptions,
): UpdateControlApiHandler {
  return async (request): Promise<Response> => {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "GET" });
    }

    let principal: AuthenticatedEdgePrincipal;
    try {
      principal = await options.authenticate(request);
    } catch (error) {
      if (isAuthenticationResponseError(error)) return error.toResponse();
      return jsonResponse({ error: "authentication_unavailable" }, 503);
    }
    if (principal.ownerScope !== "owner" || !principal.scopes.includes("update:read")) {
      return jsonResponse({ error: "insufficient_scope" }, 403);
    }

    try {
      const url = new URL(request.url);
      if (url.pathname === `${API_PREFIX}/runs`) {
        assertOnlyQueryKeys(url, ["limit", "cursor"]);
        const limit = queryInteger(url, "limit");
        const cursor = queryString(url, "cursor");
        const result = await options.client.listRuns(parseUpdateListRunsArguments({
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        }));
        return jsonResponse(result);
      }

      const match = url.pathname.match(new RegExp(`^${API_PREFIX}/runs/([^/]+)(?:/events)?$`, "u"));
      if (!match?.[1]) return jsonResponse({ error: "not_found" }, 404);
      const runId = decodeRunId(match[1]);
      if (url.pathname.endsWith("/events")) {
        assertOnlyQueryKeys(url, ["afterSeq", "timeoutSeconds", "limit"]);
        const afterSeq = queryInteger(url, "afterSeq");
        const timeoutSeconds = queryInteger(url, "timeoutSeconds");
        const limit = queryInteger(url, "limit");
        const input = parseUpdateWaitEventsArguments({
          runId,
          ...(afterSeq === undefined ? {} : { afterSeq }),
          ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
          ...(limit === undefined ? {} : { limit }),
        });
        return jsonResponse(await options.client.waitEvents(input));
      }

      assertOnlyQueryKeys(url, ["evidenceLimit", "evidenceCursor"]);
      const evidenceLimit = queryInteger(url, "evidenceLimit");
      const evidenceCursor = queryString(url, "evidenceCursor");
      const input = parseUpdateGetRunArguments({
        runId,
        ...(evidenceLimit === undefined ? {} : { evidenceLimit }),
        ...(evidenceCursor === undefined ? {} : { evidenceCursor }),
      });
      return jsonResponse(await options.client.getRun(input));
    } catch (error) {
      if (error instanceof UpdateControlInputError || error instanceof ApiInputError) {
        return jsonResponse({ error: "invalid_argument" }, 400);
      }
      if (error instanceof UpdateControlClientError) {
        if (error.code === "RUN_NOT_FOUND") return jsonResponse({ error: "run_not_found" }, 404);
        return jsonResponse({ error: "orchestrator_unavailable" }, 503);
      }
      return jsonResponse({ error: "orchestrator_unavailable" }, 503);
    }
  };
}

function queryInteger(url: URL, key: string): number | undefined {
  const value = singleQueryValue(url, key);
  if (value === null) return undefined;
  if (!/^\d{1,16}$/u.test(value)) throw new ApiInputError("invalid_integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ApiInputError("invalid_integer");
  return parsed;
}

function queryString(url: URL, key: string): string | undefined {
  const value = singleQueryValue(url, key);
  if (value === null) return undefined;
  if (value.length === 0 || value.length > 512) throw new ApiInputError("invalid_string");
  return value;
}

function singleQueryValue(url: URL, key: string): string | null {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) throw new ApiInputError("duplicate_query");
  return values[0] ?? null;
}

function assertOnlyQueryKeys(url: URL, allowed: readonly string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) throw new ApiInputError("unsupported_query");
  }
}

function decodeRunId(value: string): string {
  let runId: string;
  try {
    runId = decodeURIComponent(value);
  } catch {
    throw new ApiInputError("invalid_run_id");
  }
  if (!UUID_PATTERN.test(runId) || runId.includes("/") || runId.includes("\\")) {
    throw new ApiInputError("invalid_run_id");
  }
  return runId;
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const encoded = JSON.stringify(body);
  if (new TextEncoder().encode(encoded).byteLength > MAX_API_RESPONSE_BYTES) {
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
      ...extraHeaders,
    },
  });
}

function isAuthenticationResponseError(
  error: unknown,
): error is { toResponse(): Response } {
  return typeof error === "object" && error !== null &&
    "name" in error && error.name === "EdgeAuthenticationError" &&
    "toResponse" in error && typeof error.toResponse === "function";
}

class ApiInputError extends Error {}
