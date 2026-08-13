import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@vs-code-gpt/shared";
import { WorkspaceRegistry } from "./workspace-registry.js";

export interface PolicyValidationResult {
  path: string;
  workspaceCount: number;
}

export interface PolicyApplyResult extends PolicyValidationResult {
  targetPath: string;
  backupPath?: string;
}

export async function validatePolicyFile(
  policyPath: string,
): Promise<PolicyValidationResult> {
  const absolutePath = path.resolve(policyPath);
  const registry = await WorkspaceRegistry.load(absolutePath);
  return {
    path: absolutePath,
    workspaceCount: registry.all().length,
  };
}

export async function applyPolicyFile(
  sourcePath: string,
  targetPath: string,
): Promise<PolicyApplyResult> {
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  if (samePath(source, target)) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Policy source and target must be different files.",
    );
  }

  const validation = await validatePolicyFile(source);
  const contents = await readFile(source);
  const targetDirectory = path.dirname(target);
  await mkdir(targetDirectory, { recursive: true });

  const temporaryPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  const lastKnownGoodPath = `${target}.last-known-good.json`;
  let backupPath: string | undefined;

  try {
    await writeFile(temporaryPath, contents, { flag: "wx" });
    await validatePolicyFile(temporaryPath);

    if (await fileExists(target)) {
      backupPath = `${target}.backup-${timestampForFileName()}.json`;
      await copyFile(target, backupPath);
      await copyFile(target, lastKnownGoodPath);
    }

    await rename(temporaryPath, target);
    await validatePolicyFile(target);
    return {
      ...validation,
      targetPath: target,
      ...(backupPath === undefined ? {} : { backupPath }),
    };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function timestampForFileName(): string {
  return new Date().toISOString().replaceAll(":", "-");
}
