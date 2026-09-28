import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "@vs-code-gpt/shared";

interface CompanionInstanceRecord {
  version: 1;
  instanceId: string;
  pid: number;
  releaseRoot: string;
  startedAt: string;
}

export interface CompanionInstanceLockOptions {
  stateRoot: string;
  releaseRoot: string;
  pid?: number;
  now?: () => Date;
  processAlive?: (pid: number) => boolean;
  handoverFromInstanceId?: string;
}

export interface CompanionInstanceLease {
  readonly lockPath: string;
  readonly instanceId: string;
  release(): Promise<void>;
}

export async function acquireCompanionInstanceLock(
  options: CompanionInstanceLockOptions,
): Promise<CompanionInstanceLease> {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const processAlive = options.processAlive ?? isProcessAlive;
  const stateDirectory = path.join(path.resolve(options.stateRoot), "state");
  const lockPath = path.join(stateDirectory, "companion-instance.v1.json");
  const instanceId = randomUUID();
  await mkdir(stateDirectory, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record: CompanionInstanceRecord = {
      version: 1,
      instanceId,
      pid,
      releaseRoot: path.resolve(options.releaseRoot),
      startedAt: now().toISOString(),
    };

    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return createLease(lockPath, instanceId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let existing = await readCompanionInstanceRecord(lockPath);
    if (!existing) {
      await delay(50);
      existing = await readCompanionInstanceRecord(lockPath);
    }
    if (existing && processAlive(existing.pid)) {
      if (
        options.handoverFromInstanceId !== undefined &&
        existing.instanceId === options.handoverFromInstanceId
      ) {
        const handoverPath = `${lockPath}.${instanceId}.handover`;
        await writeFile(handoverPath, `${JSON.stringify(record)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        try {
          const current = await readCompanionInstanceRecord(lockPath);
          if (current?.instanceId !== options.handoverFromInstanceId) {
            continue;
          }
          await rename(handoverPath, lockPath);
          return createLease(lockPath, instanceId);
        } finally {
          await rm(handoverPath, { force: true });
        }
      }
      throw new AppError(
        "AGENT_BUSY",
        `Another MCP V3 local companion instance is already active. pid=${existing.pid}`,
      );
    }
    await rm(lockPath, { force: true });
  }

  throw new AppError(
    "AGENT_BUSY",
    "MCP V3 local companion could not acquire its single-instance lock.",
  );
}

function createLease(lockPath: string, instanceId: string): CompanionInstanceLease {
  return {
    lockPath,
    instanceId,
    release: async () => {
      const current = await readCompanionInstanceRecord(lockPath);
      if (current?.instanceId === instanceId) {
        await rm(lockPath, { force: true });
      }
    },
  };
}

async function readCompanionInstanceRecord(
  lockPath: string,
): Promise<CompanionInstanceRecord | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  try {
    const value = JSON.parse(raw) as Partial<CompanionInstanceRecord>;
    if (
      value.version !== 1 ||
      typeof value.instanceId !== "string" ||
      value.instanceId.length === 0 ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.releaseRoot !== "string" ||
      typeof value.startedAt !== "string"
    ) {
      return null;
    }
    return value as CompanionInstanceRecord;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}
