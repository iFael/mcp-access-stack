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
