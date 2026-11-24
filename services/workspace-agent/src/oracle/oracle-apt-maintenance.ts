import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { oracleAptMaintenanceResultSchema, type OracleAptMaintenanceInput,
  type OracleAptMaintenanceResult } from "@vs-code-gpt/shared";

const HELPER = "/usr/local/libexec/mcp-v3-apt-maintenance";
const MAX_OUTPUT = 64 * 1024;
type Runner = (input: OracleAptMaintenanceInput, signal?: AbortSignal) => Promise<string>;

export class OracleAptMaintenanceService {
  constructor(private readonly deps: { platform?: NodeJS.Platform; run?: Runner } = {}) {}

  async execute(input: OracleAptMaintenanceInput, signal?: AbortSignal): Promise<OracleAptMaintenanceResult> {
    const failure = (status: OracleAptMaintenanceResult["status"],
      diagnostic: NonNullable<OracleAptMaintenanceResult["diagnostic"]>): OracleAptMaintenanceResult => ({
        status, diagnostic,
        ...("operation" in input ? { operation: input.operation } : {}),
        ...("operationId" in input ? { operationId: input.operationId } : {}),
      });
    if ((this.deps.platform ?? process.platform) !== "linux") return failure("unavailable", "linux_only");
    try {
      const raw = JSON.parse(await (this.deps.run ?? runPrivileged)(input, signal)) as unknown;
      const parsed = oracleAptMaintenanceResultSchema.safeParse(raw);
      if (!parsed.success || ("operationId" in input && parsed.data.operationId !== input.operationId) ||
          ("operation" in input && parsed.data.operation !== input.operation) ||
          (input.action === "apply" && ["running", "succeeded", "failed"].includes(parsed.data.status) &&
            parsed.data.planSha256 !== input.expectedPlanSha256)) {
        return failure(input.action === "apply" ? "outcome_unknown" : "unavailable", "invalid_response");
      }
      return parsed.data;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return failure("permission_required", "helper_missing");
      if (code === "SUDO_DENIED" || code === "EACCES" || code === "EPERM") {
        return failure("permission_required", "root_policy_denied");
      }
      // A request can disconnect after the fixed systemd job was accepted.
      // Never retry an apply automatically; inspect the same operation ID.
      return failure(input.action === "apply" ? "outcome_unknown" : "unavailable", "execution_failed");
    }
  }
}

async function runPrivileged(input: OracleAptMaintenanceInput, signal?: AbortSignal): Promise<string> {
  const info = await lstat(HELPER);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
    throw Object.assign(new Error("Untrusted APT helper."), { code: "EACCES" });
  }
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sudo", ["-n", HELPER], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout: 50_000, signal,
    });
    let stdout = "", stderr = "";
    child.on("error", reject);
    child.stdin.on("error", reject);
    const append = (output: string, chunk: Buffer) => {
      const next = output + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_OUTPUT) {
        child.kill();
        reject(new Error("APT helper response exceeded bound."));
        return "";
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("close", code => {
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error("Bounded APT request did not complete."), {
        code: /not allowed|not in the sudoers|a password is required/iu.test(stderr) ? "SUDO_DENIED" : "EXECUTION_FAILED",
      }));
    });
    child.stdin.end(JSON.stringify(input));
  });
}
