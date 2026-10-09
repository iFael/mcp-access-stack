import {
  type CampaignAction,
  type CampaignProof,
  type CampaignRecord,
  type CampaignStep,
  type CampaignTask,
  DelegatedCampaignLedger,
} from "./delegated-campaign-ledger.js";

/**
 * This is an INTERNAL coordination port. Its implementation must be supplied
 * by the trusted MCP V3 agent using a specific typed tool, not generic shell
 * commands, tool-name strings, or request payloads supplied by the campaign.
 */
export interface TypedCampaignCapability {
  readonly action: CampaignAction;
  readonly targetResource: string;
  readonly expectedState: string;
  readonly argumentsDigest: string;
  execute(request: CampaignInvocation): Promise<CampaignObservation>;
  reconcile(request: CampaignInvocation): Promise<CampaignObservation>;
  /** Read-only verification against authoritative tool/CI/CAS evidence. */
  verify(request: CampaignInvocation, receipt: CampaignObservation): Promise<boolean>;
}
export interface CampaignInvocation {
  campaignId: string;
  workspaceId: string;
  taskId: string;
  operationId: string;
  action: CampaignAction;
  targetResource: string;
  expectedState: string;
  argumentsDigest: string;
}
export type CampaignObservation =
  | (CampaignObservationIdentity & {
      state: "succeeded" | "failed" | "not_started";
      proof: CampaignProof;
    })
  | (CampaignObservationIdentity & { state: "in_progress" | "outcome_unknown" });
export interface CampaignObservationIdentity {
  operationId: string;
  targetResource: string;
  expectedState: string;
  argumentsDigest: string;
}
export type CampaignRunStop =
  | "all_completed" | "awaiting_reconciliation" | "no_runnable_step" | "step_budget";
export interface CampaignRunResult {
  stop: CampaignRunStop;
  executed: number;
  reconciled: number;
  campaign: CampaignRecord;
}

function assertBinding(task: CampaignStep, capability: TypedCampaignCapability | undefined): asserts capability is TypedCampaignCapability {
  if (!capability || capability.action !== task.action ||
      capability.targetResource !== task.targetResource ||
      capability.expectedState !== task.expectedState ||
      capability.argumentsDigest !== task.argumentsDigest ||
      typeof capability.execute !== "function" ||
      typeof capability.reconcile !== "function" ||
      typeof capability.verify !== "function") {
    throw new Error("CAMPAIGN_BINDING_MISMATCH: typed capability must exactly match the persisted task");
  }
}

function validateObservation(
  output: CampaignObservation,
  task: CampaignTask,
  operationId: string,
): CampaignObservation {
  if (!output || typeof output !== "object" ||
      output.operationId !== operationId ||
      output.targetResource !== task.targetResource ||
      output.expectedState !== task.expectedState ||
      output.argumentsDigest !== task.argumentsDigest) {
    throw new Error("CAMPAIGN_OBSERVATION_MISMATCH: operation/resource/CAS identity changed");
  }
  if (output.state === "succeeded" || output.state === "failed" || output.state === "not_started") {
    if (output.proof?.kind !== "verified" ||
        typeof output.proof.reference !== "string" ||
        output.proof.reference.length < 1 || output.proof.reference.length > 300) {
      throw new Error("CAMPAIGN_UNVERIFIED: terminal observation requires bounded verification");
    }
    return output;
  }
  if (output.state !== "in_progress" && output.state !== "outcome_unknown") {
    throw new Error("CAMPAIGN_OBSERVATION_INVALID: unknown terminal state");
  }
  return output;
}

/**
 * The coordinator never creates an actual MCP capability and never treats
 * campaign authorization as a substitute for the tool's native permissions.
 * One run has an exclusive lock; after a crash it must be reconciled, NOT
 * automatically cleared.
 */
export class DelegatedCampaignCoordinator {
  constructor(
    private readonly ledger: DelegatedCampaignLedger,
    private readonly boundCapabilities: ReadonlyMap<string, TypedCampaignCapability>,
  ) {}

