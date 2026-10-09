import { createHash } from "node:crypto";
import {
  githubCommitChecksResultSchema,
  githubGetCommitChecksInputSchema,
  inspectGitInputSchema,
  type GitHubCommitChecksResult,
  type GitHubGetCommitChecksInput,
  type InspectGitInput,
  type InspectGitResult,
  type OperationContext,
} from "@vs-code-gpt/shared";
import type { LocalAgent } from "../local-agent.js";
import {
  type CampaignInvocation,
  type CampaignObservation,
  type CampaignObservationIdentity,
  type TypedCampaignCapability,
} from "./delegated-campaign-coordinator.js";

/**
 * Trusted, read-only bindings to ALREADY EXISTING LocalAgent typed methods.
 * Never dispatch an arbitrary tool name, shell command or user-supplied code.
 * The LocalAgent methods independently enforce workspace/repository policy.
 */
export type GitHubChecksReader = Pick<LocalAgent, "githubGetCommitChecks">;
export type GitInspector = Pick<LocalAgent, "inspectGit">;

function authorizedReadContext(input: OperationContext): { context: OperationContext; ownerHash: string } {
  if (!input || typeof input.ownerScope !== "string" ||
      input.ownerScope.length < 1 || input.ownerScope.length > 256) {
    throw new Error("CAMPAIGN_OWNER_REQUIRED: typed reads need a trusted owner scope");
  }
  // Copy caller-supplied context once; campaign definitions include the hash so
  // a future runner cannot silently swap identities on the same operation.
  const context = { ...input };
  return { context, ownerHash: createHash("sha256").update(input.ownerScope).digest("hex") };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function observationIdentity(request: CampaignInvocation): CampaignObservationIdentity {
  return {
    operationId: request.operationId,
    targetResource: request.targetResource,
    expectedState: request.expectedState,
    argumentsDigest: request.argumentsDigest,
  };
}
function bind(
  request: CampaignInvocation,
  definition: Pick<TypedCampaignCapability, "action" | "targetResource" | "expectedState" | "argumentsDigest">,
): void {
  if (request.action !== definition.action ||
      request.targetResource !== definition.targetResource ||
      request.expectedState !== definition.expectedState ||
      request.argumentsDigest !== definition.argumentsDigest) {
    throw new Error("CAMPAIGN_BINDING_MISMATCH: persisted typed read arguments changed");
  }
}

export interface BoundTypedRead {
  readonly definition: {
    readonly action: "inspect" | "ci";
    readonly targetResource: string;
    readonly expectedState: string;
    readonly argumentsDigest: string;
  };
  readonly capability: TypedCampaignCapability;
}

function checksObservation(
  request: CampaignInvocation,
  source: GitHubCommitChecksResult,
  commitSha: string,
): CampaignObservation {
  if (source.commitSha.toLowerCase() !== commitSha) {
    throw new Error("CAMPAIGN_CI_SHA_MISMATCH: typed check result is for a different commit");
  }
  const identity = observationIdentity(request);
  if (!source.allCompleted || source.truncated || source.totalCount < 1) {
    return { ...identity, state: "in_progress" };
  }
  const state = source.passed ? "succeeded" : "failed";
  return {
    ...identity,
    state,
    proof: {
      kind: "verified",
      reference: `ci:${commitSha}:${fingerprint({
        total: source.totalCount,
        checks: source.checks.map(c => ({
          id: c.id, name: c.name, status: c.status, conclusion: c.conclusion,
        })).sort((a, b) => a.id - b.id),
      })}`,
    },
  };
}

/**
 * Binds a future "ci" step to githubGetCommitChecks on an EXACT commit.
 * A terminal observation must be confirmed through a separate second read.
 */
export function bindGitHubCommitChecks(
  reader: GitHubChecksReader,
  input: GitHubGetCommitChecksInput,
  context: OperationContext,
): BoundTypedRead {
  const auth = authorizedReadContext(context);
  const parsed = githubGetCommitChecksInputSchema.parse(input);
  const owner = parsed.owner;
  const repository = parsed.repository;
  const commitSha = parsed.commitSha.toLowerCase();
  const exactInput = {
    workspaceId: parsed.workspaceId,
    root: parsed.root ?? ".",
    owner, repository, commitSha,
  } as const;
  const definition = {
    action: "ci",
    targetResource: `github:${owner}/${repository}:commit/${commitSha}:checks`,
    expectedState: `commit:${commitSha}`,
    argumentsDigest: fingerprint({ input: exactInput, ownerHash: auth.ownerHash }),
  } as const;

  async function read(request: CampaignInvocation): Promise<CampaignObservation> {
    bind(request, definition);
    if (request.workspaceId !== exactInput.workspaceId) {
      throw new Error("CAMPAIGN_WORKSPACE_MISMATCH");
    }
    const result = githubCommitChecksResultSchema.parse(
      await reader.githubGetCommitChecks(exactInput, auth.context),
    );
    if (result.owner !== owner || result.repository !== repository) {
      throw new Error("CAMPAIGN_CI_REPOSITORY_MISMATCH");
    }
    return checksObservation(request, result, commitSha);
  }
  const capability: TypedCampaignCapability = {
    ...definition,
    execute: read,
    reconcile: read,
    verify: async (request, receipt) => {
      if (receipt.state !== "succeeded" && receipt.state !== "failed") return false;
      // Avoid approving a receipt whose operation identity changed, or whose
      // terminal checks have changed between dispatch and verification.
      const confirmed = await read(request);
      return confirmed.state === receipt.state &&
        confirmed.proof.reference === receipt.proof.reference;
    },
  };
  return { definition, capability };
}

function gitObservation(
  request: CampaignInvocation,
  source: InspectGitResult,
  branch: string,
  root: string,
): CampaignObservation {
  if (source.workspaceId !== request.workspaceId ||
      source.root !== root ||
      source.branch !== branch) {
    throw new Error("CAMPAIGN_GIT_STATE_MISMATCH");
  }
  const clean = source.status.length === 0 && !source.truncated &&
    source.diffMode === "none";
  if (!clean) return { ...observationIdentity(request), state: "in_progress" };
  return {
    ...observationIdentity(request),
    state: "succeeded",
    proof: { kind: "verified", reference: `git-clean:${fingerprint({
      workspaceId: source.workspaceId, root: source.root, branch: source.branch,
      status: source.status, truncated: source.truncated, diffMode: source.diffMode,
    })}` },
  };
}

/**
 * Read-only Git inspection. This checks branch/cleanliness only, NOT HEAD SHA.
 * It must NOT be used as the sole CAS proof for commit/merge/deploy.
 */
export function bindGitCleanInspection(
  inspector: GitInspector,
  input: Pick<InspectGitInput, "workspaceId" | "root"> & { expectedBranch: string },
  context: OperationContext,
): BoundTypedRead {
  const auth = authorizedReadContext(context);
  if (typeof input.expectedBranch !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,127}$/u.test(input.expectedBranch) ||
      input.expectedBranch.includes("..")) {
    throw new Error("CAMPAIGN_INVALID: expected Git branch");
  }
  const exactInput = inspectGitInputSchema.parse({
    workspaceId: input.workspaceId,
    root: input.root ?? ".",
    diffMode: "none",
  });
  const root = exactInput.root ?? ".";
  const expectedBranch = input.expectedBranch;
  const definition = {
    action: "inspect",
    targetResource: `git:${exactInput.workspaceId}:${root}`,
    expectedState: `branch:${expectedBranch}:clean`,
    argumentsDigest: fingerprint({
      workspaceId: exactInput.workspaceId, root,
      expectedBranch, diffMode: "none", ownerHash: auth.ownerHash,
    }),
  } as const;
  async function read(request: CampaignInvocation): Promise<CampaignObservation> {
    bind(request, definition);
    if (request.workspaceId !== exactInput.workspaceId) {
      throw new Error("CAMPAIGN_WORKSPACE_MISMATCH");
    }
    const source = await inspector.inspectGit(exactInput, auth.context);
    return gitObservation(request, source, expectedBranch, root);
  }
  const capability: TypedCampaignCapability = {
    ...definition,
    execute: read, reconcile: read,
    verify: async (request, receipt) => {
      if (receipt.state !== "succeeded") return false;
      const confirmed = await read(request);
      return confirmed.state === "succeeded" &&
        confirmed.proof.reference === receipt.proof.reference;
    },
  };
  return { definition, capability };
}
