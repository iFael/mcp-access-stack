import { spawn, type ChildProcess } from "node:child_process";
import { COMMAND_TERMINATION_GRACE_MS } from "@vs-code-gpt/shared";

export async function terminateChildProcessTree(
  child: ChildProcess,
): Promise<void> {
  if (child.pid) {
    await terminateProcessTreeByPid(child.pid);
    return;
  }
  child.kill();
}

export async function terminateProcessTreeByPid(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        killer.kill();
        tryKill(pid, "SIGKILL");
        resolve();
      }, COMMAND_TERMINATION_GRACE_MS);
      timer.unref();
      killer.once("error", () => {
        clearTimeout(timer);
        tryKill(pid, "SIGKILL");
        resolve();
      });
      killer.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return;
  }

  tryKill(-pid, "SIGTERM");
  tryKill(pid, "SIGTERM");
  await delay(1_000);
  if (processExists(pid)) {
    tryKill(-pid, "SIGKILL");
    tryKill(pid, "SIGKILL");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
  }
}
