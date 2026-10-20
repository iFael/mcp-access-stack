import {
  githubWorkflowOperationInputSchema,
  githubWorkflowOperationResultSchema,
  type GitHubGetRepositoryInput,
  type GitHubWorkflowOperationInput,
  type OperationContext,
} from "@vs-code-gpt/shared";
import type {LocalAgent} from "../local-agent.js";
import {assertOracleReleaseGitHubConfig,
  type OracleReleaseGitHubReadConfig} from "./oracle-github-read-port.js";

type WorkflowHost=Pick<LocalAgent,"githubWorkflowOperation"|"releaseVerifyGitHubLightweightTag"|"releaseInspectGitHubPublicDistribution">;
type WorkflowInput=Omit<GitHubWorkflowOperationInput,"root">;
export interface OracleReleaseGitHubWorkflowPolicy {
  /** Distinct host-owned release gate, rechecked for dispatch and reconcile. */
  authorizeWorkflow(input:GitHubWorkflowOperationInput):Promise<boolean>;
  authorizeTagRead(tag:string,sha:string):Promise<boolean>;
  authorizeDistribution(runId:number,tag:string,sha:string):Promise<boolean>;
}

/** Host-local provider for the existing Oracle bootstrap/publication workflow
 * contracts. All dispatch/reconciliation stays in LocalAgent's audited GitHub
 * operation and mutation receipt store. An Oracle WSS bridge and independent
 * signed-artifact verification are still required before enabling this port. */
export function createOracleReleaseGitHubWorkflowPort(
  host:WorkflowHost,config:OracleReleaseGitHubReadConfig,
  policy:OracleReleaseGitHubWorkflowPolicy,
){
  assertOracleReleaseGitHubConfig(config);
  if(!policy || typeof policy.authorizeWorkflow!=="function" ||
      typeof policy.authorizeTagRead!=="function" ||
      typeof policy.authorizeDistribution!=="function") {
    throw new Error("ORACLE_RELEASE_WORKFLOW_POLICY_REQUIRED");
  }
  const context:OperationContext={ownerScope:config.ownerScope};
  const repo:GitHubGetRepositoryInput={
    workspaceId:config.workspaceId,owner:config.owner,repository:config.repository,
    ...(config.root===undefined?{}:{root:config.root}),
  };
  return {
    async workflowOperation(input:WorkflowInput){
      if(input.workspaceId!==config.workspaceId ||
          input.owner!==config.owner || input.repository!==config.repository ||
          !["release.yml","release-tag-bootstrap.yml"].includes(input.workflow)){
        throw new Error("ORACLE_RELEASE_WORKFLOW_IDENTITY_INVALID");
      }
      // The caller must not select another workspace root or inherit a broader
      // repo policy: only the authenticated host supplies root and ownerScope.
      if(Object.hasOwn(input,"root")) {
        throw new Error("ORACLE_RELEASE_WORKFLOW_ROOT_NOT_HOST_OWNED");
      }
      const parsed=githubWorkflowOperationInputSchema.parse({
        ...input,...(config.root===undefined?{}:{root:config.root}),
      });
      if(!await policy.authorizeWorkflow(parsed)) {
        throw new Error("ORACLE_RELEASE_WORKFLOW_NOT_AUTHORIZED");
      }
      const output=githubWorkflowOperationResultSchema.parse(
        await host.githubWorkflowOperation(parsed,context),
      );
      if(output.operationId!==parsed.operationId){
        throw new Error("ORACLE_RELEASE_WORKFLOW_RECEIPT_MISMATCH");
      }
      return output;
    },
    async inspectDistribution(runId:number,tag:string,commitSha:string){
      if(!Number.isSafeInteger(runId) || runId<1 ||
         !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(tag) ||
         tag.includes("-oracle.") || tag.includes("-companion.") ||
         !/^[a-f0-9]{40}$/u.test(commitSha))
        throw new Error("ORACLE_RELEASE_DISTRIBUTION_IDENTITY_INVALID");
      if(!await policy.authorizeDistribution(runId,tag,commitSha))
        throw new Error("ORACLE_RELEASE_DISTRIBUTION_NOT_AUTHORIZED");
      const result=await host.releaseInspectGitHubPublicDistribution(repo,runId,tag,commitSha,context);
      if(result.workflowRunId!==runId || result.releaseTag!==tag ||
         result.sourceCommitSha!==commitSha || !result.integrityVerified ||
         !result.releasePublished || result.verifiedAssetCount!==5 ||
         !/^[a-f0-9]{64}$/u.test(result.assetInventorySha256))
        throw new Error("ORACLE_RELEASE_DISTRIBUTION_PROOF_INVALID");
      return result;
    },
    async verifyLightweightTag(tag:string,commitSha:string){
      if(!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(tag) ||
          tag.includes("-oracle.") || tag.includes("-companion.") ||
          !/^[a-f0-9]{40}$/u.test(commitSha)){
        throw new Error("ORACLE_RELEASE_TAG_IDENTITY_INVALID");
      }
      if(!await policy.authorizeTagRead(tag,commitSha)) {
        throw new Error("ORACLE_RELEASE_TAG_READ_NOT_AUTHORIZED");
      }
      return host.releaseVerifyGitHubLightweightTag(repo,tag,commitSha,context);
    },
  };
}
