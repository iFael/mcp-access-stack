import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { ReleaseOrchestrator } from "../../src/engine/release-orchestrator.js";
import { createOracleReleaseReadApi } from "../../src/read-api.js";
import { SqliteReleaseLedger } from "../../src/storage/sqlite-release-ledger.js";

const TOKEN = "x".repeat(48);
const ACTOR = "test:update-control";

describe("Oracle Release Orchestrator read API", () => {
  let root: string;
  let orchestrator: ReleaseOrchestrator;
  let handle: ReturnType<typeof createOracleReleaseReadApi>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mcp-v3-orchestrator-read-api-"));
    const releaseRoot = path.join(root, "release-tree");
    mkdirSync(releaseRoot, { recursive: true });
    const ledger = SqliteReleaseLedger.open({
      databasePath: path.join(root, "state", "orchestrator.sqlite"),
      releaseRoot,
    });
    orchestrator = new ReleaseOrchestrator(ledger);
    handle = createOracleReleaseReadApi({ orchestrator, bearerToken: TOKEN, maxConcurrentWaits: 2 });
  });

  afterEach(() => {
    orchestrator.close();
    rmSync(root, { recursive: true, force: true });
  });

  function request(pathname: string, token: string | null = TOKEN): Request {
    return new Request(`http://127.0.0.1${pathname}`, {
      method: "GET",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  function createRun(key: string, release: string) {
    return orchestrator.createRun({
      blueprintId: "mcp-v3-public-release",
      blueprintVersion: 1,
      targetRelease: release,
      sourceCommitSha: "0".repeat(40),
      idempotencyKey: key,
      actorId: ACTOR,
    }).run;
  }

  it("requires the internal bearer and never exposes a write route", async () => {
    const run = createRun("read-api-auth", "synthetic-auth");
    const beforeSeq = run.lastSeq;

    const unauthenticated = await handle(request("/internal/v1/runs", null));
    const invalid = await handle(request("/internal/v1/runs", "wrong-secret"));
    const mutation = await handle(new Request("http://127.0.0.1/internal/v1/runs", { method: "POST" }));

    expect(unauthenticated.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(mutation.status).toBe(405);
    expect(orchestrator.getRun(run.runId).lastSeq).toBe(beforeSeq);
  });

  it("lists runs with bounded stable pagination and returns safe snapshot projections", async () => {
    const first = createRun("read-api-list-1", "synthetic-list-1");
    const second = createRun("read-api-list-2", "synthetic-list-2");

    const pageOneResponse = await handle(request("/internal/v1/runs?limit=1"));
    const pageOne = await pageOneResponse.json() as {
      runs: Array<{ runId: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };

    expect(pageOneResponse.status).toBe(200);
    expect(pageOne.runs).toHaveLength(1);
    expect(pageOne.hasMore).toBe(true);
    expect(pageOne.nextCursor).toEqual(expect.any(String));

    const pageTwoResponse = await handle(request(
      `/internal/v1/runs?limit=1&cursor=${encodeURIComponent(pageOne.nextCursor ?? "")}`,
    ));
    const pageTwo = await pageTwoResponse.json() as { runs: Array<{ runId: string }>; hasMore: boolean };
    expect(pageTwo.runs).toHaveLength(1);
    expect(pageTwo.runs[0]?.runId).not.toBe(pageOne.runs[0]?.runId);
    expect(new Set([pageOne.runs[0]?.runId, pageTwo.runs[0]?.runId])).toEqual(
      new Set([first.runId, second.runId]),
    );

    const snapshotResponse = await handle(request(`/internal/v1/runs/${first.runId}`));
    const snapshot = await snapshotResponse.json() as { run: { runId: string; steps: Array<Record<string, unknown>> } };
    expect(snapshot.run.runId).toBe(first.runId);
    expect(snapshot.run.steps[0]).not.toHaveProperty("idempotencyKey");
    expect(snapshot.run.steps[0]).not.toHaveProperty("operationId");
  });

  it("replays immediately after afterSeq and reports a bounded no-event timeout distinctly", async () => {
    const run = createRun("read-api-events", "synthetic-events");
    orchestrator.startRun(run.runId, ACTOR);

    const immediate = await handle(request(
      `/internal/v1/runs/${run.runId}/events?afterSeq=1&limit=10&waitMs=0`,
    ));
    const immediateBody = await immediate.json() as {
      outcome: string;
      events: Array<{ seq: number; eventType: string }>;
      currentSeq: number;
    };
    expect(immediateBody.outcome).toBe("events");
    expect(immediateBody.events.map((event) => event.seq)).toEqual([2]);
    expect(immediateBody.events[0]?.eventType).toBe("run.started");
    expect(immediateBody.currentSeq).toBe(2);

    const timeout = await handle(request(
      `/internal/v1/runs/${run.runId}/events?afterSeq=2&limit=10&waitMs=10`,
    ));
    const timeoutBody = await timeout.json() as { outcome: string; events: unknown[]; currentSeq: number };
    expect(timeoutBody).toEqual({ outcome: "timeout", runId: run.runId, afterSeq: 2, events: [], currentSeq: 2 });

    const immediateTimeout = await handle(request(
      `/internal/v1/runs/${run.runId}/events?afterSeq=2&limit=10&waitMs=0`,
    ));
    expect(await immediateTimeout.json()).toEqual({
      outcome: "timeout",
      runId: run.runId,
      afterSeq: 2,
      events: [],
      currentSeq: 2,
    });
  });

  it("wakes a waiting reader on the next persisted seq without reordering events", async () => {
    const run = createRun("read-api-wake", "synthetic-wake");
    orchestrator.startRun(run.runId, ACTOR);

    const waiting = handle(request(
      `/internal/v1/runs/${run.runId}/events?afterSeq=2&limit=10&waitMs=500`,
    ));
    setTimeout(() => {
      orchestrator.beginStepAttempt(
        run.runId,
        "resolve_main_commit",
        "read-api-wake-operation",
        ACTOR,
      );
    }, 20);

    const response = await waiting;
    const body = await response.json() as {
      outcome: string;
      events: Array<{ seq: number; eventType: string }>;
      currentSeq: number;
    };
    expect(body.outcome).toBe("events");
    expect(body.events.map((event) => event.seq)).toEqual([3]);
    expect(body.events[0]?.eventType).toBe("step.intent_recorded");
    expect(body.currentSeq).toBe(3);
  });

  it("rejects unknown and duplicate query parameters on every read route", async () => {
    const run = createRun("read-api-strict-query", "synthetic-strict-query");
    const unknownListQuery = await handle(request("/internal/v1/runs?unexpected=1"));
    const duplicateListQuery = await handle(request("/internal/v1/runs?limit=1&limit=2"));
    const unknownSnapshotQuery = await handle(request(
      `/internal/v1/runs/${run.runId}?unexpected=1`,
    ));
    const duplicateWaitQuery = await handle(request(
      `/internal/v1/runs/${run.runId}/events?afterSeq=0&afterSeq=1`,
    ));
    expect(unknownListQuery.status).toBe(400);
    expect(duplicateListQuery.status).toBe(400);
    expect(unknownSnapshotQuery.status).toBe(400);
    expect(duplicateWaitQuery.status).toBe(400);
  });

  it("rejects invalid identifiers, cursors, event limits, and waits above the hard bound", async () => {
    const invalidRun = await handle(request("/internal/v1/runs/not-a-uuid"));
    const invalidSeq = await handle(request("/internal/v1/runs/00000000-0000-4000-8000-000000000000/events?afterSeq=-1"));
    const invalidLimit = await handle(request("/internal/v1/runs?limit=10001"));
    const invalidWait = await handle(request("/internal/v1/runs/00000000-0000-4000-8000-000000000000/events?afterSeq=0&waitMs=16000"));
    expect(invalidRun.status).toBe(400);
    expect(invalidSeq.status).toBe(400);
    expect(invalidLimit.status).toBe(400);
    expect(invalidWait.status).toBe(400);
  });
});
