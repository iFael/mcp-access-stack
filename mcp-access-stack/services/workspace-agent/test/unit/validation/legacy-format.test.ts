import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import {
  inspectLegacySiteFileFormat,
  isLegacyFormatCandidate,
  runLegacyFormatValidation,
} from "../../../src/validation/legacy-format.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("LegacySite format validation", () => {
  test("selects JavaScript and config.jsonc files only", () => {
    expect(isLegacyFormatCandidate("Financeiro/arquivo.js")).toBe(true);
    expect(isLegacyFormatCandidate("CONFIG.JSONC")).toBe(true);
    expect(isLegacyFormatCandidate("README.md")).toBe(false);
  });

  test("accepts Windows-1252 JavaScript with CRLF", () => {
    const buffer = Buffer.from("var mensagem = 'ação';\r\n", "latin1");

    expect(inspectLegacySiteFileFormat("arquivo.js", buffer)).toEqual([]);
  });

  test("reports encoding, line ending, BOM and regex corruption", () => {
    const javascript = Buffer.from("var mensagem = 'ação';\nreplace(/[]/);\n", "utf8");
    const config = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{\n  "enabled": true\n}\n', "utf8"),
    ]);

    const findings = [
      ...inspectLegacySiteFileFormat("arquivo.js", javascript),
      ...inspectLegacySiteFileFormat("config.jsonc", config),
    ];

    expect(findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        "legacySite-js-encoding",
        "legacySite-js-line-ending",
        "legacySite-config-encoding",
        "legacySite-config-bom",
        "legacySite-regex-corruption",
      ]),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        ruleId: "legacySite-regex-corruption",
        path: "arquivo.js",
        line: 2,
        column: 1,
      }),
    );
  });

  test("rejects binary NUL bytes without a UTF-16 BOM", () => {
    const findings = inspectLegacySiteFileFormat(
      "arquivo.js",
      Buffer.from([0x76, 0x61, 0x72, 0x00, 0x78]),
    );

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "legacySite-binary-text-file",
        path: "arquivo.js",
      }),
    ]);
  });

  test("limits returned findings while preserving the total count", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "legacy-format-test-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "arquivo.js");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "const valor = 'ação';\nreplace(/[]/);\n", "utf8");

    const result = await runLegacyFormatValidation({
      files: [{ relativePath: "arquivo.js", canonicalPath: filePath }],
      maxFindings: 1,
    });

    expect(result.passed).toBe(false);
    expect(result.findingsCount).toBeGreaterThan(1);
    expect(result.findings).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});
