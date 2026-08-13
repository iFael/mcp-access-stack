import { describe, expect, it, jest } from "@jest/globals";
import { createQualifiedCommandRuntimeOptions } from "../../src/qualified-command-runtime-config.js";

describe("qualified command runtime configuration", () => {
  it("keeps every rollout capability disabled by default", () => {
    const result = createQualifiedCommandRuntimeOptions({});
    expect(result).toEqual({
      qualifiedCommandFeatures: {
        qualifiedExecution: false,
        safeAutoCorrection: false,
        shadowMode: false,
        providerEnabled: false,
      },
      qualifiedCommandWorkspaceAllowlist: [],
    });
  });

  it("requires an explicit allowlist for every enabled mode", () => {
    expect(() =>
      createQualifiedCommandRuntimeOptions({
        VS_CODE_GPT_QUALIFIED_SHADOW_MODE_ENABLED: "true",
      }),
    ).toThrow("explicit workspace allowlist");
  });

  it("parses shadow and qualified modes without configuring a provider", () => {
    const telemetry = jest.fn();
    const result = createQualifiedCommandRuntimeOptions(
      {
        VS_CODE_GPT_QUALIFIED_EXECUTION_ENABLED: "1",
        VS_CODE_GPT_QUALIFIED_SHADOW_MODE_ENABLED: "true",
        VS_CODE_GPT_QUALIFIED_WORKSPACE_ALLOWLIST: "project, fixture,project",
      },
      telemetry,
    );
    expect(result).toMatchObject({
      qualifiedCommandFeatures: {
        qualifiedExecution: true,
        safeAutoCorrection: false,
        shadowMode: true,
        providerEnabled: false,
      },
      qualifiedCommandWorkspaceAllowlist: ["project", "fixture"],
      qualifiedCommandTelemetry: telemetry,
    });
    expect(result).not.toHaveProperty("qualifiedCommandProvider");
  });

  it("rejects autocorrection and provider modes without qualified execution", () => {
    expect(() =>
      createQualifiedCommandRuntimeOptions({
        VS_CODE_GPT_SAFE_AUTOCORRECTION_ENABLED: "true",
        VS_CODE_GPT_QUALIFIED_WORKSPACE_ALLOWLIST: "project",
      }),
    ).toThrow("requires qualified execution");
    expect(() =>
      createQualifiedCommandRuntimeOptions({
        VS_CODE_GPT_COMMAND_PROVIDER_ENABLED: "true",
        VS_CODE_GPT_QUALIFIED_WORKSPACE_ALLOWLIST: "project",
      }),
    ).toThrow("requires qualified execution");
  });

  it("constructs the provider only with explicit Windows broker configuration", () => {
    const result = createQualifiedCommandRuntimeOptions(
      {
        VS_CODE_GPT_QUALIFIED_EXECUTION_ENABLED: "true",
        VS_CODE_GPT_COMMAND_PROVIDER_ENABLED: "true",
        VS_CODE_GPT_QUALIFIED_WORKSPACE_ALLOWLIST: "project",
        VS_CODE_GPT_COMMAND_PROVIDER_MODEL: "gpt-5-mini",
        VS_CODE_GPT_COMMAND_PROVIDER_BROKER_PATH: "C:\\private\\McpCredentialBroker.exe",
        VS_CODE_GPT_COMMAND_PROVIDER_TIMEOUT_MS: "15000",
        VS_CODE_GPT_DATA_DIR: "C:\\private\\agent",
      },
      undefined,
      { platform: "win32", fileExists: () => true },
    );
    expect(result.qualifiedCommandProvider?.identity).toEqual({
      name: "openai-responses",
      model: "gpt-5-mini",
    });
  });

  it("fails closed for invalid booleans, workspace identifiers and non-Windows provider activation", () => {
    expect(() =>
      createQualifiedCommandRuntimeOptions({
        VS_CODE_GPT_QUALIFIED_EXECUTION_ENABLED: "maybe",
      }),
    ).toThrow("must be a boolean");
    expect(() =>
      createQualifiedCommandRuntimeOptions({
        VS_CODE_GPT_QUALIFIED_SHADOW_MODE_ENABLED: "true",
        VS_CODE_GPT_QUALIFIED_WORKSPACE_ALLOWLIST: "../project",
      }),
    ).toThrow("invalid identifier");
    expect(() =>
      createQualifiedCommandRuntimeOptions(
        {
          VS_CODE_GPT_QUALIFIED_EXECUTION_ENABLED: "true",
          VS_CODE_GPT_COMMAND_PROVIDER_ENABLED: "true",
          VS_CODE_GPT_QUALIFIED_WORKSPACE_ALLOWLIST: "project",
        },
        undefined,
        { platform: "linux" },
      ),
    ).toThrow("only on Windows");
  });
});
