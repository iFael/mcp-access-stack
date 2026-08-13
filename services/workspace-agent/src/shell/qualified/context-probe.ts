import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { LimitedGitContext, LimitedToolContext } from "./types.js";

const MAX_PROBE_OUTPUT_BYTES = 4_096;
const PROBE_TIMEOUT_MS = 15_000;
const SHELL_PROBE_RETRY_DELAY_MS = 50;

export interface CommandContextProbe {
  getGitContext(cwd: string): Promise<LimitedGitContext>;
  probeTool(name: string, cwd: string): Promise<LimitedToolContext>;
}

interface ProbeSpec {
  executable: string;
  args: string[];
}

const TOOL_PROBES: Record<string, ProbeSpec> = {
  git: { executable: "git", args: ["--version"] },
  node: { executable: "node", args: ["--version"] },
  npm: { executable: "npm", args: ["--version"] },
  pnpm: { executable: "pnpm", args: ["--version"] },
  yarn: { executable: "yarn", args: ["--version"] },
  bun: { executable: "bun", args: ["--version"] },
  dotnet: { executable: "dotnet", args: ["--version"] },
  cargo: { executable: "cargo", args: ["--version"] },
  go: { executable: "go", args: ["version"] },
  python: { executable: "python", args: ["--version"] },
  powershell: { executable: "where.exe", args: ["powershell.exe"] },
  pwsh: { executable: "where.exe", args: ["pwsh.exe"] },
  cmd: { executable: "where.exe", args: ["cmd.exe"] },
  wsl: { executable: "where.exe", args: ["wsl.exe"] },
};

export class NativeCommandContextProbe implements CommandContextProbe {
  async getGitContext(cwd: string): Promise<LimitedGitContext> {
    const repository = await runProbe(
      { executable: "git", args: ["rev-parse", "--is-inside-work-tree"] },
      cwd,
    );
    if (!repository.available || repository.output.trim() !== "true") {
      return { repository: false };
    }

    const [branch, status] = await Promise.all([
      runProbe(
        { executable: "git", args: ["branch", "--show-current"] },
        cwd,
      ),
      runProbe(
        {
          executable: "git",
          args: ["status", "--porcelain=v1", "--untracked-files=normal"],
        },
        cwd,
      ),
    ]);

    return {
      repository: true,
      ...(branch.available && branch.output.trim().length > 0
        ? { branch: branch.output.trim().slice(0, 200) }
        : {}),
      dirty: status.available && status.output.trim().length > 0,
    };
  }

  async probeTool(name: string, cwd: string): Promise<LimitedToolContext> {
    const spec =
      name === "git-bash" ? await resolveGitBashProbe() : TOOL_PROBES[name];
    if (!spec) return { name, available: false };

    let result = await runProbe(spec, cwd);
    if (!result.available && isShellName(name)) {
      await delay(SHELL_PROBE_RETRY_DELAY_MS);
      result = await runProbe(spec, cwd);
    }

    return {
      name,
      available: result.available,
      ...(!isShellName(name) &&
      result.available &&
      result.output.trim().length > 0
        ? { version: firstLine(result.output) }
        : {}),
    };
  }
}

async function resolveGitBashProbe(): Promise<ProbeSpec | undefined> {
  const candidates = [
    process.env.GIT_BASH_PATH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      await access(resolved);
      return { executable: resolved, args: ["--version"] };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function runProbe(
  spec: ProbeSpec,
  cwd: string,
): Promise<{ available: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let child;
    try {
      child = spawn(spec.executable, spec.args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ available: false, output: "" });
      return;
    }

    const append = (chunk: Buffer): void => {
      if (output.length >= MAX_PROBE_OUTPUT_BYTES) return;
      output += chunk.toString("utf8").slice(
        0,
        MAX_PROBE_OUTPUT_BYTES - output.length,
      );
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ available: false, output: "" });
    }, PROBE_TIMEOUT_MS);
    timer.unref();

    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ available: false, output: "" });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ available: code === 0, output });
    });
  });
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u, 1)[0]?.trim().slice(0, 200) ?? "";
}

function isShellName(name: string): boolean {
  return ["powershell", "pwsh", "cmd", "wsl", "git-bash"].includes(name);
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
}
