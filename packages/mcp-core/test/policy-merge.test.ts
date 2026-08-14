import { describe, expect, it } from "@jest/globals";
import {
  canonicalPathKey,
  clampDiscoveredLimits,
  DISCOVERED_WORKSPACE_LIMIT_CEILINGS,
  mergeWorkspacePolicies,
  normalizePathKey,
  type DiscoveredWorkspaceCandidate,
  type ExplicitPolicyInput,
  type MergePolicyBase,
} from "../src/policy-merge.js";
import { workspacePolicySchema, type WorkspacePolicyInput } from "../src/policy.js";

const explicitLimits = {
  maxFileBytes: 10_000,
  maxSearchResults: 20,
  maxSearchSnippetBytes: 5_000,
  maxDiffBytes: 50_000,
  maxListedFiles: 50,
};

function entry(
  workspace: WorkspacePolicyInput,
  canonicalRootPath?: string,
): ExplicitPolicyInput {
  const parsed = workspacePolicySchema.parse(workspace);
  return {
    workspace: parsed,
    canonicalRootPath: canonicalRootPath ?? parsed.rootPath,
  };
}

function mergeBase(entries: ExplicitPolicyInput[]): MergePolicyBase {
  return { version: 1, entries };
}

describe("policy-merge", () => {
  it("normalizes Windows paths case-insensitively", () => {
    expect(normalizePathKey("C:\\Repo\\Project")).toBe(
      normalizePathKey("c:/repo/project"),
    );
    expect(canonicalPathKey("C:\\Repo\\Project")).toBe(
      canonicalPathKey("c:/repo/project"),
    );
  });

  it("discovers open trusted folders without editing JSON", () => {
    const result = mergeWorkspacePolicies(mergeBase([]), [
      {
        name: "My Project",
        rootPath: "C:/projects/my-project",
        canonicalRootPath: "C:/projects/my-project",
        trusted: true,
      },
    ]);

    expect(result.policy.workspaces).toHaveLength(1);
    expect(result.policy.workspaces[0]?.permissionProfile).toBe("planning-readonly");
    expect(result.catalog[0]?.source).toBe("discovered");
  });

  it("does not promote implicit technical directories into the main workspace catalog", () => {
    const candidates = [
      ".github",
      ".vscode",
      "node_modules",
      "tests",
      "docker",
      "Real Project",
    ].map((name) => ({
      name,
      rootPath: `C:/projects/${name}`,
      canonicalRootPath: `C:/projects/${name}`,
      trusted: true,
    } satisfies DiscoveredWorkspaceCandidate));

    const result = mergeWorkspacePolicies(mergeBase([]), candidates);

    expect(result.policy.workspaces).toHaveLength(1);
    expect(result.policy.workspaces[0]?.name).toBe("Real Project");
    expect(result.catalog).toHaveLength(1);
    expect(result.catalog[0]).toMatchObject({
      source: "discovered",
      name: "Real Project",
    });
  });

  it("preserves a technical-looking workspace when it is explicitly configured", () => {
    const dockerPath = "C:/projects/docker";
    const result = mergeWorkspacePolicies(
      mergeBase([
        entry({
          id: "docker-explicit",
          name: "docker",
          rootPath: dockerPath,
          enabled: true,
          permissionProfile: "full-repo-readonly",
          allowedRoots: ["."],
          blockedGlobs: [],
          limits: explicitLimits,
          allowWrites: [],
          allowShell: [],
          allowedShells: ["powershell"],
        }),
      ]),
      [
        {
          name: "docker",
          rootPath: dockerPath,
          canonicalRootPath: dockerPath,
          trusted: true,
        },
      ],
    );

    expect(result.policy.workspaces).toHaveLength(1);
    expect(result.policy.workspaces[0]).toMatchObject({
      id: "docker-explicit",
      name: "docker",
    });
    expect(result.catalog[0]).toMatchObject({
      source: "explicit",
      id: "docker-explicit",
    });
  });

  it("blocks discovery when explicit deny matches canonical realpath", () => {
    expect(() =>
      mergeWorkspacePolicies(
        mergeBase([
          entry(
            {
              id: "blocked",
              name: "Blocked",
              rootPath: "C:/projects/SECRET",
              enabled: false,
              permissionProfile: "planning-readonly",
              allowedRoots: ["."],
              blockedGlobs: [],
              limits: explicitLimits,
              allowWrites: [],
              allowShell: [],
              allowedShells: ["powershell"],
            },
            "C:/projects/secret",
          ),
        ]),
        [
          {
            name: "Secret",
            rootPath: "c:/projects/secret",
            canonicalRootPath: "C:/projects/secret",
            trusted: true,
          },
        ],
        { alwaysExposeExplicit: false },
      ),
    ).toThrow(/MERGE_EMPTY_POLICY/);

    const withDenyOnly = mergeWorkspacePolicies(
      mergeBase([
        entry(
          {
            id: "blocked",
            name: "Blocked",
            rootPath: "C:/projects/secret",
            enabled: false,
            permissionProfile: "planning-readonly",
            allowedRoots: ["."],
            blockedGlobs: [],
            limits: explicitLimits,
            allowWrites: [],
            allowShell: [],
            allowedShells: ["powershell"],
          },
          "C:/projects/secret",
        ),
        entry({
          id: "open",
          name: "Open",
          rootPath: "C:/projects/open",
          enabled: true,
          permissionProfile: "builder-review",
          allowedRoots: ["."],
          blockedGlobs: [],
          limits: explicitLimits,
          allowWrites: [],
          allowShell: [],
          allowedShells: ["powershell"],
        }),
      ]),
      [
        {
          name: "Secret",
          rootPath: "C:/projects/secret",
          canonicalRootPath: "C:/projects/secret",
          trusted: true,
        },
        {
          name: "Open",
          rootPath: "C:/projects/open",
          canonicalRootPath: "C:/projects/open",
          trusted: true,
        },
      ],
    );

    expect(withDenyOnly.policy.workspaces).toHaveLength(1);
    expect(withDenyOnly.policy.workspaces[0]?.id).toBe("open");
    expect(withDenyOnly.catalog.some((item) => item.source === "deny-index")).toBe(true);
  });

  it("clamps discovered limits to hard-coded ceilings", () => {
    const limits = clampDiscoveredLimits({
      maxFileBytes: 999_999,
      maxSearchResults: 5,
    });

    expect(limits.maxFileBytes).toBe(DISCOVERED_WORKSPACE_LIMIT_CEILINGS.maxFileBytes);
    expect(limits.maxSearchResults).toBe(5);
  });

  it("skips untrusted discovered folders when required", () => {
    expect(() =>
      mergeWorkspacePolicies(
        mergeBase([]),
        [
          {
            name: "Untrusted",
            rootPath: "C:/untrusted",
            canonicalRootPath: "C:/untrusted",
            trusted: false,
          } satisfies DiscoveredWorkspaceCandidate,
        ],
        { requireTrustedWorkspace: true },
      ),
    ).toThrow(/MERGE_EMPTY_POLICY/);
  });

  it("enables development writes for folders under developmentRootPath", () => {
    const developmentRoot = "C:/Users/me/Desktop/development";
    const result = mergeWorkspacePolicies(
      mergeBase([]),
      [
        {
          name: "LegacySite",
          rootPath: `${developmentRoot}/LegacySite`,
          canonicalRootPath: `${developmentRoot}/LegacySite`,
          trusted: true,
        },
      ],
      {
        enableDevelopmentWrites: true,
        developmentRootPath: developmentRoot,
      },
    );

    expect(result.policy.workspaces[0]?.permissionProfile).toBe("full-repo-write");
    expect(result.policy.workspaces[0]?.allowWrites).toEqual(["."]);
    expect(result.policy.workspaces[0]?.allowedShells).toEqual(["powershell", "pwsh", "cmd", "wsl", "git-bash"]);
  });

  it("enables project writes for folders under projectRootPath", () => {
    const projectRoot = "C:/Users/me/Desktop/Project";
    const result = mergeWorkspacePolicies(
      mergeBase([]),
      [
        {
          name: "MCP VS CODE - GPT",
          rootPath: `${projectRoot}/MCP VS CODE - GPT`,
          canonicalRootPath: `${projectRoot}/MCP VS CODE - GPT`,
          trusted: true,
        },
        {
          name: "Outside",
          rootPath: "C:/Users/me/Desktop/Other",
          canonicalRootPath: "C:/Users/me/Desktop/Other",
          trusted: true,
        },
      ],
      {
        enableProjectWrites: true,
        projectRootPath: projectRoot,
      },
    );

    const inside = result.policy.workspaces.find((workspace) =>
      workspace.rootPath.includes("MCP VS CODE - GPT"),
    );
    const outside = result.policy.workspaces.find((workspace) => workspace.name === "Outside");

    expect(inside?.permissionProfile).toBe("full-repo-write");
    expect(inside?.allowWrites).toEqual(["."]);
    expect(inside?.allowedShells).toEqual(["powershell", "pwsh", "cmd", "wsl", "git-bash"]);
    expect(outside?.permissionProfile).toBe("planning-readonly");
    expect(outside?.allowWrites).toEqual([]);
  });

  it("upgrades explicit readonly workspaces under project when discovered remotely", () => {
    const projectRoot = "C:/Users/me/Desktop/Project";
    const childPath = `${projectRoot}/MCP VS CODE - GPT`;
    const result = mergeWorkspacePolicies(
      mergeBase([
        entry({
          id: "vs-code-gpt",
          name: "MCP VS CODE - GPT",
          rootPath: childPath,
          enabled: true,
          permissionProfile: "full-repo-readonly",
          allowedRoots: ["."],
          blockedGlobs: [],
          limits: explicitLimits,
          allowWrites: [],
          allowShell: [],
          allowedShells: ["powershell"],
        }),
      ]),
      [
        {
          name: "MCP VS CODE - GPT",
          rootPath: childPath,
          canonicalRootPath: childPath,
          trusted: true,
        },
      ],
      {
        enableProjectWrites: true,
        projectRootPath: projectRoot,
      },
    );

    expect(result.policy.workspaces[0]?.permissionProfile).toBe("full-repo-write");
    expect(result.policy.workspaces[0]?.allowWrites).toEqual(["."]);
    expect(result.policy.workspaces[0]?.allowedShells).toEqual(["powershell", "pwsh", "cmd", "wsl", "git-bash"]);
  });
});
