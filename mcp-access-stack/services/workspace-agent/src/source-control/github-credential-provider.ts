import type { OperationContext } from "@vs-code-gpt/shared";

export interface GitHubCredential {
  readonly token: string;
  readonly source: "gh-cli-user" | "git-credential-user" | "github-app-installation" | "account-provisioning";
}

export interface GitHubCredentialProvider {
  getCredential(context?: OperationContext): Promise<GitHubCredential>;
}
