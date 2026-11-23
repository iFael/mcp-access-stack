import { describe, expect, it } from "@jest/globals";
import { getWorkspaceContextResultSchema } from "../src/contracts.js";

describe("workspace operational briefing contract", () => {
  const base = {
    workspaceId: "mcp-access-stack",
    rootPath: ".",
    instructionFiles: [],
    availableInstructionFiles: [],
    skills: [],
    git: { isGitRepository: true },
  };

  it("preserves existing responses and exposes a bounded optional briefing", () => {
    expect(getWorkspaceContextResultSchema.parse(base).operationalBriefing).toBeUndefined();
    expect(getWorkspaceContextResultSchema.parse({
      ...base,
      operationalBriefing: "MCP V3 AUTOMATIC OPERATIONAL BRIEFING",
    }).operationalBriefing).toContain("OPERATIONAL BRIEFING");
    expect(() => getWorkspaceContextResultSchema.parse({
      ...base,
      operationalBriefing: "x".repeat(10_001),
    })).toThrow();
  });
});