  async run(workspaceId: string, campaignId: string, maxSteps = 32): Promise<CampaignRunResult> {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 128) {
      throw new Error("CAMPAIGN_INVALID: bounded maxSteps required");
    }
    return this.ledger.withExclusiveRun(workspaceId, campaignId, async () => {
      const initial = await this.requireCampaign(workspaceId, campaignId);
      // Full preflight precedes the FIRST claim, including future tasks.
      for (const task of initial.tasks) assertBinding(task, this.boundCapabilities.get(task.id));

      const visited = new Set<string>();
      let executed = 0;
      let reconciled = 0;
      for (let steps = 0; steps < maxSteps; steps++) {
        const current = await this.requireCampaign(workspaceId, campaignId);
        if (current.tasks.every(t => t.state === "completed")) {
          return { stop: "all_completed", executed, reconciled, campaign: current };
        }
        // Reconcile each existing operation at most once per run. Never
        // dispatch a saved in-flight or outcome_unknown step again.
        const unresolved = current.tasks.find(t =>
          (t.state === "in_flight" || t.state === "outcome_unknown") &&
          !visited.has(t.id),
        );
        if (unresolved) {
          visited.add(unresolved.id);
          reconciled += 1;
          await this.reconcileExisting(current, unresolved);
          continue;
        }
        if (current.tasks.some(t => t.state === "in_flight")) {
          return { stop: "awaiting_reconciliation", executed, reconciled, campaign: current };
        }
        const claim = await this.ledger.claimNext(workspaceId, campaignId);
        if (claim.disposition !== "claimed") {
          const campaign = claim.campaign;
          return {
            stop: campaign.tasks.some(t => t.state === "outcome_unknown")
              ? "awaiting_reconciliation" : "no_runnable_step",
            executed, reconciled, campaign,
          };
        }
        const task = claim.campaign.tasks.find(t => t.id === claim.taskId);
        if (!task) throw new Error("CAMPAIGN_INVALID: claimed task disappeared");
        assertBinding(task, this.boundCapabilities.get(task.id));
        executed += 1;
        // Never invoke a previously-claimed operation in the same run.
        visited.add(task.id);
        try {
          const request = this.invocation(claim.campaign, task, claim.operationId);
          const port = this.boundCapabilities.get(task.id)!;
          const output = validateObservation(
            await port.execute(request), task, claim.operationId,
          );
          await this.verifyTerminal(port, request, output);
          await this.applyObservation(claim.campaign, task, output);
        } catch {
          // Remote effects may have happened before an exception/timeout.
          await this.ledger.transition(workspaceId, campaignId, task.id,
            claim.operationId, "outcome_unknown");
        }
      }
      const campaign = await this.requireCampaign(workspaceId, campaignId);
      return {
        stop: campaign.tasks.every(t => t.state === "completed") ? "all_completed" : "step_budget",
        executed, reconciled, campaign,
      };
    });
  }

  private async requireCampaign(workspaceId: string, id: string): Promise<CampaignRecord> {
    const campaign = await this.ledger.get(workspaceId, id);
    if (!campaign) throw new Error("CAMPAIGN_NOT_FOUND");
    return campaign;
  }

  private invocation(campaign: CampaignRecord, task: CampaignTask, operationId: string): CampaignInvocation {
    return {
      campaignId: campaign.campaignId, workspaceId: campaign.workspaceId,
      taskId: task.id, operationId, action: task.action,
      targetResource: task.targetResource, expectedState: task.expectedState,
      argumentsDigest: task.argumentsDigest,
    };
  }

  private async reconcileExisting(campaign: CampaignRecord, task: CampaignTask): Promise<void> {
    if (!task.operationId) throw new Error("CAMPAIGN_INVALID: missing operationId");
    const capability = this.boundCapabilities.get(task.id)!;
    try {
      const request = this.invocation(campaign, task, task.operationId);
      const output = validateObservation(
        await capability.reconcile(request), task, task.operationId,
      );
      await this.verifyTerminal(capability, request, output);
      await this.applyObservation(campaign, task, output);
    } catch {
      // A broken/mismatched reconciliation MUST NOT imply failure/success.
      if (task.state === "in_flight") {
        await this.ledger.transition(campaign.workspaceId, campaign.campaignId,
          task.id, task.operationId, "outcome_unknown");
      }
    }
  }

  private async verifyTerminal(
    port: TypedCampaignCapability,
    request: CampaignInvocation,
    result: CampaignObservation,
  ): Promise<void> {
    if (result.state === "succeeded" || result.state === "failed" || result.state === "not_started") {
      if (await port.verify(request, result) !== true) {
        throw new Error("CAMPAIGN_UNVERIFIED: external proof did not pass typed verification");
      }
    }
  }

  private async applyObservation(
    campaign: CampaignRecord,
    task: CampaignTask,
    output: CampaignObservation,
  ): Promise<void> {
    if (!task.operationId) throw new Error("CAMPAIGN_INVALID: missing operationId");
    if (output.state === "succeeded") {
      await this.ledger.transition(campaign.workspaceId, campaign.campaignId,
        task.id, task.operationId, "completed", output.proof);
    } else if (output.state === "failed" || output.state === "not_started") {
      await this.ledger.transition(campaign.workspaceId, campaign.campaignId,
        task.id, task.operationId, output.state === "failed" ? "failed" : "blocked", output.proof);
    } else if (output.state === "outcome_unknown" && task.state === "in_flight") {
      await this.ledger.transition(campaign.workspaceId, campaign.campaignId,
        task.id, task.operationId, "outcome_unknown");
    }
    // in_progress is deliberately left in_flight. The run must stop, not retry.
  }
}
