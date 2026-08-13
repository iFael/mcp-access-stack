import { afterEach, describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CommandPlan,
  RunCommandResult,
} from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "../../../src/internal-types.js";
import { validateCommandPostconditions } from "../../../src/shell/qualified/postcondition-validator.js";

const directories: string[] = [];
const fingerprint = "f".repeat(64);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture(): Promise<{
  workspace: ResolvedWorkspace;
  root: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "qualified-postconditions-"));
  directories.push(root);
  const canonical = await realpath(root);
  return {
    root,
    workspace: {
      id: "test",
      name: "Test",
      rootPath: root,
      canonicalRootPath: canonical,
      enabled: true,
      permissionProfile: "full-repo-write",
      allowedRoots: [
        {
          logicalPath: ".",
          absolutePath: root,
          canonicalPath: canonical,
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
      allowedShells: ["powershell"],
    },
  };
}

function result(): Extract<RunCommandResult, { status: "executed" }> {
  return {
    status: "executed",
    shell: "powershell",
    cwd: ".",
    exitCode: 0,
    stdout: "qualified-ok",
    stderr: "",
    timedOut: false,
  };
}

function plan(
  postconditions: CommandPlan["postconditions"],
  cwd = ".",
): CommandPlan {
  return {
    invocationId: "invocation-1",
    source: "explicit-command",
    shell: "powershell",
    cwd,
    execution: { kind: "argv", executable: "echo", argv: ["qualified-ok"] },
    timeoutMs: 30_000,
    absoluteDeadline: "2026-08-04T23:00:00.000Z",
    riskClass: "safe",
    effectClass: "pure_read",
    expectedOutcomes: postconditions,
    postconditions,
    fingerprint,
    provenance: { source: "explicit-command", sanitized: true },
  };
}

describe("qualified postcondition validator", () => {
  it("validates exit code, output, files, hash, JSON and duration", async () => {
    const { workspace, root } = await fixture();
    const content = '{"status":"ready","count":2}\n';
    await writeFile(path.join(root, "result.json"), content, "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");

    await expect(
      validateCommandPostconditions(
        workspace,
        plan([
          { kind: "exit_code", value: 0 },
          { kind: "text_contains", stream: "stdout", value: "qualified-ok" },
          { kind: "file_exists", path: "result.json" },
          { kind: "file_absent", path: "missing.txt" },
          { kind: "sha256", path: "result.json", value: sha256 },
          {
            kind: "json_field",
            path: "result.json",
            pointer: "/status",
            value: "ready",
          },
          { kind: "duration_lte", valueMs: 1_000 },
        ]),
        result(),
        100,
      ),
    ).resolves.toEqual({ passed: true, checked: 7, failed: 0 });
  });

  it("counts failed postconditions without exposing file contents", async () => {
    const { workspace, root } = await fixture();
    await writeFile(path.join(root, "present.txt"), "value", "utf8");

    await expect(
      validateCommandPostconditions(
        workspace,
        plan([
          { kind: "exit_code", value: 2 },
          { kind: "text_contains", stream: "stderr", value: "missing" },
          { kind: "file_absent", path: "present.txt" },
        ]),
        result(),
        100,
      ),
    ).resolves.toEqual({ passed: false, checked: 3, failed: 3 });
  });
});
