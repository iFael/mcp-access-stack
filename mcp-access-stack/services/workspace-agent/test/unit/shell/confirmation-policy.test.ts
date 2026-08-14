import { describe, expect, test } from "@jest/globals";
import path from "node:path";
import type { ResolvedWorkspace } from "../../../src/internal-types.js";
import { decideCommandAuthorization } from "../../../src/shell/confirmation-policy.js";

function workspace(confirmationMode: "standard" | "trusted-workspace"): ResolvedWorkspace {
  const root = path.resolve(process.cwd());
  return {
    id: "test",
    name: "Test Workspace",
    rootPath: root,
    canonicalRootPath: root,
    enabled: true,
    permissionProfile: "full-repo-write",
    confirmationMode,
    allowedRoots: [
      {
        logicalPath: ".",
        absolutePath: root,
        canonicalPath: root,
        kind: "directory",
      },
    ],
    blockedGlobs: [],
    limits: {
      maxFileBytes: 64_000,
      maxSearchResults: 100,
      maxSearchSnippetBytes: 20_000,
      maxDiffBytes: 500_000,
      maxListedFiles: 500,
    },
    allowWrites: ["."],
    allowShell: ["."],
    allowedShells: ["powershell", "pwsh", "cmd", "wsl", "git-bash"],
  };
}

describe("confirmation policy", () => {
  test("keeps standard behavior unchanged for commands not currently requiring confirmation", async () => {
    await expect(
      decideCommandAuthorization({
        workspace: workspace("standard"),
        shell: "powershell",
        command: "schtasks /Delete /TN Fixture /F",
        logicalCwd: ".",
        absoluteCwd: process.cwd(),
        directRisk: { destructive: false, reasons: [] },
        currentRequiresConfirmation: false,
        fallbackReasons: [],
      }),
    ).resolves.toEqual({ disposition: "execute", authorization: "standard" });
  });

  test("adds the critical guard only inside trusted-workspace", async () => {
    await expect(
      decideCommandAuthorization({
        workspace: workspace("trusted-workspace"),
        shell: "powershell",
        command: "schtasks /Delete /TN Fixture /F",
        logicalCwd: ".",
        absoluteCwd: process.cwd(),
        directRisk: { destructive: false, reasons: [] },
        currentRequiresConfirmation: false,
        fallbackReasons: [],
      }),
    ).resolves.toMatchObject({
      disposition: "confirmation_required",
      reasons: [expect.stringMatching(/Scheduled Task/u)],
    });
  });

  test("keeps safe Docker inspection direct but protects Docker mutations", async () => {
    await expect(
      decideCommandAuthorization({
        workspace: workspace("trusted-workspace"),
        shell: "powershell",
        command: "docker ps",
        logicalCwd: ".",
        absoluteCwd: process.cwd(),
        directRisk: { destructive: false, reasons: [] },
        currentRequiresConfirmation: false,
        fallbackReasons: [],
      }),
    ).resolves.toEqual({ disposition: "execute", authorization: "standard" });

    await expect(
      decideCommandAuthorization({
        workspace: workspace("trusted-workspace"),
        shell: "powershell",
        command: "docker stop fixture-container",
        logicalCwd: ".",
        absoluteCwd: process.cwd(),
        directRisk: { destructive: false, reasons: [] },
        currentRequiresConfirmation: false,
        fallbackReasons: [],
      }),
    ).resolves.toMatchObject({
      disposition: "confirmation_required",
      reasons: [expect.stringMatching(/Docker mutation/u)],
    });

    await expect(
      decideCommandAuthorization({
        workspace: workspace("trusted-workspace"),
        shell: "powershell",
        command: "docker volume rm fixture-volume",
        logicalCwd: ".",
        absoluteCwd: process.cwd(),
        directRisk: {
          destructive: true,
          reasons: ["docker cleanup or volume-removing operation"],
        },
        currentRequiresConfirmation: true,
        fallbackReasons: ["docker cleanup or volume-removing operation"],
      }),
    ).resolves.toMatchObject({ disposition: "confirmation_required" });
  });

  test("never treats sc.exe as the PowerShell Set-Content alias", async () => {
    await expect(
      decideCommandAuthorization({
        workspace: workspace("trusted-workspace"),
        shell: "powershell",
        command: "sc.exe stop FixtureService",
        logicalCwd: ".",
        absoluteCwd: process.cwd(),
        directRisk: {
          destructive: true,
          reasons: ["service or process control"],
        },
        currentRequiresConfirmation: true,
        fallbackReasons: ["service or process control"],
      }),
    ).resolves.toMatchObject({
      disposition: "confirmation_required",
    });
  });

  test("does not treat sc as Set-Content under PowerShell 7", async () => {
    await expect(
      decideCommandAuthorization({
        workspace: workspace("trusted-workspace"),
        shell: "pwsh",
        command: "sc fixture.txt value",
        logicalCwd: ".",
        absoluteCwd: process.cwd(),
        directRisk: {
          destructive: true,
          reasons: ["move, overwrite or direct file write operation"],
        },
        currentRequiresConfirmation: true,
        fallbackReasons: ["move, overwrite or direct file write operation"],
      }),
    ).resolves.toMatchObject({ disposition: "confirmation_required" });
  });

  test("keeps trusted Git mutation bypass on deterministic Windows shells only", async () => {
    await expect(
      decideCommandAuthorization({
        workspace: workspace("trusted-workspace"),
        shell: "wsl",
        command: "git restore --staged -- tracked.txt",
        logicalCwd: ".",
        absoluteCwd: process.cwd(),
        directRisk: {
          destructive: true,
          reasons: ["destructive git operation"],
        },
        currentRequiresConfirmation: true,
        fallbackReasons: ["destructive git operation"],
      }),
    ).resolves.toMatchObject({ disposition: "confirmation_required" });
  });
});
