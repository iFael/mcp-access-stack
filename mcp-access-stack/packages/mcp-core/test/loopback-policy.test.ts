import { describe, expect, it } from "@jest/globals";
import {
  loopbackBasePolicySchema,
  policyFileSchema,
  workspacePolicySchema,
} from "../src/policy.js";

const limits = {
  maxFileBytes: 1000,
  maxSearchResults: 10,
  maxSearchSnippetBytes: 1000,
  maxDiffBytes: 1000,
  maxListedFiles: 10,
};

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
          limits,
          allowWrites: [],
        },
      ],
    });
    expect(valid.success).toBe(true);
  });

  it("defaults legacy workspace policies to standard confirmation mode", () => {
    const parsed = workspacePolicySchema.parse({
      id: "legacy",
      name: "Legacy",
      rootPath: "C:/repo",
      enabled: true,
      permissionProfile: "full-repo-write",
      allowedRoots: ["."],
      blockedGlobs: [],
      limits,
      allowWrites: ["."],
      allowShell: ["."],
      allowedShells: ["powershell"],
    });
    expect(parsed.confirmationMode).toBe("standard");
  });

  it("accepts trusted-workspace only with full-repo-write", () => {
    const trusted = workspacePolicySchema.safeParse({
      id: "trusted",
      name: "Trusted",
      rootPath: "C:/repo",
      enabled: true,
      permissionProfile: "full-repo-write",
      confirmationMode: "trusted-workspace",
      allowedRoots: ["."],
      blockedGlobs: [],
      limits,
      allowWrites: ["."],
      allowShell: ["."],
      allowedShells: ["powershell"],
    });
    expect(trusted.success).toBe(true);

    const readonly = workspacePolicySchema.safeParse({
      id: "readonly",
      name: "Readonly",
      rootPath: "C:/repo",
      enabled: true,
      permissionProfile: "full-repo-readonly",
      confirmationMode: "trusted-workspace",
      allowedRoots: ["."],
      blockedGlobs: [],
      limits,
      allowWrites: [],
      allowShell: [],
      allowedShells: ["powershell"],
    });
    expect(readonly.success).toBe(false);
  });
});
