import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  RunWorkspaceValidationResult,
  WorkspaceValidationFinding,
} from "@vs-code-gpt/shared";
import { throwIfAborted } from "./process-runner.js";
import {
  decodeForInspection,
  detectTextFormat,
  hasUtf16Bom,
  lineAndColumn,
} from "./text-format.js";

export interface LegacyFormatFile {
  relativePath: string;
  canonicalPath: string;
}

export interface LegacyFormatValidationInput {
  files: LegacyFormatFile[];
  maxFindings: number;
  signal?: AbortSignal;
}

export interface LegacyFormatValidationPayload {
  executed: boolean;
  passed: boolean;
  tool: RunWorkspaceValidationResult["tool"];
  filesScanned: number;
  findings: WorkspaceValidationFinding[];
  findingsCount: number;
  truncated: boolean;
  issues: string[];
  warnings: string[];
}

export function isLegacyFormatCandidate(relativePath: string): boolean {
  const lowerPath = relativePath.toLocaleLowerCase("en-US");
  return (
    lowerPath.endsWith(".js") ||
    path.posix.basename(lowerPath) === "config.jsonc"
  );
}

export async function runLegacyFormatValidation(
  input: LegacyFormatValidationInput,
): Promise<LegacyFormatValidationPayload> {
  const findings: WorkspaceValidationFinding[] = [];

  for (const file of input.files) {
    throwIfAborted(input.signal);
    const buffer = await readFile(file.canonicalPath);
    findings.push(...inspectLegacySiteFileFormat(file.relativePath, buffer));
  }

  const limited = limitFindings(findings, input.maxFindings);
  return {
    executed: true,
    passed: findings.every((finding) => finding.severity !== "error"),
    tool: { name: "legacy-format", available: true, version: "1.0.0" },
    filesScanned: input.files.length,
    findings: limited.findings,
    findingsCount: findings.length,
    truncated: limited.truncated,
    issues: [],
    warnings: [],
  };
}

export function inspectLegacySiteFileFormat(
  relativePath: string,
  buffer: Buffer,
): WorkspaceValidationFinding[] {
  const findings: WorkspaceValidationFinding[] = [];
  const lowerPath = relativePath.toLocaleLowerCase("en-US");
  const isJavaScript = lowerPath.endsWith(".js");
  const isConfig = path.posix.basename(lowerPath) === "config.jsonc";

  if (buffer.includes(0) && !hasUtf16Bom(buffer)) {
    return [
      makeFinding(
        "legacySite-binary-text-file",
        "Expected a text file, but binary NUL bytes were detected.",
        relativePath,
      ),
    ];
  }

  const format = detectTextFormat(buffer);
  if (isJavaScript) {
    if (!["ascii", "windows-1252"].includes(format.encoding)) {
      findings.push(
        makeFinding(
          "legacySite-js-encoding",
          `JavaScript file must remain Windows-1252/CP1252; detected ${format.encoding}.`,
          relativePath,
        ),
      );
    }
    if (!["crlf", "none"].includes(format.lineEnding)) {
      findings.push(
        makeFinding(
          "legacySite-js-line-ending",
          `JavaScript file must use CRLF; detected ${format.lineEnding}.`,
          relativePath,
        ),
      );
    }
  }

  if (isConfig) {
    if (!["ascii", "utf-8"].includes(format.encoding)) {
      findings.push(
        makeFinding(
          "legacySite-config-encoding",
          `config.jsonc must use UTF-8; detected ${format.encoding}.`,
          relativePath,
        ),
      );
    }
    if (format.bom) {
      findings.push(
        makeFinding(
          "legacySite-config-bom",
          "config.jsonc must use UTF-8 without BOM.",
          relativePath,
        ),
      );
    }
  }

  const text = decodeForInspection(buffer, format.encoding, format.bomBytes);
  for (const suspicious of ["replace(/[]/", "replace(//g"]) {
    let offset = text.indexOf(suspicious);
    while (offset !== -1) {
      const position = lineAndColumn(text, offset);
      findings.push({
        ...makeFinding(
          "legacySite-regex-corruption",
          `Suspicious regex corruption pattern detected: ${suspicious}`,
          relativePath,
        ),
        line: position.line,
        column: position.column,
      });
      offset = text.indexOf(suspicious, offset + suspicious.length);
    }
  }

  return findings;
}

function makeFinding(
  ruleId: string,
  message: string,
  pathValue: string,
): WorkspaceValidationFinding {
  return {
    ruleId,
    severity: "error",
    message,
    path: normalizeOutputPath(pathValue),
    source: "format",
  };
}

function limitFindings(
  findings: WorkspaceValidationFinding[],
  maxFindings: number,
): { findings: WorkspaceValidationFinding[]; truncated: boolean } {
  return {
    findings: findings.slice(0, maxFindings),
    truncated: findings.length > maxFindings,
  };
}

function normalizeOutputPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "") || ".";
}
