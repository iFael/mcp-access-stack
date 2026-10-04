import { describe, expect, it } from "@jest/globals";
import {
  UPDATE_CONTROL_CATALOG_METADATA,
  UPDATE_CONTROL_TOOL_MANIFEST,
  UpdateControlInputError,
  parseUpdateGetRunArguments,
  parseUpdateListRunsArguments,
  parseUpdateWaitEventsArguments,
} from "@mcp-access-stack/update-control-contract";

describe("Update Control public contract", () => {
  it("keeps a separate three-tool catalog with safe annotations and closed schemas", () => {
    expect(UPDATE_CONTROL_CATALOG_METADATA.toolCount).toBe(3);
    expect(UPDATE_CONTROL_TOOL_MANIFEST.map(({ name }) => name)).toEqual([
      "update_list_runs",
      "update_get_run",
      "update_wait_events",
    ]);
    for (const tool of UPDATE_CONTROL_TOOL_MANIFEST) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
    expect(UPDATE_CONTROL_TOOL_MANIFEST[0]?.inputSchema.properties).toMatchObject({
      limit: { type: "integer", minimum: 1, maximum: 25 },
      cursor: { type: "string", maxLength: 512 },
    });
    expect(UPDATE_CONTROL_TOOL_MANIFEST[1]?.inputSchema.required).toEqual(["runId"]);
    expect(UPDATE_CONTROL_TOOL_MANIFEST[2]?.inputSchema).toMatchObject({
      required: ["runId", "afterSeq"],
      properties: {
        afterSeq: { type: "integer", minimum: 0 },
        timeoutSeconds: { type: "integer", minimum: 0, maximum: 15 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    });
  });

  it("rejects unbounded and unknown arguments at the shared parser boundary", () => {
    expect(() => parseUpdateListRunsArguments({ limit: 26 })).toThrow(UpdateControlInputError);
    expect(() => parseUpdateListRunsArguments({ limit: 1, shell: "pwsh" })).toThrow(UpdateControlInputError);
    expect(() => parseUpdateGetRunArguments({ runId: "../state.sqlite" })).toThrow(UpdateControlInputError);
    expect(() => parseUpdateWaitEventsArguments({
      runId: "8e812040-5f0f-4ad6-96fc-1e711b6ded43",
      afterSeq: -1,
    })).toThrow(UpdateControlInputError);
    expect(() => parseUpdateWaitEventsArguments({
      runId: "8e812040-5f0f-4ad6-96fc-1e711b6ded43",
      afterSeq: 0,
      timeoutSeconds: 16,
    })).toThrow(UpdateControlInputError);
  });

  it("normalizes bounded defaults without adding lifecycle capabilities", () => {
    expect(parseUpdateListRunsArguments({})).toEqual({ limit: 20 });
    expect(parseUpdateGetRunArguments({
      runId: "8e812040-5f0f-4ad6-96fc-1e711b6ded43",
    })).toEqual({ runId: "8e812040-5f0f-4ad6-96fc-1e711b6ded43", evidenceLimit: 50 });
    expect(parseUpdateWaitEventsArguments({
      runId: "8e812040-5f0f-4ad6-96fc-1e711b6ded43",
      afterSeq: 12,
    })).toEqual({
      runId: "8e812040-5f0f-4ad6-96fc-1e711b6ded43",
      afterSeq: 12,
      timeoutSeconds: 10,
      limit: 100,
    });
  });
});
