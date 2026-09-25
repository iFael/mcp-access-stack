import { AppError, type PolicyFile, type SourceControlExecutor, type WorkspaceExecutor } from "@vs-code-gpt/shared";
import { InProcessWorkspaceExecutor, LocalAgent, type LocalAgentOptions } from "@vs-code-gpt/local-agent";

export class ReloadableLocalAgent {
  private current: InProcessWorkspaceExecutor | null = null;
  private generation = 0;
  readonly workspaceExecutor: WorkspaceExecutor;
  readonly sourceControlExecutor: SourceControlExecutor;

  constructor(private readonly options: LocalAgentOptions = {}) {
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

  get ready(): boolean {
    return this.current !== null;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  async reload(policy: PolicyFile | null): Promise<void> {
    if (!policy) {
      this.current = null;
      this.generation += 1;
      return;
    }
    const agent = await LocalAgent.createFromPolicy(policy, this.options);
    this.current = new InProcessWorkspaceExecutor(agent);
    this.generation += 1;
  }
}
