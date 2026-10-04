import { EdgeAccountStore } from "./account-store.js";
import { EdgeOwnerOAuth as SharedEdgeOwnerOAuth } from "@mcp-access-stack/mcp-owner-auth";
import type { EdgeOwnerOAuthConfig, OwnerOAuthStorage } from "@mcp-access-stack/mcp-owner-auth";

export type { EdgeOwnerOAuthConfig, OwnerOAuthStorage } from "@mcp-access-stack/mcp-owner-auth";

export class EdgeOwnerOAuth extends SharedEdgeOwnerOAuth {
  constructor(storage: OwnerOAuthStorage, config: EdgeOwnerOAuthConfig) {
    super(storage, config, new EdgeAccountStore(storage));
  }
}
