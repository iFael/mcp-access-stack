import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { OwnerOAuthProvider, type OwnerOAuthConfig } from "../../../src/auth/owner-provider.js";

const resourceUrl = new URL("https://mcp.example.com/mcp");
const ownerToken = "owner-secret-that-must-never-be-persisted";

function config(statePath: string): OwnerOAuthConfig {
  return {
    ownerToken,
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86_400,
    scopes: ["workspaces:read"],
    allowedRedirectHosts: ["chatgpt.com"],
    statePath,
    resourceName: "MCP Test",
  };
}

async function registerChatGptClient(provider: OwnerOAuthProvider) {
  return await provider.clientsStore.registerClient?.({
    redirect_uris: ["https://chatgpt.com/aip/oauth/callback"],
    client_name: "ChatGPT",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

function issueTokensForTest(
  provider: OwnerOAuthProvider,
  clientId: string,
): OAuthTokens {
  const issueTokens = (
    provider as unknown as {
      issueTokens(clientId: string, scopes: string[], resource?: URL): OAuthTokens;
    }
  ).issueTokens.bind(provider);
  return issueTokens(clientId, ["workspaces:read"], resourceUrl);
}

describe("OwnerOAuthProvider persistence", () => {
  let root: string;
  let statePath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mcp-owner-oauth-"));
    statePath = path.join(root, "owner-oauth-state.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves registered clients and hashed access/refresh tokens across restart", async () => {
    const first = new OwnerOAuthProvider(config(statePath), resourceUrl);
    const client = await registerChatGptClient(first);
    expect(client).toBeDefined();
    const tokens = issueTokensForTest(first, client!.client_id);
    expect(tokens.refresh_token).toBeDefined();

    const persisted = readFileSync(statePath, "utf8");
    expect(persisted).not.toContain(ownerToken);
    expect(persisted).not.toContain(tokens.access_token);
    expect(persisted).not.toContain(tokens.refresh_token!);
    expect(persisted).toContain('"hash"');

    const second = new OwnerOAuthProvider(config(statePath), resourceUrl);
    const restoredClient = await second.clientsStore.getClient(client!.client_id);
    expect(restoredClient?.client_id).toBe(client!.client_id);

    const accessInfo = await second.verifyAccessToken(tokens.access_token);
    expect(accessInfo.clientId).toBe(client!.client_id);
    expect(accessInfo.scopes).toEqual(["workspaces:read"]);

    const refreshed = await second.exchangeRefreshToken(
      restoredClient!,
      tokens.refresh_token!,
      undefined,
      resourceUrl,
    );
    expect(refreshed.refresh_token).toBeDefined();

    const third = new OwnerOAuthProvider(config(statePath), resourceUrl);
    await expect(third.verifyAccessToken(refreshed.access_token)).resolves.toMatchObject({
      clientId: client!.client_id,
      scopes: ["workspaces:read"],
    });
    await expect(
      third.exchangeRefreshToken(restoredClient!, tokens.refresh_token!, undefined, resourceUrl),
    ).rejects.toThrow(/Invalid refresh token/u);
  });

  it("fails closed when persisted state belongs to another MCP resource", async () => {
    const first = new OwnerOAuthProvider(config(statePath), resourceUrl);
    const client = await registerChatGptClient(first);
    issueTokensForTest(first, client!.client_id);

    expect(
      () => new OwnerOAuthProvider(config(statePath), new URL("https://other.example.com/mcp")),
    ).toThrow(/different MCP resource/u);
  });
});