import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import {
  isLegacyCompatCandidate,
  mapAstGrepFinding,
  parseAstGrepOutput,
  resolveLegacyCompatTool,
  runLegacyCompatValidation,
} from "../../../src/validation/legacy-compat.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
}, 30_000);

describe("LegacySite legacy validation", () => {
  test("selects JavaScript files only", () => {
    expect(isLegacyCompatCandidate("Financeiro/arquivo.js")).toBe(true);
    expect(isLegacyCompatCandidate("ARQUIVO.JS")).toBe(true);
    expect(isLegacyCompatCandidate("config.jsonc")).toBe(false);
  });

  test("maps ast-grep coordinates and normalizes output", () => {
    expect(
      mapAstGrepFinding({
        file: ".\\Financeiro\\arquivo.js",
        ruleId: "legacySite-no-const",
        severity: "warning",
        message: "Const is not supported.",
        range: { start: { line: 3, column: 7 } },
      }),
    ).toEqual({
      ruleId: "legacySite-no-const",
      severity: "warning",
      message: "Const is not supported.",
      path: "Financeiro/arquivo.js",
      line: 4,
      column: 8,
      source: "ast-grep",
    });
  });

  test("returns a structured issue for invalid JSON output", () => {
    expect(parseAstGrepOutput("not-json")).toEqual({
      findings: [],
      issues: ["ast-grep returned invalid JSON output."],
    });
    expect(parseAstGrepOutput("{}")).toEqual({
      findings: [],
      issues: ["ast-grep returned invalid JSON output."],
    });
  });

  test("resolves the pinned ast-grep tool from the project", () => {
    const tool = resolveLegacyCompatTool(path.resolve("."));

    expect(tool).toEqual({
      command: expect.stringContaining("ast-grep"),
      configPath: expect.stringContaining("sgconfig.yml"),
    });
  });

  test("runs the real ast-grep rules and truncates returned findings", async () => {
    const tool = resolveLegacyCompatTool(path.resolve("."));
    expect(tool).toBeDefined();
    const directory = await mkdtemp(path.join(os.tmpdir(), "legacy-compat-test-"));
    temporaryDirectories.push(directory);
    await writeFile(
      path.join(directory, "modern.js"),
      "let value = 1;\nconst fn = (input) => input?.value ?? value;\n",
      "utf8",
    );

    const result = await runLegacyCompatValidation({
      tool: tool!,
      files: [{ relativePath: "modern.js" }],
      cwd: directory,
      maxFindings: 1,
      timeoutMs: 20_000,
    });

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.findingsCount).toBeGreaterThan(1);
    expect(result.findings).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.issues).toEqual([]);
  });
});
