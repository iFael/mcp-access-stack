import { describe, expect, it } from "@jest/globals";
import { InMemoryOAuthClientsStore } from "../../../src/auth/owner-provider.js";

function registerRedirect(redirectUri: string, allowedRedirectHosts = ["mcp.example.com"]) {
  const store = new InMemoryOAuthClientsStore(allowedRedirectHosts);
  return store.registerClient({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

describe("Owner OAuth redirect policy", () => {
  it("accepts the official ChatGPT connector callback without allowlisting chatgpt.com broadly", () => {
    const client = registerRedirect("https://chatgpt.com/connector/oauth/callback-123");
    expect(client.redirect_uris).toEqual(["https://chatgpt.com/connector/oauth/callback-123"]);
  });

  it.each([
    "http://chatgpt.com/connector/oauth/callback-123",
    "https://www.chatgpt.com/connector/oauth/callback-123",
    "https://chatgpt.com/connector/oauth/",
    "https://chatgpt.com/connector/oauth/callback-123/extra",
    "https://chatgpt.com/connector/oauth/callback-123?next=https://evil.example",
    "https://chatgpt.com/connector/oauth/callback-123#fragment",
    "https://chatgpt.com/other/oauth/callback-123",
    "https://chatgpt.com.evil.example/connector/oauth/callback-123",
  ])("rejects non-canonical ChatGPT redirect %s", (redirectUri) => {
    expect(() => registerRedirect(redirectUri)).toThrow(/redirect_uri is not allowed/u);
  });

  it("preserves configured redirect hosts for non-ChatGPT clients", () => {
    const client = registerRedirect("https://mcp.example.com/oauth/callback");
    expect(client.redirect_uris).toEqual(["https://mcp.example.com/oauth/callback"]);
  });
});
