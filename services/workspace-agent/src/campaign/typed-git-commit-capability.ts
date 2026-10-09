import { createHash } from "node:crypto";
import {
  canonicalSourceControlArgumentsDigest,
  gitCommitInputSchema,
  gitCommitResultSchema,
  parseMutationReceipt,
  type GitCommitInput,
  type GitCommitResult,
  type MutationReceipt,
  type MutationReceiptIdentity,
  type MutationReceiptStore,
  type OperationContext,
} from "@vs-code-gpt/shared";
import type { LocalAgent } from "../local-agent.js";
import {
  type CampaignInvocation, type CampaignObservation,
  type CampaignObservationIdentity, type TypedCampaignCapability,
} from "./delegated-campaign-coordinator.js";

/**
 * ONLY a trusted agent composer may inject the same receipt store instance
 * used by LocalAgent. Receipt read does not initiate or replay the mutation.
 * This internal adapter performs no shell dispatch and publishes no MCP tool.
 */
export type TypedGitCommitAgent = Pick<LocalAgent, "gitCommit" | "inspectGit">;
export interface TrustedGitCommitBinding {
  agent: TypedGitCommitAgent;
  nativeReceiptStore: MutationReceiptStore;
  input: GitCommitInput;
  expectedBranch: string;
  context: OperationContext;
}
export interface BoundGitCommit {
  readonly definition: Pick<TypedCampaignCapability,
    "action" | "targetResource" | "expectedState" | "argumentsDigest">;
  readonly capability: TypedCampaignCapability;
}
const SHA = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const BRANCH = /^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,127}$/u;
const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function requireBound(request: CampaignInvocation, def: BoundGitCommit["definition"], workspaceId: string): void {
  if (request.workspaceId !== workspaceId || request.action !== def.action ||
      request.targetResource !== def.targetResource ||
      request.expectedState !== def.expectedState ||
      request.argumentsDigest !== def.argumentsDigest) {
    throw new Error("CAMPAIGN_GIT_COMMIT_BINDING_MISMATCH");
  }
}
function idempotencyKey(request: CampaignInvocation): string {
  // The campaign and operation UUIDs are persisted by the ledger and cannot
  // change on replay. They are both required to avoid cross-campaign collisions.
  if (!UUID.test(request.campaignId) ||
      !UUID.test(request.operationId)) {
    throw new Error("CAMPAIGN_INVALID_OPERATION_ID");
  }
  return `campaign:${request.campaignId}:${request.operationId}`;
}
function observationIdentity(request: CampaignInvocation): CampaignObservationIdentity {
  return {
    operationId: request.operationId, targetResource: request.targetResource,
    expectedState: request.expectedState, argumentsDigest: request.argumentsDigest,
  };
}
function requireReceipt(
  receipt: MutationReceipt, identity: MutationReceiptIdentity,
): MutationReceipt {
  const parsed = parseMutationReceipt(receipt);
  if (parsed.identity.workspaceId !== identity.workspaceId ||
      parsed.identity.operation !== identity.operation ||
      parsed.identity.targetResource !== identity.targetResource ||
      parsed.identity.canonicalArgumentsDigest !== identity.canonicalArgumentsDigest ||
      parsed.identity.idempotencyKey !== identity.idempotencyKey) {
    throw new Error("CAMPAIGN_NATIVE_RECEIPT_IDENTITY_MISMATCH");
  }
  return parsed;
}
function successfulReceipt(
  receipt: MutationReceipt,
  expectedRoot: string,
  expectedBranch: string,
): GitCommitResult {
  if (receipt.state !== "completed") throw new Error("CAMPAIGN_NATIVE_RECEIPT_NOT_COMPLETED");
  const result = gitCommitResultSchema.parse(receipt.result);
  if (result.root !== expectedRoot || result.branch !== expectedBranch ||
      !SHA.test(result.commitSha)) {
    throw new Error("CAMPAIGN_NATIVE_COMMIT_RESULT_MISMATCH");
  }
  return result;
}
function commitObservation(
  request: CampaignInvocation, result: GitCommitResult,
): CampaignObservationIdentity & { state: "succeeded"; proof: { kind: "verified"; reference: string } } {
  // This proves historical native completion, NOT that HEAD still points here.
  return {
    ...observationIdentity(request),
    state: "succeeded",
    proof: {
      kind: "verified",
      reference: `git-commit:${result.commitSha}:${sha256(JSON.stringify({
        operationId: request.operationId, result, argumentsDigest: request.argumentsDigest,
      }))}`,
    },
  };
}
export function bindGitCommit(input: TrustedGitCommitBinding): BoundGitCommit {
  if (!input || typeof input.agent?.gitCommit !== "function" ||
      typeof input.agent?.inspectGit !== "function" ||
      typeof input.nativeReceiptStore?.get !== "function" ||
      typeof input.context?.ownerScope !== "string" ||
      input.context.ownerScope.length < 1 || input.context.ownerScope.length > 256) {
    throw new Error("CAMPAIGN_TRUSTED_GIT_COMMIT_BINDING_REQUIRED");
  }
  const parsed = gitCommitInputSchema.parse(input.input);
  const root = parsed.root ?? ".";
  const expectedHead = parsed.expectedHeadSha.toLowerCase();
  const expectedIndex = parsed.expectedIndexTreeSha.toLowerCase();
  const branch = input.expectedBranch;
  if (typeof branch !== "string" || !BRANCH.test(branch) ||
      branch === "main" || branch === "master" ||
      branch.startsWith("/") || branch.includes("..")) {
    throw new Error("CAMPAIGN_UNSAFE_COMMIT_BRANCH");
  }
  const exactInput = { ...parsed, root };
  const nativeArgumentsDigest = canonicalSourceControlArgumentsDigest(exactInput);
  const ownerHash = sha256(input.context.ownerScope);
  const definition = {
    action: "commit",
    targetResource: `git:${parsed.workspaceId}:${root}`,
    expectedState: `head:${expectedHead}:index:${expectedIndex}:branch:${branch}`,
    argumentsDigest: sha256(JSON.stringify({
      nativeArgumentsDigest, ownerHash, branch,
    })),
  } as const;
  const context = { ...input.context };

  function receiptIdentity(request: CampaignInvocation): MutationReceiptIdentity {
    return {
      workspaceId: parsed.workspaceId, operation: "git_commit",
      targetResource: definition.targetResource,
      canonicalArgumentsDigest: nativeArgumentsDigest,
      idempotencyKey: idempotencyKey(request),
    };
  }
  async function readReceipt(request: CampaignInvocation): Promise<CampaignObservation> {
    requireBound(request, definition, parsed.workspaceId);
    const identity = receiptIdentity(request);
    const stored = await input.nativeReceiptStore.get(identity.idempotencyKey);
    if (!stored) {
      // A campaign claim can persist before native reservation. Absence of a
      // receipt does NOT prove the operation was never dispatched.
      return { ...observationIdentity(request), state: "outcome_unknown" };
    }
    const receipt = requireReceipt(stored, identity);
    if (receipt.state !== "completed") {
      return { ...observationIdentity(request), state: "outcome_unknown" };
    }
    return commitObservation(request, successfulReceipt(receipt, root, branch));
  }
  const capability: TypedCampaignCapability = {
    ...definition,
    execute: async request => {
      requireBound(request, definition, parsed.workspaceId);
      // Never redispatch an operation whose native identity was ever reserved.
      const existing = await input.nativeReceiptStore.get(idempotencyKey(request));
      if (existing) return readReceipt(request);
      // The commit API verifies HEAD/index CAS but not an expected feature
      // branch name. Check that separately through the audited typed Git read.
      const currentBranch = await input.agent.inspectGit({
        workspaceId: parsed.workspaceId,
        root,
        diffMode: "none",
      }, context);
      if (currentBranch.workspaceId !== parsed.workspaceId ||
          currentBranch.root !== root ||
          currentBranch.branch !== branch ||
          currentBranch.truncated) {
        throw new Error("CAMPAIGN_GIT_COMMIT_BRANCH_MISMATCH");
      }
      const result = gitCommitResultSchema.parse(await input.agent.gitCommit(
        exactInput,
        {
          ...context,
          idempotencyKey: idempotencyKey(request),
          invocationId: request.operationId,
        },
      ));
      // Native commit may have completed but failed to persist its receipt.
      // Leave unknown, never treat the method's response alone as proof.
      const confirmed = await readReceipt(request);
      if (confirmed.state !== "succeeded") return confirmed;
      const nativeResult = gitCommitResultSchema.parse(result);
      const proof = commitObservation(request, nativeResult);
      if (confirmed.proof.reference !== proof.proof.reference) {
        throw new Error("CAMPAIGN_GIT_COMMIT_RECEIPT_MISMATCH");
      }
      return confirmed;
    },
    reconcile: readReceipt,
    verify: async (request, observation) => {
      if (observation.state !== "succeeded") return false;
      const current = await readReceipt(request);
      return current.state === "succeeded" &&
        current.proof.reference === observation.proof.reference;
    },
  };
  return { definition, capability };
}
