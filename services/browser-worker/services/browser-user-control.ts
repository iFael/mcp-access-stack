import {
  AppError,
  type BrowserViewerControlInput,
  type BrowserViewerInputEvent,
} from "@vs-code-gpt/shared";

export interface BrowserUserControlHandle {
  input(event: BrowserViewerInputEvent): Promise<void>;
  release(): Promise<void>;
  renew?(): void;
}

type Binding = Pick<BrowserViewerControlInput, "taskId" | "tabId" | "controlId"> & {
  ownerScope: string;
};
type Grant = Binding & { handle: BrowserUserControlHandle; expiresAt: number };

const IDLE_MS = 2 * 60_000;

/** An authenticated human gets exclusive control of one tab in this worker.
 * Expiry stops inputs, never silently returns a potentially sensitive page to the agent.
 */
export class BrowserUserControl {
  private grant: Grant | undefined;
  private transitioning: BrowserViewerControlInput["action"] | undefined;
  private agentOperations = 0;
  private epoch = 0;

  acquireAgent(): () => void {
    if (this.grant || this.transitioning) {
      throw new AppError("TASK_SUSPENDED", "The browser is under manual user control. Wait for the user to return it.");
    }
    this.agentOperations++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.agentOperations--;
    };
  }

  frameGuard(binding: Binding | undefined): () => boolean {
    const epoch = this.epoch;
    const allowed = () => epoch === this.epoch && this.transitioning !== "take" && this.transitioning !== "release" && (
      !this.grant ? !this.transitioning :
        binding !== undefined && this.sameHolder(this.grant, binding) &&
        this.grant.expiresAt > Date.now()
    );
    if (!allowed()) throw new AppError("TASK_SUSPENDED", "The browser live view is reserved for its manual controller.");
    return allowed;
  }

  async run(
    input: BrowserViewerControlInput,
    ownerScope: string,
    begin: () => Promise<BrowserUserControlHandle>,
  ): Promise<void> {
    const binding = { taskId: input.taskId, tabId: input.tabId, controlId: input.controlId, ownerScope };
    if (this.transitioning) throw new AppError("AGENT_BUSY", "A manual control operation is still in progress.");
    if (input.action === "take") {
      if (this.grant) {
        if (!this.sameTab(this.grant, binding) ||
            (!this.sameHolder(this.grant, binding) && this.grant.expiresAt > Date.now())) {
          throw new AppError("TASK_SUSPENDED", "Another viewer controls this browser.");
        }
        this.grant.handle.renew?.();
        if (!this.sameHolder(this.grant, binding)) this.epoch++;
        this.grant = { ...this.grant, ...binding, expiresAt: Date.now() + IDLE_MS };
        return;
      }
      if (this.agentOperations > 0) {
        throw new AppError("AGENT_BUSY", "An agent operation is still pending.");
      }
      this.transitioning = "take";
      this.epoch++;
      try {
        const handle = await begin();
        this.grant = { ...binding, handle, expiresAt: Date.now() + IDLE_MS };
      } finally {
        this.transitioning = undefined;
      }
      return;
    }

    const grant = this.grant;
    if (!grant || !this.sameHolder(grant, binding)) {
      throw new AppError("TASK_SUSPENDED", "Take manual control before sending input.");
    }
    if (input.action === "input" && grant.expiresAt <= Date.now()) {
      throw new AppError("TASK_SUSPENDED", "Manual control expired; take control again.");
    }
    this.transitioning = input.action;
    if (input.action === "release") this.epoch++;
    try {
      if (input.action === "input") {
        await grant.handle.input(input.event);
        grant.expiresAt = Date.now() + IDLE_MS;
      } else {
        await grant.handle.release();
        this.grant = undefined;
      }
    } finally {
      this.transitioning = undefined;
    }
  }

  private sameTab(left: Binding, right: Binding): boolean {
    return left.ownerScope === right.ownerScope && left.taskId === right.taskId && left.tabId === right.tabId;
  }

  private sameHolder(left: Binding, right: Binding): boolean {
    return this.sameTab(left, right) && left.controlId === right.controlId;
  }
}
