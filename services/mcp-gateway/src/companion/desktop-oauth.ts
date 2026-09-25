import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { AppError } from "@vs-code-gpt/shared";

const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const ACCESS_TOKEN_SKEW_MS = 30_000;

export type DesktopOAuthRefreshCredential = {
  clientId: string;
  scope: string;
  refreshToken: string;
};

export interface DesktopOAuthCredentialStore {
  read(): Promise<DesktopOAuthRefreshCredential | null>;
  write(credential: DesktopOAuthRefreshCredential): Promise<void>;
  clear(): Promise<void>;
}

export type DesktopOAuthAccessToken = {
  accessToken: string;
  scope: string;
  expiresAtMs: number;
};

export interface DesktopOAuthClientOptions {
  edgeBaseUrl: URL;
  credentialStore: DesktopOAuthCredentialStore;
  fetchImpl?: typeof fetch;
  openBrowser?: (url: URL) => Promise<void>;
  now?: () => number;
}

export class DesktopOAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly openBrowser: (url: URL) => Promise<void>;
  private readonly now: () => number;
  private session: DesktopOAuthAccessToken | null = null;

  constructor(private readonly options: DesktopOAuthClientOptions) {
    assertEdgeOrigin(options.edgeBaseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.openBrowser = options.openBrowser ?? openExternalUrl;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(signal?: AbortSignal): Promise<DesktopOAuthAccessToken> {
    throwIfAborted(signal);
    if (this.session && this.session.expiresAtMs - ACCESS_TOKEN_SKEW_MS > this.now()) {
      return { ...this.session };
    }

    const persisted = await this.options.credentialStore.read();
    throwIfAborted(signal);
    if (persisted) {
      try {
        return await this.refresh(persisted, signal);
      } catch (error) {
        this.session = null;
        if (signal?.aborted) throw error;
        await this.options.credentialStore.clear().catch(() => undefined);
      }
    }

    return this.authorizeInteractive(signal);
  }

  invalidateAccessToken(): void {
    this.session = null;
  }

  async clearAuthorization(): Promise<void> {
    this.session = null;
    await this.options.credentialStore.clear();
  }

  private async refresh(
    persisted: DesktopOAuthRefreshCredential,
    signal?: AbortSignal,
  ): Promise<DesktopOAuthAccessToken> {
    const resource = new URL("/mcp", this.options.edgeBaseUrl).href;
    const response = await this.fetchImpl(new URL("/token", this.options.edgeBaseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: persisted.clientId,
        refresh_token: persisted.refreshToken,
        scope: persisted.scope,
        resource,
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      throw new AppError("AUTHENTICATION_REQUIRED", "Stored MCP V3 authorization could not be refreshed.");
    }
    const tokens = parseTokenResponse(await response.json());
    const credential: DesktopOAuthRefreshCredential = {
      clientId: persisted.clientId,
      scope: tokens.scope || persisted.scope,
      refreshToken: tokens.refresh_token,
    };
    await this.options.credentialStore.write(credential);
    this.session = {
      accessToken: tokens.access_token,
      scope: credential.scope,
      expiresAtMs: this.now() + tokens.expires_in * 1000,
    };
    return { ...this.session };
  }

  private async authorizeInteractive(signal?: AbortSignal): Promise<DesktopOAuthAccessToken> {
    throwIfAborted(signal);
    const callback = await createLoopbackCallback(signal);
    try {
      const redirectUri = callback.redirectUri.href;
      const registrationResponse = await this.fetchImpl(new URL("/register", this.options.edgeBaseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "MCP V3",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!registrationResponse.ok) {
        throw new AppError("AUTHENTICATION_FAILED", "MCP V3 OAuth client registration failed.");
      }
      const registration = await registrationResponse.json() as unknown;
      if (!isRecord(registration) || typeof registration.client_id !== "string" || !registration.client_id) {
        throw new AppError("AUTHENTICATION_FAILED", "MCP V3 OAuth client registration response is invalid.");
      }
      const clientId = registration.client_id;

      const metadataResponse = await this.fetchImpl(
        new URL("/.well-known/oauth-authorization-server", this.options.edgeBaseUrl),
        signal === undefined ? {} : { signal },
      );
      if (!metadataResponse.ok) {
        throw new AppError("AUTHENTICATION_FAILED", "MCP V3 OAuth metadata is unavailable.");
      }
      const metadata = await metadataResponse.json() as unknown;
      const scopes = isRecord(metadata) && Array.isArray(metadata.scopes_supported)
        ? metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string")
        : [];
      const scope = scopes.includes("workspaces:read") ? "workspaces:read" : scopes[0];
      if (!scope) {
        throw new AppError("AUTHENTICATION_FAILED", "MCP V3 OAuth server did not advertise a usable scope.");
      }

      const verifier = randomBytes(48).toString("base64url");
      const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
      const state = randomBytes(24).toString("base64url");
      const resource = new URL("/mcp", this.options.edgeBaseUrl).href;
      const authorizeUrl = new URL("/authorize", this.options.edgeBaseUrl);
      authorizeUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope,
        state,
        resource,
      }).toString();

      const codePromise = callback.waitForCode(state, signal);
      await this.openBrowser(authorizeUrl);
      const code = await codePromise;
      const tokenResponse = await this.fetchImpl(new URL("/token", this.options.edgeBaseUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource,
        }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!tokenResponse.ok) {
        throw new AppError("AUTHENTICATION_FAILED", "MCP V3 OAuth authorization code exchange failed.");
      }
      const tokens = parseTokenResponse(await tokenResponse.json());
      const credential: DesktopOAuthRefreshCredential = {
        clientId,
        scope: tokens.scope || scope,
        refreshToken: tokens.refresh_token,
      };
      await this.options.credentialStore.write(credential);
      this.session = {
        accessToken: tokens.access_token,
        scope: credential.scope,
        expiresAtMs: this.now() + tokens.expires_in * 1000,
      };
      return { ...this.session };
    } finally {
      await callback.close();
    }
  }
}


type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
};

