import { describe, expect, it, jest } from "@jest/globals";
import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol";
import type {
  UpdateControlEvent,
  UpdateControlRunSnapshot,
  UpdateGetRunResult,
  UpdateListRunsResult,
  UpdateWaitEventsResult,
} from "@mcp-access-stack/update-control-contract";
import { UPDATE_CONTROL_TOOL_MANIFEST } from "@mcp-access-stack/update-control-contract";
import { createUpdateControlReadOnlyTools } from "../../src/tools.js";

const RUN_ID = "8e812040-5f0f-4ad6-96fc-1e711b6ded43";
const principal: AuthenticatedEdgePrincipal = {
  subject: "owner:test",
  scopes: ["update:read"],
  ownerScope: "owner",
  userId: "usr_85dd70bf-2a50-4b8e-97d6-3c20c7226757",
};

const run: UpdateControlRunSnapshot = {
  runId: RUN_ID,
  blueprintId: "mcp-v3-public-release",
  blueprintVersion: 1,
  blueprintSha256: "a".repeat(64),
  targetRelease: "synthetic-beta80",
  sourceCommitSha: "b".repeat(40),
  status: "paused_outcome_unknown",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:01:00.000Z",
  lastSeq: 4,
  steps: [],
  gates: [],
};

const event: UpdateControlEvent = {
  runId: RUN_ID,
  seq: 4,
  eventId: "b61cfb16-4ce0-41c3-8eaa-409f20396916",
  eventType: "operation.outcome_unknown",
  payload: { stepId: "publish_release_tag", reasonCode: "ACK_LOST" },
  occurredAt: "2026-10-01T00:01:00.000Z",
  redacted: true,
};

describe("Update Control read-only MCP tools", () => {
  it("publishes exactly three bounded read-only tools", () => {
    expect(UPDATE_CONTROL_TOOL_MANIFEST.map((tool) => tool.name)).toEqual([
      "update_list_runs",
      "update_get_run",
      "update_wait_events",
    ]);
    expect(UPDATE_CONTROL_TOOL_MANIFEST).toHaveLength(3);
    for (const tool of UPDATE_CONTROL_TOOL_MANIFEST) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("maps a list call to the ledger reader with defaults and no mutation surface", async () => {
    const listResult: UpdateListRunsResult = { runs: [run], nextCursor: null, hasMore: false };
    const listRuns = jest.fn(async () => listResult);
    const getRun = jest.fn<(...args: never[]) => Promise<UpdateGetRunResult>>();
    const waitEvents = jest.fn<(...args: never[]) => Promise<UpdateWaitEventsResult>>();
    const localTools = createUpdateControlReadOnlyTools({ listRuns, getRun, waitEvents });

    const response = await localTools.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "update_list_runs", arguments: {} },
    }, principal);
    const body = await response?.json() as { result: { structuredContent: UpdateListRunsResult } };

    expect(body.result.structuredContent.runs[0]?.status).toBe("paused_outcome_unknown");
    expect(listRuns).toHaveBeenCalledWith({ limit: 20 });
    expect(getRun).not.toHaveBeenCalled();
    expect(waitEvents).not.toHaveBeenCalled();
  });

  it("preserves event seq and distinguishes a timeout from new events", async () => {
    const listRuns = jest.fn<(...args: never[]) => Promise<UpdateListRunsResult>>();
    const getRun = jest.fn<(...args: never[]) => Promise<UpdateGetRunResult>>();
    const result: UpdateWaitEventsResult = {
      outcome: "events",
      runId: RUN_ID,
      afterSeq: 3,
      events: [event],
      currentSeq: 4,
      hasMore: false,
    };
    const waitEvents = jest.fn(async () => result);
    const localTools = createUpdateControlReadOnlyTools({ listRuns, getRun, waitEvents });
    const response = await localTools.handle({
      jsonrpc: "2.0",
      id: "wait-1",
      method: "tools/call",
      params: {
        name: "update_wait_events",
        arguments: { runId: RUN_ID, afterSeq: 3, timeoutSeconds: 2 },
      },
    }, principal);
    const body = await response?.json() as { result: { structuredContent: UpdateWaitEventsResult } };

    expect(body.result.structuredContent).toEqual(result);
    expect(waitEvents).toHaveBeenCalledWith({
      runId: RUN_ID,
      afterSeq: 3,
      timeoutSeconds: 2,
      limit: 100,
    });
  });

  it("rejects extra fields and non-owner principals without querying Oracle", async () => {
    const listRuns = jest.fn(async () => ({ runs: [], nextCursor: null, hasMore: false }));
    const getRun = jest.fn<(...args: never[]) => Promise<UpdateGetRunResult>>();
    const waitEvents = jest.fn<(...args: never[]) => Promise<UpdateWaitEventsResult>>();
    const localTools = createUpdateControlReadOnlyTools({ listRuns, getRun, waitEvents });

    const badInput = await localTools.handle({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "update_list_runs", arguments: { shell: "not-allowed" } },
    }, principal);
    const denied = await localTools.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "update_list_runs", arguments: {} },
    }, { ...principal, ownerScope: undefined });

    const badBody = await badInput?.json() as { result: { isError: boolean } };
    const deniedBody = await denied?.json() as { result: { isError: boolean } };
    expect(badBody.result.isError).toBe(true);
    expect(deniedBody.result.isError).toBe(true);
    expect(listRuns).not.toHaveBeenCalled();
  });

  it("rejects unknown tools and malformed ids before calling the read client", async () => {
    const listRuns = jest.fn<(...args: never[]) => Promise<UpdateListRunsResult>>();
    const getRun = jest.fn<(...args: never[]) => Promise<UpdateGetRunResult>>();
    const waitEvents = jest.fn<(...args: never[]) => Promise<UpdateWaitEventsResult>>();
    const localTools = createUpdateControlReadOnlyTools({ listRuns, getRun, waitEvents });
    const unknown = await localTools.handle({
      jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "update_promote", arguments: {} },
    }, principal);
    const invalid = await localTools.handle({
      jsonrpc: "2.0", id: 11, method: "tools/call",
      params: { name: "update_get_run", arguments: { runId: "../etc/passwd" } },
    }, principal);
    expect((await unknown?.json() as { result: { isError: boolean } }).result.isError).toBe(true);
    expect((await invalid?.json() as { result: { isError: boolean } }).result.isError).toBe(true);
    expect(listRuns).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
    expect(waitEvents).not.toHaveBeenCalled();
  });
});
