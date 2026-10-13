import type {GitHubGetRepositoryInput, GitHubGetCommitChecksInput,
  GitHubCommitChecksResult,OperationContext} from "@vs-code-gpt/shared";
import type {LocalAgent} from "../local-agent.js";

type ReadHost=Pick<LocalAgent,"releaseReadGitHubMainHead"|"githubGetCommitChecks">;
export interface OracleReleaseGitHubReadConfig {
  readonly workspaceId:"mcp-access-stack";
  readonly owner:string;
  readonly repository:string;
  /** Bound to an authenticated MCP host identity, never a release-run field. */
  readonly ownerScope:string;
  readonly root?:string;
}
const SHA=/^[a-f0-9]{40}$/u;
const OWNER=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u;
const REPOSITORY=/^[A-Za-z0-9._-]{1,100}$/u;

/**
 * Reuses the MCP V3 authenticated, audited repository-reader methods.
 * No shell, generic HTTP client or token belongs to the Oracle ledger.
 * A separate authenticated bridge is still required before this port can
 * be injected into the remote Oracle One-writer process.
 */
export function createOracleReleaseGitHubReadPort(
  host:ReadHost,config:OracleReleaseGitHubReadConfig,
){
  if(config.workspaceId!=="mcp-access-stack" ||
    !OWNER.test(config.owner) || !REPOSITORY.test(config.repository) ||
    config.repository==="." || config.repository===".." ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(config.ownerScope) ||
    (config.root!==undefined && (config.root.length===0 || config.root.length>4096))) {
    throw new Error("ORACLE_RELEASE_GITHUB_READ_CONFIG_INVALID");
  }
  const repo:GitHubGetRepositoryInput={
    workspaceId:config.workspaceId,
    owner:config.owner,repository:config.repository,
    ...(config.root===undefined?{}:{root:config.root}),
  };
  const context:OperationContext={ownerScope:config.ownerScope};
  return {
    async readMainHead():Promise<string>{
      const sha=await host.releaseReadGitHubMainHead(repo,context);
      if(!SHA.test(sha))throw new Error("ORACLE_RELEASE_MAIN_SHA_UNVERIFIED");
      return sha;
    },
    async readCommitChecks(commitSha:string){
      if(!SHA.test(commitSha))throw new Error("ORACLE_RELEASE_CHECKS_SHA_INVALID");
      const input:GitHubGetCommitChecksInput={...repo,commitSha};
      const result:GitHubCommitChecksResult=await host.githubGetCommitChecks(input,context);
      if(result.commitSha!==commitSha || result.owner!==repo.owner ||
          result.repository!==repo.repository ||
          result.returnedCount!==result.checks.length ||
          result.totalCount<result.returnedCount ||
          result.truncated!== (result.totalCount>result.returnedCount)) {
        throw new Error("ORACLE_RELEASE_GITHUB_CHECKS_UNVERIFIED");
      }
      return {
        commitSha:result.commitSha,
        totalCount:result.totalCount,
        returnedCount:result.returnedCount,
        pendingCount:result.pendingCount,
        successfulCount:result.successfulCount,
        failingCount:result.failingCount,
        allCompleted:result.allCompleted,
        truncated:result.truncated,
        passed:result.passed,
        checks:result.checks.map(check=>({
          id:check.id,name:check.name,status:check.status,conclusion:check.conclusion,
        })),
      };
    },
  };
}
