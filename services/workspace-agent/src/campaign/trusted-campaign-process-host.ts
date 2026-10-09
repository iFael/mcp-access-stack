import type { LocalAgent } from "../local-agent.js";
import {
  TrustedCampaignEnrollmentCatalog,
  type TrustedCampaignBindingFactories,
} from "./trusted-campaign-enrollment-catalog.js";
import type {
  TrustedCampaignHostOptions,
  TrustedCampaignAgentLifecycle,
} from "./trusted-campaign-agent-lifecycle.js";
import type { CampaignSupervisorReport } from "./delegated-campaign-supervisor.js";

export interface TrustedCampaignProcessBudgets {
  readonly maxEpochs?: number;
  readonly maxWakesPerEpoch?: number;
}
export interface TrustedCampaignProcessReport extends CampaignSupervisorReport {
  readonly epochs: number;
}

/**
 * Code-only lifecycle hook for an ALREADY AUTHORIZED trusted service.
 *
 * Nothing starts from a constructor or from LocalAgent.create(). A host must
 * explicitly call run(). On each process restart, the host must supply the
 * code-owned factory allowlist and the SAME trusted local state directory.
 * No OS service registration, scheduling or process signal handlers here.
 */
export class TrustedCampaignProcessHost {
  private readonly stopController = new AbortController();
  private active: Promise<TrustedCampaignProcessReport> | undefined;
  private lifecycle: TrustedCampaignAgentLifecycle | undefined;

  constructor(
    private readonly agent: LocalAgent,
    private readonly catalog: TrustedCampaignEnrollmentCatalog,
    private readonly factories: TrustedCampaignBindingFactories,
    private readonly options: TrustedCampaignHostOptions,
  ) {}

  async run(
    externalSignal?: AbortSignal,
    budgets: TrustedCampaignProcessBudgets = {},
  ): Promise<TrustedCampaignProcessReport> {
    const maxEpochs = budgets.maxEpochs ?? 16;
    const maxWakes = budgets.maxWakesPerEpoch ?? 64;
    if (!Number.isSafeInteger(maxEpochs) || maxEpochs < 1 || maxEpochs > 64 ||
        !Number.isSafeInteger(maxWakes) || maxWakes < 1 || maxWakes > 1024) {
      throw new Error("CAMPAIGN_INVALID: bounded service epochs required");
    }
    if (this.active) throw new Error("CAMPAIGN_ALREADY_SUPERVISING");
    if (this.stopController.signal.aborted) throw new Error("CAMPAIGN_HOST_STOPPED");

    const execute = async (): Promise<TrustedCampaignProcessReport> => {
      const signal = externalSignal
        ? AbortSignal.any([externalSignal, this.stopController.signal])
        : this.stopController.signal;
      if (signal.aborted) return { stop: "stopped", epochs: 0, wakes: 0, campaigns: [] };
      const host = await this.agent.createTrustedCampaignHostFromCatalog(
        this.catalog, this.factories, this.options,
      );
      this.lifecycle = host;
      let totalWakes = 0;
      let epochs = 0;
      let report: CampaignSupervisorReport = {
        stop: "wake_budget", wakes: 0, campaigns: [],
      };
      try {
        for (; epochs < maxEpochs && !signal.aborted;) {
          report = await host.serve(maxWakes, signal);
          totalWakes += report.wakes;
          epochs++;
          if (report.stop !== "wake_budget") break;
          // A zero-wake response means no eligible work: never spin
          // indefinitely on a blocked or incompletely enrolled campaign.
          if (report.wakes === 0) break;
        }
        return {
          ...report, epochs, wakes: totalWakes,
          stop: signal.aborted ? "stopped" : report.stop,
        };
      } finally {
        await host.shutdown();
        this.lifecycle = undefined;
      }
    };
    const pending = execute();
    this.active = pending;
    try { return await pending; }
    finally { if (this.active === pending) this.active = undefined; }
  }

  /** Waits for any already-invoked native typed operation to settle. */
  async shutdown(): Promise<void> {
    this.stopController.abort();
    if (this.lifecycle) await this.lifecycle.shutdown();
    if (this.active) await this.active;
  }
}
