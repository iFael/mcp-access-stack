import type { GitStatusEntry } from "@vs-code-gpt/shared";

export interface ParsedGitStatus extends GitStatusEntry {
  untracked: boolean;
}

export function parsePorcelainStatus(output: string): ParsedGitStatus[] {
  if (output.length === 0) return [];
  const fields = output.split("\0");
  const entries: ParsedGitStatus[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const indexStatus = field[0] ?? " ";
    const workTreeStatus = field[1] ?? " ";
    const filePath = field.slice(3).replaceAll("\\", "/");
    const renamed = [indexStatus, workTreeStatus].some((status) =>
      ["R", "C"].includes(status),
    );
    let originalPath: string | undefined;
    if (renamed) {
      originalPath = fields[index + 1]?.replaceAll("\\", "/");
      index += 1;
    }
    entries.push({
      path: filePath,
      indexStatus,
      workTreeStatus,
      ...(originalPath === undefined ? {} : { originalPath }),
      untracked: indexStatus === "?" && workTreeStatus === "?",
    });
  }
  return entries;
}

export function relativizeGitEntry(
  entry: ParsedGitStatus,
  rootPrefix: string,
): { status: ParsedGitStatus; repositoryPath: string } | undefined {
  const relativePath = toRootRelativePath(rootPrefix, entry.path);
  if (relativePath === undefined) return undefined;

  let relativeOriginalPath: string | undefined;
  if (entry.originalPath !== undefined) {
    relativeOriginalPath = toRootRelativePath(rootPrefix, entry.originalPath);
    if (relativeOriginalPath === undefined) return undefined;
  }

  return {
    repositoryPath: entry.path,
    status: {
      ...entry,
      path: relativePath,
      ...(relativeOriginalPath === undefined
        ? { originalPath: undefined }
        : { originalPath: relativeOriginalPath }),
    },
  };
}

function toRootRelativePath(
  rootPrefix: string,
  candidate: string,
): string | undefined {
  const normalized = candidate.replaceAll("\\", "/");
  if (rootPrefix === ".") return normalized;
  if (!normalized.startsWith(`${rootPrefix}/`)) return undefined;
  return normalized.slice(rootPrefix.length + 1);
}
