#!/usr/bin/env node
import { runTrustedCampaignService } from "./trusted-campaign-service-entrypoint.js";

/** OS service process entrypoint. Execution must be an explicit privileged
 * deployment decision; importing the agent never launches a campaign.
 */
async function main(): Promise<void> {
  if (process.argv.length !== 3 || (process.getuid && process.getuid() === 0)) {
    throw new Error("CAMPAIGN_SERVICE_INVALID_INVOCATION");
  }
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const report = await runTrustedCampaignService(process.argv[2]!, {
      signal: controller.signal,
    });
    if (report.stop === "needs_attention" || report.stop === "wake_budget") {
      throw new Error("CAMPAIGN_SERVICE_NEEDS_ATTENTION");
    }
    process.stdout.write(JSON.stringify({
      stop: report.stop, epochs: report.epochs, wakes: report.wakes,
    }) + "\n");
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
void main().catch(() => {
  // No paths, policy content, factory owner scopes or secrets in journal.
  process.stderr.write("CAMPAIGN_SERVICE_START_FAILED\n");
  process.exitCode = 1;
});
