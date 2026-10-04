import { describe, expect, it, jest } from "@jest/globals";
import type { UpdateControlRunSnapshot, UpdateListRunsResult } from "@mcp-access-stack/update-control-contract";
import { ORACLE_CHANNEL_RPC_PATH, ORACLE_CHANNEL_SCOPE } from "../../src/oracle-channel.js";
import { UpdateControlOracleChannelReadClient } from "../../src/oracle-channel-client.js";

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
const listResult: UpdateListRunsResult = { runs: [run], nextCursor: null, hasMore: false };

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function createNamespace(fetcher: (request: Request) => Promise<Response>) {
  const idFromName = jest.fn((name: string) => name);
  const fetch = jest.fn(fetcher);
  const namespace = {
    idFromName,
    get: jest.fn((id: unknown) => ({ fetch, id })),
  };
  return { namespace, idFromName, fetch };
}

describe("Update Control Oracle WSS RPC read client", () => {
  it("uses one fixed DO scope and sends only typed read arguments over the internal binding", async () => {
    const h = createNamespace(async () => response({ result: listResult }));
    const client = new UpdateControlOracleChannelReadClient(h.namespace);
    const result = await client.listRuns({ limit: 1, cursor: "next_page" });

    expect(result).toEqual(listResult);
    expect(h.idFromName).toHaveBeenCalledWith(ORACLE_CHANNEL_SCOPE);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const request = h.fetch.mock.calls[0]?.[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://update-control-channel.internal" + ORACLE_CHANNEL_RPC_PATH);
    expect(request?.headers.get("authorization")).toBeNull();
    expect(request?.headers.get("cf-access-client-secret")).toBeNull();
    expect(await request?.json()).toEqual({
      method: "list_runs",
      arguments: { limit: 1, cursor: "next_page" },
    });
  });

  it("maps not-found and disconnected/timeout transport errors without conflating wait timeout", async () => {
    const notFound = new UpdateControlOracleChannelReadClient(
      createNamespace(async () => response({ error: "RUN_NOT_FOUND" }, 404)).namespace,
    );
    await expect(notFound.getRun({
      runId: run.runId,
      evidenceLimit: 5,
    })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });

    const wrong404 = new UpdateControlOracleChannelReadClient(
      createNamespace(async () => response({ error: "not_found" }, 404)).namespace,
    );
    await expect(wrong404.getRun({
      runId: run.runId,
      evidenceLimit: 5,
    })).rejects.toMatchObject({ code: "UPDATE_ORCHESTRATOR_UNAVAILABLE" });

    const unavailable = new UpdateControlOracleChannelReadClient(
      createNamespace(async () => response({ error: "transport_timeout" }, 504)).namespace,
    );
    await expect(unavailable.waitEvents({
      runId: run.runId,
      afterSeq: 2,
      timeoutSeconds: 15,
      limit: 100,
    })).rejects.toMatchObject({ code: "UPDATE_ORCHESTRATOR_UNAVAILABLE" });

    const normalTimeout = {
      outcome: "timeout",
      runId: run.runId,
      afterSeq: 2,
      currentSeq: 2,
      events: [],
    };
    const timeoutClient = new UpdateControlOracleChannelReadClient(
      createNamespace(async () => response({ result: normalTimeout })).namespace,
    );
    await expect(timeoutClient.waitEvents({
      runId: run.runId,
      afterSeq: 2,
      timeoutSeconds: 15,
      limit: 100,
    })).resolves.toEqual(normalTimeout);
  });

  it("rejects malformed, oversized, unordered, and out-of-cursor results fail-closed", async () => {
    const malformed = new UpdateControlOracleChannelReadClient(
      createNamespace(async () => response({ result: { runs: [{ ...run, status: "promote_now" }], nextCursor: null, hasMore: false } })).namespace,
    );
    await expect(malformed.listRuns({ limit: 1 })).rejects.toMatchObject({
      code: "UPDATE_ORCHESTRATOR_UNAVAILABLE",
    });

    const wrongCursor = new UpdateControlOracleChannelReadClient(
      createNamespace(async () => response({
        result: {
          outcome: "events",
          runId: run.runId,
          afterSeq: 1,
          currentSeq: 2,
          events: [{
            eventId: "9c7b7c3c-c955-4d3b-bba9-6ea7ca320000",
            runId: run.runId,
            seq: 2,
            eventType: "run.started",
            payload: {},
            occurredAt: "2026-10-01T00:01:00.000Z",
            redacted: true,
          }],
        },
      })).namespace,
    );
    await expect(wrongCursor.waitEvents({
      runId: run.runId,
      afterSeq: 2,
      timeoutSeconds: 1,
      limit: 10,
    })).rejects.toMatchObject({ code: "UPDATE_ORCHESTRATOR_UNAVAILABLE" });

    const malformedHasMore = new UpdateControlOracleChannelReadClient(
      createNamespace(async () => response({ result: {
        outcome: "timeout",
        runId: run.runId,
        afterSeq: 2,
        currentSeq: 2,
        events: [],
        hasMore: "yes",
      } })).namespace,
    );
    await expect(malformedHasMore.waitEvents({
      runId: run.runId,
      afterSeq: 2,
      timeoutSeconds: 1,
      limit: 10,
    })).rejects.toMatchObject({ code: "UPDATE_ORCHESTRATOR_UNAVAILABLE" });

    const oversized = new UpdateControlOracleChannelReadClient(
      createNamespace(async () => new Response("x".repeat(512 * 1024 + 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      })).namespace,
    );
    await expect(oversized.listRuns({ limit: 1 })).rejects.toMatchObject({
      code: "UPDATE_ORCHESTRATOR_UNAVAILABLE",
    });
  });

  it("does not retry, call a public URL, or add an authentication header", async () => {
    const h = createNamespace(async () => response({ result: listResult }));
    const client = new UpdateControlOracleChannelReadClient(h.namespace);
    await client.listRuns({});
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});
