import { spawn, type ChildProcess } from "node:child_process";
import {
  AppError,
  COMMAND_TERMINATION_GRACE_MS,
} from "@vs-code-gpt/shared";

const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 5_000;
const WINDOWS_PROCESS_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const WINDOWS_FAST_EXIT_WAIT_MS = 1_000;
const WINDOWS_PROCESS_EXIT_POLL_MS = 50;

interface WindowsProcessRelation {
  pid: number;
  parentPid: number;
}

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
    await terminateWindowsProcessTreeByPid(pid);
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

async function terminateWindowsProcessTreeByPid(rootPid: number): Promise<void> {
  const deadline = Date.now() + COMMAND_TERMINATION_GRACE_MS;
  const primarySucceeded = await runTaskKill(
    rootPid,
    Math.min(WINDOWS_TASKKILL_TIMEOUT_MS, remainingMs(deadline)),
  );

  // taskkill /T /F is the normal fast path. A zero exit code means Windows
  // accepted termination of the requested process tree. Any failed or incomplete
  // termination falls back to explicit descendant discovery and verification.
  if (primarySucceeded && !processExists(rootPid)) return;

  const observedPids = new Set<number>([rootPid]);
  addAll(
    observedPids,
    await snapshotWindowsDescendantPids(rootPid, remainingMs(deadline)),
  );

  forceKillObservedProcesses(observedPids, rootPid);
  await waitForObservedProcessesToExit(
    observedPids,
    Math.min(deadline, Date.now() + WINDOWS_FAST_EXIT_WAIT_MS),
  );
  if (![...observedPids].some(processExists)) return;

  // Retry each still-live PID as an independent tree root. This covers a root
  // that exited before taskkill ran and descendants whose inherited handles
  // would otherwise keep ChildProcess.close pending indefinitely.
  for (const candidatePid of [...observedPids].reverse()) {
    if (!processExists(candidatePid)) continue;
    await runTaskKill(
      candidatePid,
      Math.min(WINDOWS_TASKKILL_TIMEOUT_MS, remainingMs(deadline)),
    );
    if (remainingMs(deadline) <= 0) break;
  }
  forceKillObservedProcesses(observedPids, rootPid);
  await waitForObservedProcessesToExit(observedPids, deadline);

  const remaining = [...observedPids].filter(processExists);
  if (remaining.length > 0) {
    throw new AppError(
      "SHELL_FAILED",
      "The Windows process tree did not terminate within the command termination grace period.",
    );
  }
}

function forceKillObservedProcesses(
  observedPids: ReadonlySet<number>,
  rootPid: number,
): void {
  const descendants = [...observedPids].filter((pid) => pid !== rootPid).reverse();
  for (const pid of descendants) {
    if (processExists(pid)) tryKill(pid, "SIGKILL");
  }
  if (processExists(rootPid)) tryKill(rootPid, "SIGKILL");
}

async function waitForObservedProcessesToExit(
  observedPids: ReadonlySet<number>,
  deadline: number,
): Promise<void> {
  while (remainingMs(deadline) > 0) {
    if (![...observedPids].some(processExists)) return;
    await delay(Math.min(WINDOWS_PROCESS_EXIT_POLL_MS, remainingMs(deadline)));
  }
}

async function snapshotWindowsDescendantPids(
  rootPid: number,
  budgetMs: number,
): Promise<number[]> {
  if (budgetMs <= 0) return [];
  const relations = await readWindowsProcessRelations(
    Math.min(WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS, budgetMs),
  );
  return descendantPids(rootPid, relations);
}

async function readWindowsProcessRelations(
  timeoutMs: number,
): Promise<WindowsProcessRelation[]> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { '{0}|{1}' -f $_.ProcessId,$_.ParentProcessId }",
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let stdout = "";
    let settled = false;

    const finish = (relations: WindowsProcessRelation[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(relations);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish([]);
    }, Math.max(1, timeoutMs));
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length >= WINDOWS_PROCESS_SNAPSHOT_MAX_BYTES) return;
      stdout += chunk.toString("utf8");
      if (stdout.length > WINDOWS_PROCESS_SNAPSHOT_MAX_BYTES) {
        stdout = stdout.slice(0, WINDOWS_PROCESS_SNAPSHOT_MAX_BYTES);
      }
    });
    child.once("error", () => finish([]));
    child.once("close", (exitCode) => {
      finish(exitCode === 0 ? parseWindowsProcessRelations(stdout) : []);
    });
  });
}

function parseWindowsProcessRelations(value: string): WindowsProcessRelation[] {
  const relations: WindowsProcessRelation[] = [];
  for (const line of value.split(/\r?\n/u)) {
    const [pidText, parentPidText] = line.trim().split("|");
    const pid = Number(pidText);
    const parentPid = Number(parentPidText);
    if (
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      Number.isSafeInteger(parentPid) &&
      parentPid >= 0
    ) {
      relations.push({ pid, parentPid });
    }
  }
  return relations;
}

function descendantPids(
  rootPid: number,
  relations: readonly WindowsProcessRelation[],
): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const relation of relations) {
    const children = childrenByParent.get(relation.parentPid) ?? [];
    children.push(relation.pid);
    childrenByParent.set(relation.parentPid, children);
  }

  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    const parentPid = pending.pop()!;
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      descendants.push(childPid);
      pending.push(childPid);
    }
  }
  return descendants;
}

async function runTaskKill(pid: number, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  return new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    let settled = false;
    const finish = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(succeeded);
    };
    const timer = setTimeout(() => {
      killer.kill();
      finish(false);
    }, Math.max(1, timeoutMs));
    timer.unref();
    killer.once("error", () => finish(false));
    killer.once("close", (exitCode) => finish(exitCode === 0));
  });
}

function addAll(target: Set<number>, values: readonly number[]): void {
  for (const value of values) target.add(value);
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
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
