import { describe, expect, it, jest } from "@jest/globals";
import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol";
import type {
  UpdateControlRunSnapshot,
  UpdateGetRunResult,
  UpdateListRunsResult,
  UpdateWaitEventsResult,
} from "@mcp-access-stack/update-control-contract";
import { createUpdateControlApiHandler } from "../../src/api.js";

const runId = "e21d1315-37dc-4f10-850e-16ed9da8b281";
const principal: AuthenticatedEdgePrincipal = {
  subject: "owner:test",
  scopes: ["update:read"],
  ownerScope: "owner",
  userId: "usr_update_control_owner",
};
const run: UpdateControlRunSnapshot = {
  runId,
  blueprintId: "mcp-v3-public-release",
  blueprintVersion: 1,
  blueprintSha256: "a".repeat(64),
  targetRelease: "synthetic-beta80",
  sourceCommitSha: "b".repeat(40),
  status: "running",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:01:00.000Z",
  lastSeq: 3,
  steps: [],
  gates: [],
};
const listResult: UpdateListRunsResult = { runs: [run], nextCursor: null, hasMore: false };
const getResult: UpdateGetRunResult = { run, evidence: [], nextEvidenceCursor: null, hasMoreEvidence: false };
const waitResult: UpdateWaitEventsResult = {
  outcome: "timeout",
  runId,
  afterSeq: 3,
  events: [],
  currentSeq: 3,
};

function request(pathname: string): Request {
  return new Request(`https://update-control.example${pathname}`, {
    headers: { authorization: "Bearer signed-owner-token" },
  });
}

describe("Update Control shared read API", () => {
  it("serves list, snapshot and bounded wait from the same typed reader", async () => {
    const listRuns = jest.fn(async () => listResult);
    const getRun = jest.fn(async () => getResult);
    const waitEvents = jest.fn(async () => waitResult);
    const handle = createUpdateControlApiHandler({
      authenticate: async () => principal,
      client: { listRuns, getRun, waitEvents },
    });

    const listResponse = await handle(request("/api/v1/runs?limit=1"));
    const snapshotResponse = await handle(request(`/api/v1/runs/${runId}?evidenceLimit=50`));
    const waitResponse = await handle(request(
      `/api/v1/runs/${runId}/events?afterSeq=3&timeoutSeconds=2&limit=40`,
    ));

    expect(await listResponse.json()).toEqual(listResult);
    expect(await snapshotResponse.json()).toEqual(getResult);
    expect(await waitResponse.json()).toEqual(waitResult);
    expect(waitEvents).toHaveBeenCalledWith({
      runId,
      afterSeq: 3,
      timeoutSeconds: 2,
      limit: 40,
    });
  });

  it("authenticates every route and rejects unsupported methods, paths, and query bounds", async () => {
    const authenticate = jest.fn(async () => principal);
    const listRuns = jest.fn(async () => listResult);
    const getRun = jest.fn(async () => getResult);
    const waitEvents = jest.fn(async () => waitResult);
    const handle = createUpdateControlApiHandler({
      authenticate,
      client: { listRuns, getRun, waitEvents },
    });

    const unknown = await handle(request("/api/v1/mutate"));
    const invalid = await handle(request("/api/v1/runs/not-a-uuid"));
    const invalidWait = await handle(request(`/api/v1/runs/${runId}/events?afterSeq=-1`));
    const post = await handle(new Request("https://update-control.example/api/v1/runs", {
      method: "POST",
      headers: { authorization: "Bearer signed-owner-token" },
    }));

    expect(unknown.status).toBe(404);
    expect(invalid.status).toBe(400);
    expect(invalidWait.status).toBe(400);
    expect(post.status).toBe(405);
    expect(listRuns).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
    expect(waitEvents).not.toHaveBeenCalled();
    expect(authenticate).toHaveBeenCalledTimes(3);
  });

  it("fails closed for an authenticated principal without the read scope", async () => {
    const getRun = jest.fn(async () => getResult);
    const handle = createUpdateControlApiHandler({
      authenticate: async () => ({ ...principal, scopes: ["workspaces:read"] }),
      client: {
        listRuns: async () => listResult,
        getRun,
        waitEvents: async () => waitResult,
      },
    });
    const response = await handle(request(`/api/v1/runs/${runId}`));
    expect(response.status).toBe(403);
    expect(getRun).not.toHaveBeenCalled();
  });
});
