import { createHash } from "node:crypto";
import path from "node:path";
import {
  AppError,
  WindowsCredentialBrokerClient,
} from "@vs-code-gpt/shared";
import type {
  DesktopOAuthCredentialStore,
  DesktopOAuthRefreshCredential,
} from "./desktop-oauth.js";

export interface WindowsOAuthCredentialStoreOptions {
  brokerExecutablePath: string;
  privateDirectory: string;
  edgeBaseUrl: URL;
}

export class WindowsOAuthCredentialStore implements DesktopOAuthCredentialStore {
  private readonly broker: WindowsCredentialBrokerClient;
  private readonly accountId: string;

  constructor(private readonly options: WindowsOAuthCredentialStoreOptions) {
    if (process.platform !== "win32") {
      throw new AppError("CAPABILITY_UNSUPPORTED", "Windows Credential Manager is available only on Windows.");
    }
    if (!path.isAbsolute(options.brokerExecutablePath)) {
      throw new AppError("INVALID_ARGUMENT", "Credential broker path must be absolute.");
    }
    this.accountId = `oauth-${createHash("sha256").update(options.edgeBaseUrl.origin, "utf8").digest("hex").slice(0, 24)}`;
    this.broker = new WindowsCredentialBrokerClient({
      executablePath: options.brokerExecutablePath,
      privateDirectory: options.privateDirectory,
    });
  }

  async read(): Promise<DesktopOAuthRefreshCredential | null> {
    const result = await this.broker.read({
      siteId: "mcp-v3",
      accountId: this.accountId,
    });
    if (result.status === "unavailable") return null;
    if (result.status !== "success") {
      throw new AppError("CREDENTIAL_BROKER_UNAVAILABLE", `MCP V3 credential broker returned ${result.status}.`);
    }
    const secret = result.secret;
    try {
      const descriptor: unknown = JSON.parse(secret.username.toString("utf8"));
      const refreshToken = secret.password.toString("utf8");
      if (!isRecord(descriptor) || typeof descriptor.clientId !== "string" ||
          typeof descriptor.scope !== "string" || !refreshToken) {
        throw new AppError("CREDENTIAL_BROKER_PROTOCOL_MISMATCH", "Stored MCP V3 OAuth credential is invalid.");
      }
      return {
        clientId: descriptor.clientId,
        scope: descriptor.scope,
        refreshToken,
      };
    } finally {
      secret.dispose();
    }
  }

  async write(credential: DesktopOAuthRefreshCredential): Promise<void> {
    const username = Buffer.from(JSON.stringify({
      clientId: credential.clientId,
      scope: credential.scope,
    }), "utf8");
    const password = Buffer.from(credential.refreshToken, "utf8");
    try {
      const result = await this.broker.write({
        siteId: "mcp-v3",
        accountId: this.accountId,
        username,
        password,
      });
      if (result.status !== "success") {
        throw new AppError("CREDENTIAL_BROKER_UNAVAILABLE", `MCP V3 credential broker write returned ${result.status}.`);
      }
    } finally {
      username.fill(0);
      password.fill(0);
    }
  }

  async clear(): Promise<void> {
    await this.broker.delete("mcp-v3", this.accountId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
