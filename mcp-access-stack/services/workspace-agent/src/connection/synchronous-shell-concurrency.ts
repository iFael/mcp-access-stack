import { AppError } from "@vs-code-gpt/shared";

export const DEFAULT_MAX_CONCURRENT_SYNCHRONOUS_SHELLS = 4;
export const MAX_CONCURRENT_SYNCHRONOUS_SHELLS = 16;

export interface SynchronousShellLease {
  release(): void;
}

export class SynchronousShellConcurrency {
  private readonly activeByWorkspace = new Map<string, string>();
  readonly maxConcurrent: number;

  constructor(maxConcurrent = DEFAULT_MAX_CONCURRENT_SYNCHRONOUS_SHELLS) {
    if (
      !Number.isInteger(maxConcurrent) ||
      maxConcurrent < 1 ||
      maxConcurrent > MAX_CONCURRENT_SYNCHRONOUS_SHELLS
    ) {
      throw new AppError(
        "INVALID_ARGUMENT",
        `Synchronous shell concurrency must be an integer between 1 and ${MAX_CONCURRENT_SYNCHRONOUS_SHELLS}.`,
      );
    }
    this.maxConcurrent = maxConcurrent;
  }

  get activeCount(): number {
    return this.activeByWorkspace.size;
  }

  acquire(workspaceKey: string, requestId: string): SynchronousShellLease {
    if (this.activeByWorkspace.has(workspaceKey)) {
      throw new AppError(
        "AGENT_BUSY",
        "Another synchronous shell operation is already active for this workspace.",
      );
    }
    if (this.activeByWorkspace.size >= this.maxConcurrent) {
      throw new AppError(
        "AGENT_BUSY",
        "The Workspace Agent synchronous shell concurrency limit is reached.",
      );
    }

    this.activeByWorkspace.set(workspaceKey, requestId);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.activeByWorkspace.get(workspaceKey) === requestId) {
          this.activeByWorkspace.delete(workspaceKey);
        }
      },
    };
  }
}
