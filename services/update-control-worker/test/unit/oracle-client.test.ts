import { describe, expect, it, jest } from "@jest/globals";
import type { UpdateControlRunSnapshot, UpdateListRunsResult, UpdateWaitEventsResult } from "@mcp-access-stack/update-control-contract";
import { OracleReleaseReadClient } from "../../src/oracle-read-client.js";

const config = {
  baseUrl: "https://oracle-read-api.example.internal/",
  bearerToken: "orchestrator-service-token-".padEnd(48, "x"),
  accessClientId: "access-client-id.example",
  accessClientSecret: "access-client-secret-".padEnd(48, "y"),
};
const run: UpdateControlRunSnapshot = {
  runId: "6aa35d14-07fb-414c-9f91-f9b08c125303",
  blueprintId: "mcp-v3-public-release",
  blueprintVersion: 1,
  blueprintSha256: "a".repeat(64),
  targetRelease: "synthetic-beta80",
  sourceCommitSha: "b".repeat(40),
  status: "paused_outcome_unknown",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:01:00.000Z",
  lastSeq: 2,
  steps: [],
  gates: [],
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("Update Control Oracle read client", () => {
  it("uses only the configured HTTPS origin and service authentication headers", async () => {
    const fetcher = jest.fn(async () => response({ runs: [run], nextCursor: null, hasMore: false }));
    const client = new OracleReleaseReadClient(config, fetcher as typeof fetch);
    const result: UpdateListRunsResult = await client.listRuns({ limit: 1 });

    expect(result.runs[0]?.status).toBe("paused_outcome_unknown");
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://oracle-read-api.example.internal/internal/v1/runs?limit=1");
    expect((init as RequestInit).headers).toEqual({
      authorization: `Bearer ${config.bearerToken}`,
      "cf-access-client-id": config.accessClientId,
      "cf-access-client-secret": config.accessClientSecret,
      accept: "application/json",
    });
  });

  it("long-polls the same run/seq cursor and preserves timeout outcome", async () => {
    const expected: UpdateWaitEventsResult = {
      outcome: "timeout",
      runId: run.runId,
      afterSeq: 2,
      events: [],
      currentSeq: 2,
    };
    const fetcher = jest.fn(async () => response(expected));
    const client = new OracleReleaseReadClient(config, fetcher as typeof fetch);
    const result = await client.waitEvents({
      runId: run.runId,
      afterSeq: 2,
      timeoutSeconds: 15,
      limit: 100,
    });

    expect(result).toEqual(expected);
    const [url] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://oracle-read-api.example.internal/internal/v1/runs/${run.runId}/events?afterSeq=2&limit=100&waitMs=15000`,
    );
  });

  it("rejects non-HTTPS, credentialed, path-bearing, or incomplete upstream configuration", () => {
    expect(() => new OracleReleaseReadClient({ ...config, baseUrl: "http://oracle.example" })).toThrow();
    expect(() => new OracleReleaseReadClient({ ...config, baseUrl: "https://user:pass@oracle.example" })).toThrow();
    expect(() => new OracleReleaseReadClient({ ...config, baseUrl: "https://oracle.example/private/" })).toThrow();
    expect(() => new OracleReleaseReadClient({ ...config, accessClientSecret: "" })).toThrow();
  });

  it("fails closed on upstream auth errors, oversized bodies, and malformed snapshot data", async () => {
    const unauthorized = new OracleReleaseReadClient(config, async () => response({ error: "unauthorized" }, 401));
    await expect(unauthorized.listRuns({})).rejects.toMatchObject({ code: "UPDATE_ORCHESTRATOR_UNAVAILABLE" });

    const oversized = new OracleReleaseReadClient(
      { ...config, maxResponseBytes: 32 },
      async () => response({ runs: [run], nextCursor: null, hasMore: false }),
    );
    await expect(oversized.listRuns({})).rejects.toMatchObject({ code: "UPDATE_ORCHESTRATOR_UNAVAILABLE" });

    const malformed = new OracleReleaseReadClient(config, async () =>
      response({ runs: [{ ...run, status: "promote_now" }], nextCursor: null, hasMore: false }),
    );
    await expect(malformed.listRuns({})).rejects.toMatchObject({ code: "UPDATE_ORCHESTRATOR_UNAVAILABLE" });
  });
});
