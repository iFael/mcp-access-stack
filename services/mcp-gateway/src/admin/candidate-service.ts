import { z } from "zod";
export const candidateProvisionInputSchema = z.object({
  operationId: z.uuid(),
  candidateReleaseId: z.literal("1.1.0-beta.84-connector.1"),
  expectedManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedActivePid: z.number().int().positive(),
  execute: z.boolean(),
}).strict();
export type CandidateProvisionInput = z.infer<typeof candidateProvisionInputSchema>;

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PROVISIONER = fileURLToPath(new URL("../../../../deploy/linux/Provision-McpConnectorCandidateService.sh", import.meta.url));
const INSTALLATION_ROOT = "/var/lib/mcp-access-stack";
const UNIT = "mcp-access-stack-connector99-persistent.service";
const ACTIVE = "mcp-access-stack-edge-connector.service";

export type CommandReceipt = { exitCode: number | null; stdout: string; timedOut: boolean };
export type FixedRunner = (exe: string, args: readonly string[], timeoutMs: number) => Promise<CommandReceipt>;

export class CandidateServiceAdmin {
  constructor(
    private readonly run: FixedRunner = fixedRun,
    private readonly authorize: () => Promise<void> = assertOwner,
  ) {}

  async provision(input: CandidateProvisionInput) {
    const value = candidateProvisionInputSchema.parse(input);
    await this.authorize();
    const args = [
      PROVISIONER,
      "--operation-id", value.operationId,
      "--candidate-release-id", value.candidateReleaseId,
      "--expected-manifest-sha256", value.expectedManifestSha256,
      "--expected-active-pid", String(value.expectedActivePid),
      ...(value.execute ? ["--execute"] : []),
    ];
    const result = await this.run("/usr/bin/bash", args, 45_000);
    // Partial systemd changes on failure must be reconciled, never retried blindly.
    if (result.timedOut || result.exitCode !== 0) throw Error("PROVISION_OUTCOME_REQUIRES_RECONCILIATION");
    const output = result.stdout;
    const status = value.execute ? "provisioned" : "validated";
    if (!output.includes("status=" + status + "\n") ||
        !output.includes("operationId=" + value.operationId + "\n") ||
        !output.includes("candidateRelease=" + value.candidateReleaseId + "\n") ||
        !output.includes("activeServicePreserved=true\n")) {
      throw Error("PROVISION_RECEIPT_REQUIRES_RECONCILIATION");
    }
    return { status, operationId: value.operationId, releaseId: value.candidateReleaseId };
  }
  async status() {
    await this.authorize();
    const show = async (unit: string, property: string) => {
      const receipt = await this.run("/usr/bin/systemctl",
        ["--user", "show", unit, "--property", property, "--value"], 15_000);
      if (receipt.exitCode !== 0 || receipt.timedOut) throw Error("SERVICE_STATUS_UNAVAILABLE");
      return receipt.stdout.trim().slice(0, 64);
    };
    const loadState = await show(UNIT, "LoadState");
    const activeState = await show(UNIT, "ActiveState");
    const mainPid = Number(await show(UNIT, "MainPID"));
    const activeConnectorPid = Number(await show(ACTIVE, "MainPID"));
    if (![mainPid, activeConnectorPid].every(n => Number.isSafeInteger(n) && n >= 0)) {
      throw Error("SERVICE_STATUS_INVALID");
    }
    return { unit: UNIT, loadState, activeState, mainPid, activeConnectorPid };
  }
}

async function assertOwner() {
  if (process.platform !== "linux" || typeof process.getuid !== "function") {
    throw Error("LINUX_LOCAL_OPERATOR_REQUIRED");
  }
  const owner = await stat(INSTALLATION_ROOT);
  if (!owner.isDirectory() || process.getuid() === 0 || owner.uid !== process.getuid()) {
    throw Error("INSTALLATION_OWNER_MISMATCH");
  }
}

function fixedRun(exe: string, args: readonly string[], timeoutMs: number): Promise<CommandReceipt> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: process.env.HOME ?? "",
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "",
      },
    });
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(0, 4096); });
    child.once("error", () => { if (!settled) { settled = true; clearTimeout(timer); reject(Error("COMMAND_UNAVAILABLE")); } });
    child.once("close", code => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ exitCode: code, stdout, timedOut }); }
    });
  });
}
