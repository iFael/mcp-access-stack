import { describe, expect, it } from "@jest/globals";
import type { WorkspacePolicy } from "../src/policy.js";
import {
  isAutoWriteEligible,
  isUnderConfiguredRoot,
  withAutoWriteAccess,
} from "../src/project-write-policy.js";

const baseWorkspace: WorkspacePolicy = {
  id: "demo",
  name: "Demo",
  rootPath: "C:/Users/me/Desktop/development/LegacySite",
  enabled: true,
  permissionProfile: "planning-readonly",
  confirmationMode: "standard",
  allowedRoots: ["."],
  blockedGlobs: [],
  limits: {
    maxFileBytes: 1_000,
    maxSearchResults: 10,
    maxSearchSnippetBytes: 100,
    maxDiffBytes: 1_000,
    maxListedFiles: 10,
  },
  allowWrites: [],
  allowShell: [],
  allowedShells: ["powershell"],
};

describe("auto write policy", () => {
  it("detects folders under configured roots", () => {
    const developmentRoot = "C:/Users/me/Desktop/development";
    expect(isUnderConfiguredRoot(developmentRoot, developmentRoot)).toBe(true);
    expect(isUnderConfiguredRoot(`${developmentRoot}/LegacySite`, developmentRoot)).toBe(true);
    expect(isUnderConfiguredRoot("C:/Users/me/Desktop/Project", developmentRoot)).toBe(false);
  });

  it("upgrades workspaces under the development root", () => {
    const upgraded = withAutoWriteAccess(baseWorkspace, baseWorkspace.rootPath, {
      enableDevelopmentWrites: true,
      developmentRootPath: "C:/Users/me/Desktop/development",
    });

    expect(upgraded.permissionProfile).toBe("full-repo-write");
    expect(upgraded.allowWrites).toEqual(["."]);
    expect(upgraded.allowedShells).toEqual(["powershell", "pwsh", "cmd", "wsl", "git-bash"]);
  });

  it("upgrades workspaces under the project root", () => {
    const projectWorkspace = {
      ...baseWorkspace,
      rootPath: "C:/Users/me/Desktop/Project/MCP VS CODE - GPT",
    };
    const upgraded = withAutoWriteAccess(projectWorkspace, projectWorkspace.rootPath, {
      enableProjectWrites: true,
      projectRootPath: "C:/Users/me/Desktop/Project",
    });

    expect(upgraded.permissionProfile).toBe("full-repo-write");
    expect(upgraded.allowWrites).toEqual(["."]);
    expect(upgraded.allowedShells).toEqual(["powershell", "pwsh", "cmd", "wsl", "git-bash"]);
    expect(upgraded.workspaceKind).toBeUndefined();
  });

  it("marks only the configured project root itself as aggregate", () => {
    const projectRootWorkspace = {
      ...baseWorkspace,
      rootPath: "C:/Users/me/Desktop/Project",
    };
    const upgraded = withAutoWriteAccess(projectRootWorkspace, projectRootWorkspace.rootPath, {
      enableProjectWrites: true,
      projectRootPath: "C:/Users/me/Desktop/Project",
    });

    expect(upgraded.workspaceKind).toBe("aggregate");
    expect(upgraded.permissionProfile).toBe("full-repo-write");
  });
  it("keeps readonly workspaces outside configured roots", () => {
    const unchanged = withAutoWriteAccess(baseWorkspace, baseWorkspace.rootPath, {
      enableProjectWrites: true,
      projectRootPath: "C:/Users/me/Desktop/Other",
      enableDevelopmentWrites: true,
      developmentRootPath: "C:/Users/me/Desktop/Other",
    });

    expect(unchanged.permissionProfile).toBe("planning-readonly");
    expect(unchanged.allowWrites).toEqual([]);
    expect(unchanged.allowedShells).toEqual(["powershell"]);
  });

  it("treats either root as eligible for auto writes", () => {
    expect(
      isAutoWriteEligible("C:/Users/me/Desktop/development/LegacySite", {
        enableDevelopmentWrites: true,
        developmentRootPath: "C:/Users/me/Desktop/development",
      }),
    ).toBe(true);
    expect(
      isAutoWriteEligible("C:/Users/me/Desktop/Project/demo", {
        enableProjectWrites: true,
        projectRootPath: "C:/Users/me/Desktop/Project",
      }),
    ).toBe(true);
  });
});
