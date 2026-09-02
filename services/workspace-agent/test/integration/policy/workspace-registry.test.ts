import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "@jest/globals";
import {
  mergeWorkspacePolicies,
  type DiscoveredWorkspaceCandidate,
} from "@vs-code-gpt/shared";
import { LocalAgent } from "../../../src/local-agent.js";
import { WorkspaceRegistry } from "../../../src/workspace-registry.js";
import {
  createFixture,
  defaultLimits,
  makeWorkspacePolicy,
  writePolicy,
} from "../../support/helpers.js";

describe("WorkspaceRegistry.fromPolicy", () => {
  it("loads explicit and synthetic policies without reading disk policy path", async () => {
    const fixture = await createFixture();
    try {
      const registry = await WorkspaceRegistry.load(fixture.policyPath);
      const fromDisk = registry.listEnabled();
      expect(fromDisk[0]?.confirmationMode).toBe("standard");
      const raw = await readFile(fixture.policyPath, "utf8");
      const policy = JSON.parse(raw);
      const fromPolicy = await WorkspaceRegistry.fromPolicy(policy);
      expect(fromPolicy.listEnabled()).toEqual(fromDisk);
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves explicit source-control policy on the resolved workspace", async () => {
    const fixture = await createFixture({ profile: "full-repo-write" });
    try {
      const sourceControl = {
        capabilities: ["git.branch.write", "github.repository.read"],
        accountOwners: ["example-owner"],
        additionalRepositories: ["example-owner/other-repo"],
      };
      await writePolicy(fixture.policyPath, [
        {
          ...makeWorkspacePolicy(fixture.workspacePath, { profile: "full-repo-write" }),
          sourceControl,
        },
      ]);

      const registry = await WorkspaceRegistry.load(fixture.policyPath);
      expect(registry.get("test")).toMatchObject({ sourceControl });
    } finally {
      await fixture.cleanup();
    }
  });

  it("creates LocalAgent from merged synthetic policy", async () => {
    const basePath = await mkdtemp(path.join(os.tmpdir(), "vs-code-gpt-from-policy-"));
    const workspacePath = path.join(basePath, "workspace");
    const secondPath = path.join(basePath, "second");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(secondPath, { recursive: true });
    const policyPath = path.join(basePath, "policy.json");
    await writePolicy(policyPath, [
      {
        id: "primary",
        name: "Primary",
        rootPath: workspacePath,
        enabled: true,
        permissionProfile: "planning-readonly",
        allowedRoots: ["."],
        blockedGlobs: [],
        limits: defaultLimits,
        allowWrites: [],
      },
      {
        id: "secondary",
        name: "Secondary",
        rootPath: secondPath,
        enabled: true,
        permissionProfile: "builder-review",
        allowedRoots: ["."],
        blockedGlobs: [],
        limits: defaultLimits,
        allowWrites: [],
      },
    ]);

    const raw = await readFile(policyPath, "utf8");
    const policy = JSON.parse(raw);
    const agent = await LocalAgent.createFromPolicy(policy);
    const workspaces = await agent.listWorkspaces();
    expect(workspaces).toHaveLength(2);
    expect(workspaces.map((workspace) => workspace.id).sort()).toEqual([
      "primary",
      "secondary",
    ]);
    await rm(basePath, { recursive: true, force: true });
  });

  it("resolves different workspace ids on the same canonical root to one concurrency key", async () => {
    const basePath = await mkdtemp(path.join(os.tmpdir(), "vs-code-gpt-concurrency-key-"));
    const workspacePath = path.join(basePath, "workspace");
    await mkdir(workspacePath, { recursive: true });
    try {
      const shared = {
        rootPath: workspacePath,
        enabled: true,
        permissionProfile: "planning-readonly" as const,
        confirmationMode: "standard" as const,
        allowedRoots: ["."],
        blockedGlobs: [],
        limits: defaultLimits,
        allowWrites: [],
        allowShell: [],
        allowedShells: [],
      };
      const agent = await LocalAgent.createFromPolicy({
        version: 1,
        workspaces: [
          { id: "alias-a", name: "Alias A", ...shared },
          { id: "alias-b", name: "Alias B", ...shared },
        ],
      });
      expect(agent.resolveWorkspaceConcurrencyKey("alias-a")).toBe(
        agent.resolveWorkspaceConcurrencyKey("alias-b"),
      );
    } finally {
      await rm(basePath, { recursive: true, force: true });
    }
  });

  it("lists merged multi-root workspaces without exposing rootPath", async () => {
    const basePath = await mkdtemp(path.join(os.tmpdir(), "vs-code-gpt-multi-root-"));
    const firstPath = path.join(basePath, "first");
    const secondPath = path.join(basePath, "second");
    await mkdir(firstPath, { recursive: true });
    await mkdir(secondPath, { recursive: true });
    const policyPath = path.join(basePath, "policy.json");
    await writePolicy(policyPath, []);

    const discovered: DiscoveredWorkspaceCandidate[] = [
      {
        name: "First",
        rootPath: firstPath,
        canonicalRootPath: firstPath,
        trusted: true,
      },
      {
        name: "Second",
        rootPath: secondPath,
        canonicalRootPath: secondPath,
        trusted: true,
      },
    ];

    const merged = mergeWorkspacePolicies({ version: 1, entries: [] }, discovered);
    const agent = await LocalAgent.createFromPolicy(merged.policy);
    const listed = await agent.listWorkspaces();
    expect(listed).toHaveLength(2);
    for (const workspace of listed) {
      expect(workspace).not.toHaveProperty("rootPath");
      expect(workspace.enabled).toBe(true);
    }
    await rm(basePath, { recursive: true, force: true });
  });
});
