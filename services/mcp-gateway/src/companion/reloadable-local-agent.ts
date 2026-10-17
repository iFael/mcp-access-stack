import type {OracleWorkflowProviderPort} from "../edge/oracle-workflow-provider.js";
import {
  AppError,
  TypedConfirmationRegistry,
  type PolicyFile,
  type SourceControlExecutor,
  type WorkspaceExecutor,
} from "@vs-code-gpt/shared";
import {
  CommandConfirmationRegistry,
  InProcessWorkspaceExecutor,
  LocalAgent,
  type LocalAgentOptions,
  createOracleReleaseGitHubReadPort,
  createOracleCandidateReadPort,
  type OracleCandidateHostConfig,
  type OracleCandidateReadResult,
  createOracleReleaseGitHubWorkflowPort,
  type OracleReleaseGitHubWorkflowPolicy,
  type OracleReleaseGitHubReadConfig,
} from "@vs-code-gpt/local-agent";

export class ReloadableLocalAgent {
  private current: InProcessWorkspaceExecutor | null = null;
  private currentAgent:LocalAgent|null=null;
  private generation = 0;
  private readonly options: LocalAgentOptions;
  readonly workspaceExecutor: WorkspaceExecutor;
  readonly sourceControlExecutor: SourceControlExecutor;

  constructor(options: LocalAgentOptions = {}) {
    this.options = {
      ...options,
      commandConfirmationRegistry:
        options.commandConfirmationRegistry ?? new CommandConfirmationRegistry(),
      typedConfirmationRegistry:
        options.typedConfirmationRegistry ?? new TypedConfirmationRegistry(),
    };
    const proxy = new Proxy({} as InProcessWorkspaceExecutor, {
      get: (_target, property) => {
        if (property === "listWorkspaces" && this.current === null) {
          return async () => [];
        }
        if (property === "resolveWorkspaceConcurrencyKey" && this.current === null) {
          return (workspaceId: string) => `unavailable:${workspaceId}`;
        }
        const active = this.current;
        if (!active) {
          return (..._args: unknown[]) => {
            throw new AppError("WORKSPACE_NOT_FOUND", "No local MCP V3 repository is materialized on this device.");
          };
        }
        const value = Reflect.get(active, property);
        return typeof value === "function" ? value.bind(active) : value;
      },
    });
    this.workspaceExecutor = proxy;
    this.sourceControlExecutor = proxy;
  }

  /** Read port follows policy reload and discards observations that finish
   * after policy revocation. Never capture a stale LocalAgent. */
  oracleSourceReadPort(config:OracleReleaseGitHubReadConfig){
    const checked=async<T>(operation:(agent:LocalAgent)=>Promise<T>):Promise<T>=>{
      const active=this.currentAgent,epoch=this.generation;
      if(!active)throw new AppError("WORKSPACE_NOT_FOUND","Oracle source host offline.");
      const result=await operation(active);
      if(epoch!==this.generation || this.currentAgent!==active){
        throw new AppError("PERMISSION_DENIED","Oracle source policy changed during read.");
      }
      return result;
    };
    return createOracleReleaseGitHubReadPort({
      releaseReadGitHubMainHead:(input,context)=>checked(agent=>
        agent.releaseReadGitHubMainHead(input,context)),
      githubGetCommitChecks:(input,context)=>checked(agent=>
        agent.githubGetCommitChecks(input,context)),
    },config);
  }

  /** Confidential read-only candidate port. No WSS or public MCP exposure;
   * discard a receipt if policy reloads before its read finishes. */
  oracleCandidateReadPort(config:OracleCandidateHostConfig):{
    readCandidate(tag:string,commitSha:string):Promise<OracleCandidateReadResult>;
  }{
    const checked=async<T>(operation:(agent:LocalAgent)=>Promise<T>):Promise<T>=>{
      const agent=this.currentAgent,epoch=this.generation;
      if(!agent)throw new AppError("WORKSPACE_NOT_FOUND","Oracle candidate host offline.");
      const value=await operation(agent);
      if(epoch!==this.generation || agent!==this.currentAgent)
        throw new AppError("PERMISSION_DENIED","Oracle candidate policy changed during read.");
      return value;
    };
    return createOracleCandidateReadPort({
      oracleInspectCandidate:(input,context)=>checked(agent=>
        agent.oracleInspectCandidate(input,context)),
    },config);
  }

  /** Every workflow RPC uses the current LocalAgent, not the previous policy
   * generation. If reload races an in-flight dispatch, the result is
   * outcome_unknown; never issue the request again under a new generation. */
  oracleWorkflowPort(config:OracleReleaseGitHubReadConfig,
    policy:OracleReleaseGitHubWorkflowPolicy):OracleWorkflowProviderPort {
    const checked=async<T>(operation:(agent:LocalAgent)=>Promise<T>):Promise<T>=>{
      const active=this.currentAgent,epoch=this.generation;
      if(!active)throw new AppError("WORKSPACE_NOT_FOUND","Oracle workflow host offline.");
      const result=await operation(active);
      if(epoch!==this.generation || active!==this.currentAgent){
        throw new AppError("PERMISSION_DENIED","Oracle workflow policy changed during operation.");
      }
      return result;
    };
    const pinned=createOracleReleaseGitHubWorkflowPort({
      githubWorkflowOperation:(input,context)=>checked(agent=>
        agent.githubWorkflowOperation(input,context)),
      releaseVerifyGitHubLightweightTag:(input,tag,sha,context)=>checked(agent=>
        agent.releaseVerifyGitHubLightweightTag(input,tag,sha,context)),
      releaseInspectGitHubPublicDistribution:(input,runId,tag,sha,context)=>checked(agent=>
        agent.releaseInspectGitHubPublicDistribution(input,runId,tag,sha,context)),
    },config,{
      authorizeWorkflow:input=>checked(async()=>policy.authorizeWorkflow(input)),
      authorizeTagRead:(tag,sha)=>checked(async()=>policy.authorizeTagRead(tag,sha)),
      authorizeDistribution:(runId,tag,sha)=>checked(async()=>policy.authorizeDistribution(runId,tag,sha)),
    });
    // A workflow frame can never select the GitHub account, repository, scope
    // or workspace: these exist only in the trusted host enrollment.
    return {
      workflowOperation:(input:Omit<Parameters<typeof pinned.workflowOperation>[0],
        "workspaceId"|"owner"|"repository">)=>pinned.workflowOperation({
          ...input,workspaceId:config.workspaceId,owner:config.owner,
          repository:config.repository,
        }),
      verifyLightweightTag:(tag:string,sha:string)=>pinned.verifyLightweightTag(tag,sha),
      inspectDistribution:(runId:number,tag:string,sha:string)=>pinned.inspectDistribution(runId,tag,sha),
    };
  }

  get ready(): boolean {
    return this.current !== null;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  async reload(policy: PolicyFile | null): Promise<void> {
    if (!policy) {
      this.currentAgent=null;
      this.current = null;
      this.generation += 1;
      return;
    }
    const agent = await LocalAgent.createFromPolicy(policy, this.options);
    this.currentAgent=agent;
    this.current = new InProcessWorkspaceExecutor(agent);
    this.generation += 1;
  }
}
