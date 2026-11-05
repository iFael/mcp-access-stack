import { describe, expect, test } from "@jest/globals";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  test("allows exactly one trusted workspace-local .sh file to regain 755, not outside paths or symlinks", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(path.join(process.cwd(), ".trusted-chmod-test-"));
    try {
      const file = path.join(directory, "launch.sh");
      const relative = path.relative(process.cwd(), file);
      await writeFile(file, "#!/usr/bin/env bash\n");
      const options = {
        workspace: workspace("trusted-workspace"),
        shell: "sh" as const,
        logicalCwd: ".",
        absoluteCwd: process.cwd(),
        directRisk: { destructive: true, reasons: ["file mode modification"] },
        currentRequiresConfirmation: true,
        fallbackReasons: ["file mode modification"],
      };
      await expect(decideCommandAuthorization({ ...options,
        command: `chmod 755 ${relative}`,
      })).resolves.toEqual({ disposition: "execute", authorization: "trusted-workspace" });
      await expect(decideCommandAuthorization({ ...options,
        command: `chmod 777 ${relative}`,
      })).resolves.toMatchObject({ disposition: "blocked", code: "PERMISSION_DENIED" });
      await expect(decideCommandAuthorization({ ...options,
        command: `chmod -R 755 ${relative}`,
      })).resolves.toMatchObject({ disposition: "blocked", code: "PERMISSION_DENIED" });
      const linked = path.join(directory, "link.sh");
      await symlink(file, linked);
      await expect(decideCommandAuthorization({ ...options,
        command: `chmod 755 ${path.relative(process.cwd(), linked)}`,
      })).resolves.toMatchObject({ disposition: "blocked", code: "BLOCKED_PATH" });
      await expect(decideCommandAuthorization({ ...options,
        command: "chmod 755 /tmp/untrusted.sh",
      })).resolves.toMatchObject({ disposition: "blocked", code: "PATH_OUTSIDE_WORKSPACE" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });


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
      disposition: "blocked",
      code: "PERMISSION_DENIED",
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
      disposition: "blocked",
      code: "PERMISSION_DENIED",
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
    ).resolves.toMatchObject({ disposition: "blocked", code: "PERMISSION_DENIED" });
  });

  test("keeps legacy confirmationId recognizable for a trusted critical command", async () => {
    await expect(
      decideCommandAuthorization({
        workspace: workspace("trusted-workspace"),
        shell: "powershell",
        command: "sc.exe stop FixtureService",
        confirmationId: "legacy-confirmation-id",
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
      reasons: ["service or process control"],
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
    ).resolves.toMatchObject({ disposition: "blocked", code: "PERMISSION_DENIED" });
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
    ).resolves.toMatchObject({ disposition: "blocked", code: "PERMISSION_DENIED" });
  });
});
