import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { AppError } from "@vs-code-gpt/shared";
import type {
  DesktopOAuthCredentialStore,
  DesktopOAuthRefreshCredential,
} from "./desktop-oauth.js";
import { WindowsOAuthCredentialStore } from "./windows-oauth-credential-store.js";

const SECRET_COMMAND_TIMEOUT_MS = 15_000;
const SERVICE_PREFIX = "MCP V3 OAuth";

export interface PlatformOAuthCredentialStoreOptions {
  platform?: NodeJS.Platform;
  edgeBaseUrl: URL;
  privateDirectory: string;
  credentialBrokerPath: string;
  runCommand?: SecretCommandRunner;
}

export interface SecretCommandRequest {
  file: string;
  args: readonly string[];
  stdin?: string;
}

export interface SecretCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type SecretCommandRunner = (
  request: SecretCommandRequest,
) => Promise<SecretCommandResult>;

export function createPlatformOAuthCredentialStore(
  options: PlatformOAuthCredentialStoreOptions,
): DesktopOAuthCredentialStore {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return new WindowsOAuthCredentialStore({
      brokerExecutablePath: options.credentialBrokerPath,
      privateDirectory: options.privateDirectory,
      edgeBaseUrl: options.edgeBaseUrl,
    });
  }

  const accountId = oauthAccountId(options.edgeBaseUrl);
  const runCommand = options.runCommand ?? runSecretCommand;
  if (platform === "darwin") {
    return new MacOSKeychainOAuthCredentialStore(accountId, runCommand);
  }
  if (platform === "linux") {
    return new LinuxSecretServiceOAuthCredentialStore(accountId, runCommand);
  }
  throw new AppError(
    "CAPABILITY_UNSUPPORTED",
    `MCP V3 secure credential storage is not implemented for ${platform}.`,
  );
}

export class LinuxSecretServiceOAuthCredentialStore
implements DesktopOAuthCredentialStore {
  constructor(
    private readonly accountId: string,
    private readonly runCommand: SecretCommandRunner = runSecretCommand,
  ) {}

  async read(): Promise<DesktopOAuthRefreshCredential | null> {
    const result = await this.runCommand({
      file: "secret-tool",
      args: ["lookup", "service", "mcp-v3", "account", this.accountId],
    });
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0) {
      throw secretStoreError("Linux Secret Service lookup failed.", result);
    }
    const value = result.stdout.replace(/[\r\n]+$/u, "");
    if (!value) return null;
    return parseCredential(value);
  }

  async write(credential: DesktopOAuthRefreshCredential): Promise<void> {
    const result = await this.runCommand({
      file: "secret-tool",
      args: [
        "store",
        `--label=${SERVICE_PREFIX}`,
        "service",
        "mcp-v3",
        "account",
        this.accountId,
      ],
      stdin: serializeCredential(credential),
    });
    if (result.exitCode !== 0) {
      throw secretStoreError("Linux Secret Service write failed.", result);
    }
  }

  async clear(): Promise<void> {
    const result = await this.runCommand({
      file: "secret-tool",
      args: ["clear", "service", "mcp-v3", "account", this.accountId],
    });
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw secretStoreError("Linux Secret Service delete failed.", result);
    }
  }
}

export class MacOSKeychainOAuthCredentialStore
implements DesktopOAuthCredentialStore {
  private readonly service: string;

  constructor(
    private readonly accountId: string,
    private readonly runCommand: SecretCommandRunner = runSecretCommand,
  ) {
    this.service = `${SERVICE_PREFIX} ${accountId}`;
  }

  async read(): Promise<DesktopOAuthRefreshCredential | null> {
    const result = await this.runCommand({
      file: "security",
      args: [
        "find-generic-password",
        "-a",
        this.accountId,
        "-s",
        this.service,
        "-w",
      ],
    });
    if (result.exitCode !== 0) {
      if (isMacKeychainMissing(result)) return null;
      throw secretStoreError("macOS Keychain lookup failed.", result);
    }
    const value = result.stdout.replace(/[\r\n]+$/u, "");
    if (!value) return null;
    return parseCredential(value);
  }

  async write(credential: DesktopOAuthRefreshCredential): Promise<void> {
    const secret = serializeCredential(credential);
    const result = await this.runCommand({
      file: "security",
      args: [
        "add-generic-password",
        "-a",
        this.accountId,
        "-s",
        this.service,
        "-U",
        "-w",
      ],
      stdin: secret + "\n",
    });
    if (result.exitCode !== 0) {
      throw secretStoreError("macOS Keychain write failed.", result);
    }
  }

  async clear(): Promise<void> {
    const result = await this.runCommand({
      file: "security",
      args: [
        "delete-generic-password",
        "-a",
        this.accountId,
        "-s",
        this.service,
      ],
    });
    if (result.exitCode !== 0 && !isMacKeychainMissing(result)) {
      throw secretStoreError("macOS Keychain delete failed.", result);
    }
  }
}

function oauthAccountId(edgeBaseUrl: URL): string {
  return `oauth-${createHash("sha256")
    .update(edgeBaseUrl.origin, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

function serializeCredential(
  credential: DesktopOAuthRefreshCredential,
): string {
  return JSON.stringify({
    clientId: credential.clientId,
    scope: credential.scope,
    refreshToken: credential.refreshToken,
  });
}

function parseCredential(value: string): DesktopOAuthRefreshCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new AppError(
      "CREDENTIAL_BROKER_PROTOCOL_MISMATCH",
      "Stored MCP V3 OAuth credential is invalid.",
      { cause: error },
    );
  }
  if (!isRecord(parsed) ||
      typeof parsed.clientId !== "string" ||
      !parsed.clientId ||
      typeof parsed.scope !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      !parsed.refreshToken) {
    throw new AppError(
      "CREDENTIAL_BROKER_PROTOCOL_MISMATCH",
      "Stored MCP V3 OAuth credential is invalid.",
    );
  }
  return {
    clientId: parsed.clientId,
    scope: parsed.scope,
    refreshToken: parsed.refreshToken,
  };
}

async function runSecretCommand(
  request: SecretCommandRequest,
): Promise<SecretCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.file, [...request.args], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (
      error?: unknown,
      result?: SecretCommandResult,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already stopped */ }
      finish(new AppError(
        "CREDENTIAL_BROKER_UNAVAILABLE",
        `MCP V3 secure-store command timed out: ${request.file}`,
      ));
    }, SECRET_COMMAND_TIMEOUT_MS);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 256_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => finish(new AppError(
      "CREDENTIAL_BROKER_UNAVAILABLE",
      `MCP V3 secure-store command is unavailable: ${request.file}`,
      { cause: error },
    )));
    child.once("close", (exitCode) => finish(undefined, {
      exitCode,
      stdout,
      stderr,
    }));

    if (request.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(request.stdin, "utf8");
    }
  });
}

function isMacKeychainMissing(result: SecretCommandResult): boolean {
  if (result.exitCode === 44) return true;
  const detail = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return detail.includes("could not be found") ||
    detail.includes("the specified item could not be found");
}

function secretStoreError(
  message: string,
  result: SecretCommandResult,
): AppError {
  const diagnostic = result.stderr.trim();
  return new AppError(
    "CREDENTIAL_BROKER_UNAVAILABLE",
    diagnostic ? `${message} ${diagnostic}` : message,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value);
}
