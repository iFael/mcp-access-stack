import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import type { WorkspaceValidationFinding } from "@vs-code-gpt/shared";
import {
  deduplicateFindings,
  filterKnownGitleaksFalsePositives,
  mapGitleaksFinding,
  runSecretScanValidation,
} from "../../../src/validation/secret-scan.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("secret scan validation", () => {
  test("normalizes findings and hashes the fingerprint", () => {
    const finding = mapGitleaksFinding(
      {
        Description: "Potential token",
        StartLine: 4,
        StartColumn: 8,
        File: ".\\Financeiro\\arquivo.js",
        RuleID: "generic-api-key",
        Fingerprint: "sensitive-fingerprint",
      },
      path.resolve("."),
    );

    expect(finding).toEqual({
      ruleId: "generic-api-key",
      severity: "error",
      message: "Potential token",
      path: "Financeiro/arquivo.js",
      line: 4,
      column: 8,
      source: "gitleaks",
      fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(finding.fingerprint).not.toContain("sensitive-fingerprint");
  });

  test("deduplicates equivalent findings", () => {
    const finding: WorkspaceValidationFinding = {
      ruleId: "generic-api-key",
      severity: "error",
      message: "Potential token",
      path: "arquivo.js",
      line: 2,
      column: 3,
      source: "gitleaks",
      fingerprint: "sha256:abc",
    };

    expect(deduplicateFindings([finding, { ...finding }])).toEqual([finding]);
  });

  test("suppresses only the exact LegacySite status-label false positive", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gitleaks-filter-test-"));
    temporaryDirectories.push(directory);
    const relativePath = "Financeiro/FIN_conc_fila.js";
    const filePath = path.join(directory, ...relativePath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      [
        "function getOfficialSituationLabel(Status) {",
        "    var Key = (\"\" + (Status || \"\")).toUpperCase();",
        "    if (Key == \"CANDIDATO\" || Key == \"D1_COMPATIVEL\") { return \"Localizado sem confirmação\"; }",
        "    return Status;",
        "}",
      ].join("\r\n"),
      "utf8",
    );

    const result = await filterKnownGitleaksFalsePositives(
      [
        {
          File: relativePath,
          RuleID: "generic-api-key",
          StartLine: 3,
        },
        {
          File: relativePath,
          RuleID: "generic-api-key",
          StartLine: 2,
        },
      ],
      directory,
    );

    expect(result.suppressedCount).toBe(1);
    expect(result.findings).toEqual([
      expect.objectContaining({ StartLine: 2 }),
    ]);
  });

  test("keeps repository warnings out of an empty scan result", async () => {
    const result = await runSecretScanValidation({
      tool: { command: "gitleaks", version: "test" },
      files: [],
      scope: "repository",
      maxFindings: 100,
      timeoutMs: 10_000,
    });

    expect(result).toMatchObject({
      executed: true,
      passed: true,
      filesScanned: 0,
      findings: [],
      warnings: [],
    });
  });
});
