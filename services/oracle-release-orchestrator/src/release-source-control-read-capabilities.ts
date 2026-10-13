import { createHash } from "node:crypto";
import type { ReleaseStepCapability } from "./release-workflow-executor.js";
import type { EvidenceInput, ReleaseRunSnapshot, StepIntent } from "./types.js";

/** Trusted host implementations are backed by the existing GitHub source-control
 * reads. This adapter never issues its own network request or shell command. */
export interface ReleaseSourceControlReadPort {
  readMainHead(): Promise<string>;
  readCommitChecks(commitSha: string): Promise<{
    readonly commitSha: string;
    readonly totalCount: number;
    readonly returnedCount: number;
    readonly pendingCount: number;
    readonly successfulCount: number;
    readonly failingCount: number;
    readonly allCompleted: boolean;
    readonly truncated: boolean;
    readonly passed: boolean;
    readonly checks: readonly {
      readonly id: number;
      readonly name: string;
      readonly status: string;
      readonly conclusion: string | null;
    }[];
  }>;
}

export interface ReleaseSourceControlReadBinding {
  readonly port: ReleaseSourceControlReadPort;
  /** Trust/identity is established by the same host as the original typed read. */
  readonly authorizeRead: (run: ReleaseRunSnapshot) => Promise<boolean>;
}

const SHA = /^[0-9a-f]{40}$/u;
const TERMINAL = new Set(["success", "neutral", "skipped"]);

function requireBoundIntent(
  intent: StepIntent, run: ReleaseRunSnapshot,
  action: "resolve_main_commit" | "verify_canonical_ci",
): boolean {
  return intent.runId === run.runId && intent.action === action &&
    run.steps.some(step => step.stepId === intent.stepId &&
      step.action === action && step.operationId === intent.operationId);
}

function proof(kind: string, value: unknown): EvidenceInput {
  return {
    kind, source: "mcp_v3_typed_source_control",
    sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    observedAt: new Date().toISOString(),
  };
}

/** Bind exactly the first two canonical release steps to already-typed reads.
 * A ref movement, unbounded check list, incomplete CI or invalid identity is
 * never interpreted as successful CI. No GitHub mutation is possible here. */
export function bindReleaseSourceControlReads(
  options: ReleaseSourceControlReadBinding,
): ReadonlyMap<"resolve_main_commit" | "verify_canonical_ci", ReleaseStepCapability> {
  async function mainSha(run: ReleaseRunSnapshot): Promise<string | null> {
    const sha = await options.port.readMainHead();
    if (!SHA.test(sha) || sha !== run.sourceCommitSha.toLowerCase()) return null;
    return sha;
  }

  type ReadResult =
    | { readonly status: "verified"; readonly evidence: EvidenceInput }
    | { readonly status: "pending" }
    | { readonly status: "invalid" };

  async function checks(run: ReleaseRunSnapshot): Promise<ReadResult> {
    const before = await mainSha(run);
    if (!before) return { status: "invalid" };
    const result = await options.port.readCommitChecks(before);
    if (result.commitSha !== before ||
      result.totalCount < 0 || result.totalCount > 100 ||
      result.returnedCount !== result.checks.length ||
      result.pendingCount < 0 || result.failingCount < 0 ||
      result.successfulCount < 0 ||
      result.successfulCount + result.failingCount + result.pendingCount !== result.returnedCount ||
      result.checks.some(check => !Number.isSafeInteger(check.id) || check.id <= 0 ||
        !check.name.trim()) ||
      new Set(result.checks.map(check => check.id)).size !== result.checks.length) {
      return { status: "invalid" };
    }
    // In-progress CI is NOT a terminal release failure. Persist the operation
    // and reconcile the same SHA until checks become terminal; never dispatch.
    if (result.totalCount === 0 || result.truncated || !result.allCompleted ||
      result.pendingCount > 0 || result.returnedCount !== result.totalCount) {
      return { status: "pending" };
    }
    if (!result.passed || result.failingCount > 0 ||
      result.checks.some(check => check.status !== "completed" ||
        !TERMINAL.has(check.conclusion ?? ""))) {
      return { status: "invalid" };
    }
    const after = await mainSha(run);
    if (after !== before) return { status: "invalid" };
    return { status: "verified", evidence: proof("canonical_ci_run", {
      sha: before,
      checks: result.checks.map(check =>
        ({ id: check.id, name: check.name, conclusion: check.conclusion }))
        .sort((a, b) => a.id - b.id),
    }) };
  }

  function binding(
    action: "resolve_main_commit" | "verify_canonical_ci",
    read: (run: ReleaseRunSnapshot) => Promise<ReadResult>,
  ): ReleaseStepCapability {
    return {
      action,
      executionClass: "read_only",
      authorize: async (_step, run) => options.authorizeRead(run),
      execute: async (intent, run) => {
        if (!requireBoundIntent(intent, run, action) || !await options.authorizeRead(run)) {
          return { state: "outcome_unknown" };
        }
        try {
          const observed = await read(run);
          if (observed.status === "verified") {
            return { state: "succeeded", evidence: [observed.evidence] };
          }
          if (observed.status === "pending") return { state: "outcome_unknown" };
          return { state: "failed", outcomeCode: "RELEASE_SOURCE_STATE_MISMATCH", evidence: [] };
        } catch {
          return { state: "outcome_unknown" };
        }
      },
      reconcile: async (intent, run) => {
        if (!requireBoundIntent(intent, run, action) || !await options.authorizeRead(run)) {
          return { outcome: "still_unknown" };
        }
        try {
          const observed = await read(run);
          if (observed.status === "verified") {
            return { outcome: "applied", evidence: [observed.evidence] };
          }
          if (observed.status === "pending") return { outcome: "still_unknown" };
          // These are reads, not effects: authoritative negative evidence
          // permits a separate fail-closed recheck, never an external retry.
          return { outcome: "not_applied",
            evidence: [proof("source_state_rejected", { sha: run.sourceCommitSha, action })] };
        } catch {
          return { outcome: "still_unknown" };
        }
      },
    };
  }

  return new Map([
    ["resolve_main_commit", binding("resolve_main_commit", async run => {
      const sha = await mainSha(run);
      return sha ? { status: "verified" as const, evidence: proof("main_ref_verified", { sha }) } : { status: "invalid" as const };
    })],
    ["verify_canonical_ci", binding("verify_canonical_ci", checks)],
  ]);
}
