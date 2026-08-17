import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const STATE_VERSION = 1;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_CLIENTS = 256;
const MAX_TOKENS_PER_KIND = 4096;
const TOKEN_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface PersistedOwnerOAuthTokenRecord {
  hash: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface OwnerOAuthStateSnapshot {
  clients: OAuthClientInformationFull[];
  accessTokens: PersistedOwnerOAuthTokenRecord[];
  refreshTokens: PersistedOwnerOAuthTokenRecord[];
}

interface SerializedOwnerOAuthState extends OwnerOAuthStateSnapshot {
  version: number;
  resourceServerUrl: string;
}

export class OwnerOAuthStateStore {
  readonly path: string;

  constructor(
    statePath: string,
    private readonly resourceServerUrl: URL,
  ) {
    this.path = path.resolve(statePath);
  }

  load(): OwnerOAuthStateSnapshot {
    let raw: string;
    try {
      const info = statSync(this.path);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_STATE_BYTES) {
        throw new Error("Owner OAuth state file size is invalid.");
      }
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return emptySnapshot();
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("Owner OAuth state file contains invalid JSON.");
    }
    if (!isRecord(parsed)) {
      throw new Error("Owner OAuth state file must contain an object.");
    }
    if (parsed.version !== STATE_VERSION) {
      throw new Error("Owner OAuth state file version is unsupported.");
    }
    if (parsed.resourceServerUrl !== this.resourceServerUrl.href) {
      throw new Error("Owner OAuth state belongs to a different MCP resource.");
    }

    const clients = readClients(parsed.clients);
    const accessTokens = readTokenRecords(parsed.accessTokens, "accessTokens");
    const refreshTokens = readTokenRecords(parsed.refreshTokens, "refreshTokens");
    return { clients, accessTokens, refreshTokens };
  }

  save(snapshot: OwnerOAuthStateSnapshot): void {
    if (snapshot.clients.length > MAX_CLIENTS) {
      throw new Error("Owner OAuth state exceeds the client limit.");
    }
    if (
      snapshot.accessTokens.length > MAX_TOKENS_PER_KIND ||
      snapshot.refreshTokens.length > MAX_TOKENS_PER_KIND
    ) {
      throw new Error("Owner OAuth state exceeds the token limit.");
    }

    const serialized: SerializedOwnerOAuthState = {
      version: STATE_VERSION,
      resourceServerUrl: this.resourceServerUrl.href,
      clients: snapshot.clients,
      accessTokens: snapshot.accessTokens,
      refreshTokens: snapshot.refreshTokens,
    };
    const content = `${JSON.stringify(serialized, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_STATE_BYTES) {
      throw new Error("Owner OAuth state exceeds the file size limit.");
    }

    const directory = path.dirname(this.path);
    mkdirSync(directory, { recursive: true });
    const temporary = path.join(
      directory,
      `.${path.basename(this.path)}.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      writeFileSync(temporary, content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

function emptySnapshot(): OwnerOAuthStateSnapshot {
  return { clients: [], accessTokens: [], refreshTokens: [] };
}

function readClients(value: unknown): OAuthClientInformationFull[] {
  if (!Array.isArray(value) || value.length > MAX_CLIENTS) {
    throw new Error("Owner OAuth state clients collection is invalid.");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("Owner OAuth state contains an invalid client record.");
    }
    if (
      typeof entry.client_id !== "string" ||
      entry.client_id.length === 0 ||
      typeof entry.client_id_issued_at !== "number" ||
      !Number.isSafeInteger(entry.client_id_issued_at) ||
      !Array.isArray(entry.redirect_uris) ||
      entry.redirect_uris.length === 0 ||
      !entry.redirect_uris.every((uri) => typeof uri === "string" && isAbsoluteUrl(uri)) ||
      entry.client_secret !== undefined ||
      (entry.token_endpoint_auth_method !== undefined && entry.token_endpoint_auth_method !== "none")
    ) {
      throw new Error("Owner OAuth state contains an invalid client identity.");
    }
    return entry as unknown as OAuthClientInformationFull;
  });
}

function readTokenRecords(value: unknown, name: string): PersistedOwnerOAuthTokenRecord[] {
  if (!Array.isArray(value) || value.length > MAX_TOKENS_PER_KIND) {
    throw new Error(`Owner OAuth state ${name} collection is invalid.`);
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error(`Owner OAuth state ${name} contains an invalid record.`);
    }
    if (
      typeof entry.hash !== "string" ||
      !TOKEN_HASH_PATTERN.test(entry.hash) ||
      typeof entry.clientId !== "string" ||
      entry.clientId.length === 0 ||
      !Array.isArray(entry.scopes) ||
      entry.scopes.length > 64 ||
      !entry.scopes.every((scope) => typeof scope === "string" && scope.length > 0) ||
      typeof entry.expiresAt !== "number" ||
      !Number.isSafeInteger(entry.expiresAt) ||
      entry.expiresAt <= 0 ||
      (entry.resource !== undefined &&
        (typeof entry.resource !== "string" || !isAbsoluteUrl(entry.resource)))
    ) {
      throw new Error(`Owner OAuth state ${name} contains invalid token metadata.`);
    }
    return {
      hash: entry.hash,
      clientId: entry.clientId,
      scopes: [...entry.scopes] as string[],
      expiresAt: entry.expiresAt as number,
      ...(entry.resource === undefined ? {} : { resource: entry.resource as string }),
    };
  });
}

function isAbsoluteUrl(value: string): boolean {
  try {
    return new URL(value).href === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
