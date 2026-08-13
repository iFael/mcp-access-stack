import { existsSync } from "node:fs";
import path from "node:path";
import {
  AppError,
  WindowsCredentialBrokerClient,
  type QualifiedCommandFeatureFlags,
} from "@vs-code-gpt/shared";
import type { LocalAgentOptions } from "./local-agent.js";
import {
  OpenAIResponsesCommandProvider,
  WindowsCredentialManagerApiKeySource,
} from "./shell/qualified/openai-responses-command-provider.js";
import type { QualifiedCommandTelemetryEvent } from "./shell/qualified/qualified-command-metrics.js";

const WORKSPACE_ID = /^[a-z0-9._-]{1,128}$/iu;

export interface QualifiedCommandRuntimeConfigOptions {
  platform?: NodeJS.Platform;
  fileExists?: (filePath: string) => boolean;
}

export function createQualifiedCommandRuntimeOptions(
  environment: NodeJS.ProcessEnv,
  telemetry?: (event: QualifiedCommandTelemetryEvent) => void,
  options: QualifiedCommandRuntimeConfigOptions = {},
): LocalAgentOptions {
  const features: QualifiedCommandFeatureFlags = {
    qualifiedExecution: readBoolean(
      environment.VS_CODE_GPT_QUALIFIED_EXECUTION_ENABLED,
      "VS_CODE_GPT_QUALIFIED_EXECUTION_ENABLED",
    ),
    safeAutoCorrection: readBoolean(
      environment.VS_CODE_GPT_SAFE_AUTOCORRECTION_ENABLED,
      "VS_CODE_GPT_SAFE_AUTOCORRECTION_ENABLED",
    ),
    shadowMode: readBoolean(
      environment.VS_CODE_GPT_QUALIFIED_SHADOW_MODE_ENABLED,
      "VS_CODE_GPT_QUALIFIED_SHADOW_MODE_ENABLED",
    ),
    providerEnabled: readBoolean(
      environment.VS_CODE_GPT_COMMAND_PROVIDER_ENABLED,
      "VS_CODE_GPT_COMMAND_PROVIDER_ENABLED",
    ),
  };
  const allowlist = readAllowlist(
    environment.VS_CODE_GPT_QUALIFIED_WORKSPACE_ALLOWLIST,
  );
  const enabled =
    features.qualifiedExecution ||
    features.safeAutoCorrection ||
    features.shadowMode === true ||
    features.providerEnabled === true;
  if (enabled && allowlist.length === 0) {
    throw new AppError(
      "POLICY_INVALID",
      "Qualified command rollout requires an explicit workspace allowlist.",
    );
  }
  if (features.safeAutoCorrection && !features.qualifiedExecution) {
    throw new AppError(
      "POLICY_INVALID",
      "Safe autocorrection requires qualified execution.",
    );
  }
  if (features.providerEnabled && !features.qualifiedExecution) {
    throw new AppError(
      "POLICY_INVALID",
      "The command provider requires qualified execution.",
    );
  }

  const provider = features.providerEnabled
    ? createProvider(environment, options)
    : undefined;
  return {
    qualifiedCommandFeatures: features,
    qualifiedCommandWorkspaceAllowlist: allowlist,
    ...(telemetry === undefined ? {} : { qualifiedCommandTelemetry: telemetry }),
    ...(provider === undefined ? {} : { qualifiedCommandProvider: provider }),
  };
}

function createProvider(
  environment: NodeJS.ProcessEnv,
  options: QualifiedCommandRuntimeConfigOptions,
): OpenAIResponsesCommandProvider {
  if ((options.platform ?? process.platform) !== "win32") {
    throw new AppError(
      "POLICY_INVALID",
      "The command provider credential broker is supported only on Windows.",
    );
  }
  const model = requireValue(
    environment.VS_CODE_GPT_COMMAND_PROVIDER_MODEL,
    "VS_CODE_GPT_COMMAND_PROVIDER_MODEL",
  );
  const executablePath = requireValue(
    environment.VS_CODE_GPT_COMMAND_PROVIDER_BROKER_PATH,
    "VS_CODE_GPT_COMMAND_PROVIDER_BROKER_PATH",
  );
  const privateDirectory = requireValue(
    environment.VS_CODE_GPT_DATA_DIR,
    "VS_CODE_GPT_DATA_DIR",
  );
  if (!path.isAbsolute(executablePath)) {
    throw new AppError(
      "POLICY_INVALID",
      "The command provider broker path must be absolute.",
    );
  }
  if (!(options.fileExists ?? existsSync)(executablePath)) {
    throw new AppError(
      "POLICY_INVALID",
      "The command provider broker executable is missing.",
    );
  }
  const timeoutMs = readPositiveInteger(
    environment.VS_CODE_GPT_COMMAND_PROVIDER_TIMEOUT_MS,
    "VS_CODE_GPT_COMMAND_PROVIDER_TIMEOUT_MS",
    20_000,
  );
  const broker = new WindowsCredentialBrokerClient({
    executablePath,
    privateDirectory,
    timeoutMs,
    platform: options.platform ?? process.platform,
  });
  return new OpenAIResponsesCommandProvider({
    model,
    timeoutMs,
    apiKeySource: new WindowsCredentialManagerApiKeySource({ broker }),
  });
}

function readBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value.trim() === "") return false;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new AppError("POLICY_INVALID", `${name} must be a boolean value.`);
}

function readAllowlist(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  const entries = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (entries.some((entry) => !WORKSPACE_ID.test(entry))) {
    throw new AppError(
      "POLICY_INVALID",
      "Qualified command workspace allowlist contains an invalid identifier.",
    );
  }
  return entries;
}

function requireValue(value: string | undefined, name: string): string {
  const resolved = value?.trim();
  if (!resolved) {
    throw new AppError("POLICY_INVALID", `${name} is required.`);
  }
  return resolved;
}

function readPositiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 300_000) {
    throw new AppError(
      "POLICY_INVALID",
      `${name} must be a positive integer no greater than 300000.`,
    );
  }
  return parsed;
}
