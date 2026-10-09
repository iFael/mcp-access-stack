import {
  type CampaignRecord, DelegatedCampaignLedger,
} from "./delegated-campaign-ledger.js";
import {
  DelegatedCampaignCoordinator,
  type TypedCampaignCapability, type CampaignRunResult,
} from "./delegated-campaign-coordinator.js";

export interface BoundedCampaignSession {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly maxPasses: number;
  readonly maxStepsPerPass: number;
}
export interface CampaignSessionResult extends CampaignRunResult {
  readonly passes: number;
}
/**
 * A bounded entrypoint for an ALREADY trusted supervising process.
 * Campaigns can be resumed from durable state with newly reconstructed typed
 * bindings. It does NOT schedule itself or run after a ChatGPT turn ends.
 */
export class DelegatedCampaignSessionRunner {
  constructor(
    private readonly ledger: DelegatedCampaignLedger,
    private readonly bindTrustedCapabilities:
      (plan: CampaignRecord) => Promise<ReadonlyMap<string, TypedCampaignCapability>>,
  ) {}

  async run(input: BoundedCampaignSession): Promise<CampaignSessionResult> {
    if (!Number.isSafeInteger(input.maxPasses) || input.maxPasses < 1 || input.maxPasses > 16 ||
        !Number.isSafeInteger(input.maxStepsPerPass) ||
        input.maxStepsPerPass < 1 || input.maxStepsPerPass > 128) {
      throw new Error("CAMPAIGN_INVALID: bounded pass/step budget required");
    }
    let executed = 0, reconciled = 0;
    for (let i = 0; i < input.maxPasses; i++) {
      // Re-read persisted authorization and bind typed capabilities fresh.
      // The coordinator itself verifies EVERY action against that persisted
      // definition before invoking any step.
      const plan = await this.ledger.get(input.workspaceId, input.campaignId);
      if (!plan) throw new Error("CAMPAIGN_NOT_FOUND");
      const bindings = await this.bindTrustedCapabilities(plan);
      const current = await new DelegatedCampaignCoordinator(this.ledger, bindings)
        .run(input.workspaceId, input.campaignId, input.maxStepsPerPass);
      executed += current.executed;
      reconciled += current.reconciled;
      if (current.stop !== "step_budget") {
        return { ...current, executed, reconciled, passes: i + 1 };
      }
    }
    const record = await this.ledger.get(input.workspaceId, input.campaignId);
    if (!record) throw new Error("CAMPAIGN_NOT_FOUND");
    return {
      stop: "step_budget", executed, reconciled, campaign: record,
      passes: input.maxPasses,
    };
  }
}