type LoopbackCallback = {
  redirectUri: URL;
  waitForCode(expectedState: string, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
};

async function createLoopbackCallback(signal?: AbortSignal): Promise<LoopbackCallback> {
  throwIfAborted(signal);
  let resolveCode!: (value: string) => void;
  let rejectCode!: (error: Error) => void;
  let expectedState = "";
  let settled = false;
  const result = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Not found");
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const oauthError = url.searchParams.get("error");
    if (!expectedState || state !== expectedState || !code || oauthError) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end("<!doctype html><html><body><h1>MCP V3</h1><p>Authorization was not accepted.</p></body></html>");
      if (!settled) {
        settled = true;
        rejectCode(new AppError("AUTHENTICATION_FAILED", "MCP V3 OAuth callback validation failed."));
      }
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><html><body><h1>MCP V3 conectado</h1><p>Voce pode fechar esta janela.</p></body></html>");
    if (!settled) {
      settled = true;
      resolveCode(code);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new AppError("AUTHENTICATION_FAILED", "MCP V3 OAuth callback listener did not expose a TCP port.");
  }

  return {
    redirectUri: new URL(`http://127.0.0.1:${address.port}/callback`),
    async waitForCode(state: string, requestSignal?: AbortSignal): Promise<string> {
      expectedState = state;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("oauth_timeout"), OAUTH_CALLBACK_TIMEOUT_MS);
      timeout.unref();
      const abortFromCaller = () => controller.abort(requestSignal?.reason ?? "cancelled");
      requestSignal?.addEventListener("abort", abortFromCaller, { once: true });
      try {
        return await Promise.race([
          result,
          new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => reject(new AppError(
              requestSignal?.aborted ? "OPERATION_CANCELLED" : "AUTHENTICATION_FAILED",
              requestSignal?.aborted
                ? "MCP V3 OAuth authorization was cancelled."
                : "MCP V3 OAuth authorization timed out.",
            )), { once: true });
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        requestSignal?.removeEventListener("abort", abortFromCaller);
      }
    },
    close: () => closeServer(server),
  };
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!isRecord(value) ||
      typeof value.access_token !== "string" || value.access_token.length < 16 ||
      typeof value.refresh_token !== "string" || value.refresh_token.length < 16 ||
      typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0 ||
      typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer" ||
      (value.scope !== undefined && typeof value.scope !== "string")) {
    throw new AppError("AUTHENTICATION_FAILED", "MCP V3 OAuth token response is invalid.");
  }
  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_in: value.expires_in,
    token_type: value.token_type,
    scope: typeof value.scope === "string" ? value.scope : "",
  };
}

async function openExternalUrl(url: URL): Promise<void> {
  const command = process.platform === "win32"
    ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url.href] }
    : process.platform === "darwin"
      ? { file: "open", args: [url.href] }
      : { file: "xdg-open", args: [url.href] };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function assertEdgeOrigin(url: URL): void {
  if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new AppError("INVALID_ARGUMENT", "MCP V3 Edge base URL must be a credential-free HTTPS origin.");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError("OPERATION_CANCELLED", "MCP V3 operation was cancelled.");
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
