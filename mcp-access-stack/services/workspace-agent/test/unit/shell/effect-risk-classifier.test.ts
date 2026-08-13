import { describe, expect, it } from "@jest/globals";
import { classifyCommandExecution } from "../../../src/shell/qualified/effect-risk-classifier.js";

describe("qualified command effect and risk classifier", () => {
  it("classifies read-only Git inspection as safe", () => {
    expect(
      classifyCommandExecution("pwsh", {
        kind: "argv",
        executable: "git",
        argv: ["status", "--short", "--branch"],
      }),
    ).toMatchObject({ effectClass: "pure_read", riskClass: "safe" });
  });

  it("classifies tests and builds as repeatable local effects", () => {
    expect(
      classifyCommandExecution("cmd", {
        kind: "argv",
        executable: "npm",
        argv: ["test"],
      }),
    ).toMatchObject({ effectClass: "repeatable_local", riskClass: "safe" });

    expect(
      classifyCommandExecution("pwsh", {
        kind: "script",
        script: "node ./node_modules/jest/bin/jest.js --runInBand",
      }),
    ).toMatchObject({ effectClass: "repeatable_local", riskClass: "safe" });
  });

  it("requires confirmation for local and external mutations", () => {
    expect(
      classifyCommandExecution("cmd", {
        kind: "argv",
        executable: "npm",
        argv: ["install"],
      }),
    ).toMatchObject({
      effectClass: "local_mutation",
      riskClass: "confirmation_required",
    });

    expect(
      classifyCommandExecution("git-bash", {
        kind: "argv",
        executable: "git",
        argv: ["push", "origin", "feature"],
      }),
    ).toMatchObject({
      effectClass: "external_mutation",
      riskClass: "confirmation_required",
    });
  });

  it("forbids destructive operations that must never be qualified", () => {
    expect(
      classifyCommandExecution("powershell", {
        kind: "script",
        script: "wsl --unregister Ubuntu",
      }),
    ).toMatchObject({ effectClass: "destructive", riskClass: "forbidden" });
  });

  it("does not guess the effect of unknown commands", () => {
    expect(
      classifyCommandExecution("pwsh", {
        kind: "argv",
        executable: "custom-tool",
        argv: ["perform", "operation"],
      }),
    ).toMatchObject({ effectClass: "unknown", riskClass: "unknown" });
  });
});
