import { CampaignResourceClaims } from "../../../src/campaign/campaign-resource-claims.js";
import type { CampaignRecord } from "../../../src/campaign/delegated-campaign-ledger.js";

type Command = {
  action: "reserve" | "release" | "shutdown";
  record?: CampaignRecord;
};
const [, , stateDirectory, canonicalRoot] = process.argv;
if (!stateDirectory || !canonicalRoot) throw new Error("FIXTURE_MISSING_STATE_ROOT");
const claims = new CampaignResourceClaims(stateDirectory);
const send = (kind: string, message?: string) =>
  process.send?.({ kind, pid: process.pid, message });

process.on("message", (value: unknown) => {
  if (!value || typeof value !== "object" || !("action" in value)) return;
  const command = value as Command;
  if (command.action === "shutdown") {
    process.exit(0);
    return;
  }
  if (!command.record) {
    send("failed", "CAMPAIGN_MISSING_RECORD");
    return;
  }
  const operation = command.action === "reserve"
    ? claims.reserve(canonicalRoot, command.record)
    : command.action === "release"
      ? claims.releaseCompleted(canonicalRoot, command.record)
      : Promise.reject(new Error("CAMPAIGN_INVALID_COMMAND"));
  void operation.then(() => send("success")).catch(error =>
    send("failed", error instanceof Error ? error.message : "UNKNOWN_ERROR"),
  );
});
send("ready");
