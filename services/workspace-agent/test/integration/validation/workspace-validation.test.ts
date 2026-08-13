import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { LocalAgent } from "../../../src/index.js";
import {
  createFixture,
  git,
  initializeGitRepository,
  makeWorkspacePolicy,
  type Fixture,
  writePolicy,
  writeWorkspaceFile,
} from "../../support/helpers.js";

jest.setTimeout(60_000);

let fixture: Fixture | undefined;
const previousGitleaksPath = process.env.GITLEAKS_PATH;
const installedGitleaksPath = path.resolve(
  ".runtime-tools",
  "gitleaks",
  "8.30.1",
  process.platform === "win32" ? "gitleaks.exe" : "gitleaks",
);

afterEach(async () => {
  if (previousGitleaksPath === undefined) delete process.env.GITLEAKS_PATH;
  else process.env.GITLEAKS_PATH = previousGitleaksPath;
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

async function createValidationAgent(
  options: { blockedGlobs?: string[]; maxFileBytes?: number } = {},
): Promise<LocalAgent> {
  fixture = await createFixture({
    profile: "full-repo-write",
    allowedRoots: ["."],
    ...(options.blockedGlobs === undefined
      ? {}
      : { blockedGlobs: options.blockedGlobs }),
    ...(options.maxFileBytes === undefined
      ? {}
      : { limits: { maxFileBytes: options.maxFileBytes } }),
  });
  await writePolicy(fixture.policyPath, [
    {
      ...makeWorkspacePolicy(fixture.workspacePath, {
        profile: "full-repo-write",
        allowedRoots: ["."],
        ...(options.blockedGlobs === undefined
          ? {}
          : { blockedGlobs: options.blockedGlobs }),
        ...(options.maxFileBytes === undefined
          ? {}
          : { limits: { maxFileBytes: options.maxFileBytes } }),
      }),
      allowWrites: ["."],
      allowShell: ["."],
      allowedShells: ["powershell", "pwsh", "cmd", "wsl", "git-bash"],
    },
  ]);
  return LocalAgent.create(fixture.policyPath);
}

describe("workspace validation", () => {
  test("validates LegacySite encodings, line endings and suspicious regex patterns", async () => {
    const agent = await createValidationAgent();
    const good = Buffer.from("var ok = true;\r\n", "latin1");
    const bad = Buffer.from("var mensagem = 'ação';\nreplace(/[]/);\n", "utf8");
    const configWithBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{\n  "enabled": true\n}\n', "utf8"),
    ]);
    await writeWorkspaceFile(fixture!.workspacePath, "good.js", good);
    await writeWorkspaceFile(fixture!.workspacePath, "bad.js", bad);
    await writeWorkspaceFile(fixture!.workspacePath, "config.jsonc", configWithBom);

    const result = await agent.runValidation({
      workspaceId: "test",
      root: ".",
      validation: "legacy-format",
      scope: "paths",
      paths: ["good.js", "bad.js", "config.jsonc"],
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.filesScanned).toBe(3);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        "legacySite-js-encoding",
        "legacySite-js-line-ending",
        "legacySite-config-bom",
        "legacySite-regex-corruption",
      ]),
    );
    expect(result.findings.some((finding) => finding.path === "good.js")).toBe(false);
  });

  test("detects modern JavaScript syntax with the pinned ast-grep rules", async () => {
    const agent = await createValidationAgent();
    await writeWorkspaceFile(
      fixture!.workspacePath,
      "legacy.js",
      "var value = 1;\r\nfunction load(input) { return input; }\r\n",
    );
    await writeWorkspaceFile(
      fixture!.workspacePath,
      "modern.js",
      "let value = 1;\r\nconst fn = (input) => input?.value ?? value;\r\n",
    );

    const result = await agent.runValidation({
      workspaceId: "test",
      root: ".",
      validation: "legacy-compat",
      scope: "paths",
      paths: ["legacy.js", "modern.js"],
    });

    expect(result.executed).toBe(true);
    expect(result.tool).toMatchObject({ name: "ast-grep", available: true });
    expect(result.passed).toBe(false);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        "legacySite-no-let",
        "legacySite-no-const",
        "legacySite-no-arrow-function",
        "legacySite-no-optional-chaining",
        "legacySite-no-nullish-coalescing",
      ]),
    );
    expect(result.findings.every((finding) => finding.path === "modern.js")).toBe(true);
  });

  test("runs staged and unstaged Git whitespace checks", async () => {
    const agent = await createValidationAgent();
    initializeGitRepository(fixture!.workspacePath);
    await writeWorkspaceFile(fixture!.workspacePath, "tracked.txt", "clean\n");
    git(fixture!.workspacePath, ["add", "tracked.txt"]);
    git(fixture!.workspacePath, ["commit", "-m", "initial"]);
    await writeWorkspaceFile(fixture!.workspacePath, "tracked.txt", "bad whitespace   \n");

    const result = await agent.runValidation({
      workspaceId: "test",
      root: ".",
      validation: "diff-check",
      scope: "changes",
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.tool).toMatchObject({ name: "git", available: true });
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "git-diff-check-unstaged",
          path: "tracked.txt",
          severity: "error",
        }),
      ]),
    );
  });

  test("resolves changed paths relative to a nested validation root", async () => {
    const agent = await createValidationAgent();
    initializeGitRepository(fixture!.basePath);
    git(fixture!.basePath, ["config", "status.relativePaths", "false"]);
    await writeWorkspaceFile(fixture!.workspacePath, "tracked.txt", "clean\n");
    git(fixture!.basePath, ["add", "workspace/tracked.txt"]);
    git(fixture!.basePath, ["commit", "-m", "initial"]);
    await writeWorkspaceFile(
      fixture!.workspacePath,
      "tracked.txt",
      "bad whitespace   \n",
    );

    const result = await agent.runValidation({
      workspaceId: "test",
      root: ".",
      validation: "diff-check",
      scope: "changes",
    });

    expect(result.filesScanned).toBe(1);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "git-diff-check-unstaged",
          path: "tracked.txt",
        }),
      ]),
    );
    expect(result.warnings.some((warning) => warning.includes("was skipped"))).toBe(false);
  });

  (existsSync(installedGitleaksPath) ? test : test.skip)(
    "redacts secrets returned by the installed Gitleaks binary",
    async () => {
      const agent = await createValidationAgent();
      const fakeSecret = "ghp_" + "1234567890abcdef".repeat(2) + "12345678";
      await writeWorkspaceFile(
        fixture!.workspacePath,
        "secret.txt",
        `token=${fakeSecret}\n`,
      );
      process.env.GITLEAKS_PATH = installedGitleaksPath;

      const result = await agent.runValidation({
        workspaceId: "test",
        root: ".",
        validation: "secret-scan",
        scope: "paths",
        paths: ["secret.txt"],
      });

      expect(result.executed).toBe(true);
      expect(result.tool).toMatchObject({ name: "gitleaks", available: true });
      expect(result.passed).toBe(false);
      expect(result.findingsCount).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain(fakeSecret);
      expect(result.findings.every((finding) => !("secret" in finding))).toBe(true);
      expect(
        result.findings.every(
          (finding) =>
            finding.fingerprint === undefined ||
            /^sha256:[a-f0-9]{64}$/.test(finding.fingerprint),
        ),
      ).toBe(true);
    },
  );
  (existsSync(installedGitleaksPath) ? test : test.skip)(
    "suppresses the exact LegacySite status-label false positive",
    async () => {
      const agent = await createValidationAgent();
      const filePath = "Financeiro/FIN_conc_fila.js";
      await writeWorkspaceFile(
        fixture!.workspacePath,
        filePath,
        [
          "function getOfficialSituationLabel(Status) {",
          "    var Key = (\"\" + (Status || \"\")).toUpperCase();",
          "    if (Key == \"CANDIDATO\" || Key == \"D1_COMPATIVEL\") { return \"Localizado sem confirmação\"; }",
          "    return Status;",
          "}",
          "",
        ].join("\r\n"),
      );
      process.env.GITLEAKS_PATH = installedGitleaksPath;

      const result = await agent.runValidation({
        workspaceId: "test",
        root: ".",
        validation: "secret-scan",
        scope: "paths",
        paths: [filePath],
      });

      expect(result.executed).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.findingsCount).toBe(0);
      expect(result.findings).toEqual([]);
      expect(result.warnings).toContain(
        "Suppressed 1 known LegacySite status-label false positive(s).",
      );
    },
  );

  (existsSync(installedGitleaksPath) ? test : test.skip)(
    "does not suppress a real secret in the same LegacySite file",
    async () => {
      const agent = await createValidationAgent();
      const filePath = "Financeiro/FIN_conc_fila.js";
      const fakeSecret = "ghp_" + "fedcba0987654321".repeat(2) + "fedcba09";
      await writeWorkspaceFile(
        fixture!.workspacePath,
        filePath,
        [
          "function getOfficialSituationLabel(Status) {",
          "    var Key = \"" + fakeSecret + "\";",
          "    if (Key == \"CANDIDATO\" || Key == \"D1_COMPATIVEL\") { return \"Localizado sem confirmação\"; }",
          "    return Status;",
          "}",
          "",
        ].join("\r\n"),
      );
      process.env.GITLEAKS_PATH = installedGitleaksPath;

      const result = await agent.runValidation({
        workspaceId: "test",
        root: ".",
        validation: "secret-scan",
        scope: "paths",
        paths: [filePath],
      });

      expect(result.executed).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.findingsCount).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain(fakeSecret);
    },
  );

  (existsSync(installedGitleaksPath) ? test : test.skip)(
    "does not expose policy-blocked files to Gitleaks",
    async () => {
      const agent = await createValidationAgent({
        blockedGlobs: ["private-data/**"],
      });
      const blockedSecret = "ghp_" + "abcdef0123456789".repeat(2) + "abcdef01";
      await writeWorkspaceFile(fixture!.workspacePath, "safe.txt", "safe content\n");
      await writeWorkspaceFile(
        fixture!.workspacePath,
        "private-data/secret.txt",
        `token=${blockedSecret}\n`,
      );
      process.env.GITLEAKS_PATH = installedGitleaksPath;

      const result = await agent.runValidation({
        workspaceId: "test",
        root: ".",
        validation: "secret-scan",
        scope: "repository",
      });

      expect(result.executed).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.filesScanned).toBe(1);
      expect(result.findings).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(blockedSecret);
      expect(result.warnings).toContain(
        "Repository scope scans current authorized files and does not inspect Git history.",
      );
    },
  );

  test("skips JavaScript files above the workspace read limit before ast-grep", async () => {
    const agent = await createValidationAgent({ maxFileBytes: 64 });
    await writeWorkspaceFile(
      fixture!.workspacePath,
      "small.js",
      "var value = 1;\r\n",
    );
    await writeWorkspaceFile(
      fixture!.workspacePath,
      "oversized.js",
      `let value = 1;\r\n${"x".repeat(100)}`,
    );

    const result = await agent.runValidation({
      workspaceId: "test",
      root: ".",
      validation: "legacy-compat",
      scope: "repository",
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.filesScanned).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.warnings).toContain(
      "File exceeds the workspace read limit and was skipped: oversized.js",
    );
  });

  test("returns a structured unavailable result when Gitleaks is absent", async () => {
    const agent = await createValidationAgent();
    await writeWorkspaceFile(fixture!.workspacePath, "file.txt", "safe\n");
    process.env.GITLEAKS_PATH = path.join(fixture!.workspacePath, "missing-gitleaks.exe");

    const result = await agent.runValidation({
      workspaceId: "test",
      root: ".",
      validation: "secret-scan",
      scope: "paths",
      paths: ["file.txt"],
    });

    expect(result).toMatchObject({
      executed: false,
      passed: false,
      tool: { name: "gitleaks", available: false },
      findings: [],
    });
    expect(result.issues[0]).toContain("Gitleaks is not installed");
    await expect(readFile(path.join(fixture!.workspacePath, "file.txt"), "utf8")).resolves.toBe(
      "safe\n",
    );
  });
});
