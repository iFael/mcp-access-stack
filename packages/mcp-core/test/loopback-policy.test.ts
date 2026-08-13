import { describe, expect, it } from "@jest/globals";
import {
  loopbackBasePolicySchema,
  policyFileSchema,
} from "../src/policy.js";

describe("loopbackBasePolicySchema", () => {
  it("accepts an empty workspaces array for loopback-only discovery", () => {
    const parsed = loopbackBasePolicySchema.safeParse({
      version: 1,
      workspaces: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("keeps gateway/cli policyFileSchema requiring at least one workspace", () => {
    const empty = policyFileSchema.safeParse({
      version: 1,
      workspaces: [],
    });
    expect(empty.success).toBe(false);

    const valid = policyFileSchema.safeParse({
      version: 1,
      workspaces: [
        {
          id: "ws",
          name: "Workspace",
          rootPath: "C:/repo",
          enabled: true,
          permissionProfile: "planning-readonly",
          allowedRoots: ["."],
          blockedGlobs: [],
          limits: {
            maxFileBytes: 1000,
            maxSearchResults: 10,
            maxSearchSnippetBytes: 1000,
            maxDiffBytes: 1000,
            maxListedFiles: 10,
          },
          allowWrites: [],
        },
      ],
    });
    expect(valid.success).toBe(true);
  });
});
