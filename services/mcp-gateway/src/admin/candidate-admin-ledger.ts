import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { CandidateProvisionInput } from "./candidate-service.js";

const operationIdSchema = z.uuid();
const INSTALL_ROOT = "/var/lib/mcp-access-stack";
const AUDIT_DIR = join(INSTALL_ROOT, "state", "candidate99-admin");
type Outcome = "started" | "succeeded" | "outcome_unknown";

export class CandidateAdminLedger {
  constructor(private readonly root = AUDIT_DIR) {}

  private async verifyDirectory(): Promise<void> {
    const state = await lstat(dirname(this.root));
    if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid?.()) {
      throw Error("ADMIN_AUDIT_PARENT_UNTRUSTED");
    }
    try {
      await mkdir(this.root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw Error("ADMIN_AUDIT_DIRECTORY_UNTRUSTED");
    }
  }

  async claim(input: CandidateProvisionInput): Promise<void> {
    operationIdSchema.parse(input.operationId);
    await this.verifyDirectory();
    const receipt = {
      event: "started" as Outcome,
      operationId: input.operationId,
      candidateReleaseId: input.candidateReleaseId,
      expectedManifestSha256: input.expectedManifestSha256,
      expectedActivePid: input.expectedActivePid,
      uid: process.getuid?.(),
      requestDigest: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      timestamp: new Date().toISOString(),
    };
    const file = join(this.root, input.operationId + ".jsonl");
    let handle;
    try {
      handle = await open(file, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw Error("ADMIN_OPERATION_ALREADY_CLAIMED_RECONCILE");
      }
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify(receipt) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async finish(operationId: string, outcome: Exclude<Outcome, "started">): Promise<void> {
    operationIdSchema.parse(operationId);
    const file = join(this.root, operationId + ".jsonl");
    const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      await handle.writeFile(JSON.stringify({ event: outcome, operationId,
        timestamp: new Date().toISOString() }) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async reconcile(operationId: string): Promise<{ operationId: string; outcome: Outcome | "not_found" }> {
    operationIdSchema.parse(operationId);
    const file = join(this.root, operationId + ".jsonl");
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { operationId, outcome: "not_found" };
      throw error;
    }
    try {
      const record = await handle.readFile({ encoding: "utf8" });
      if (record.length > 4096) throw Error("ADMIN_AUDIT_RECORD_OVERSIZED");
      const lines = record.trim().split("\n");
      if (lines.length < 1 || lines.length > 2) throw Error("ADMIN_AUDIT_RECORD_INVALID");
      const last = JSON.parse(lines.at(-1) ?? "{}") as { event?: Outcome; operationId?: string };
      if (last.operationId !== operationId ||
          !["started", "succeeded", "outcome_unknown"].includes(last.event ?? "")) {
        throw Error("ADMIN_AUDIT_RECORD_INVALID");
      }
      return { operationId, outcome: last.event! };
    } finally {
      await handle.close();
    }
  }
}
