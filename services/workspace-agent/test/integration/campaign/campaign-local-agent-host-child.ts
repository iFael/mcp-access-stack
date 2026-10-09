import path from "node:path";
import { LocalAgent } from "../../../src/local-agent.js";
import { FileMutationReceiptStore } from "../../../src/source-control/file-mutation-receipt-store.js";
import { bindGitCommit } from "../../../src/campaign/typed-git-commit-capability.js";
import type { TypedCampaignCapability } from "../../../src/campaign/delegated-campaign-coordinator.js";

type Message = { kind: "ready" | "executing" | "result" | "error"; pid: number; status?: string; detail?: string; operationId?: string };
type Command = { action: "start" | "release" | "shutdown" };
const [, , policyFile, localStateDirectory, campaignId, nativeHead, nativeIndex] = process.argv;
if (!policyFile || !localStateDirectory || !campaignId) {
  throw new Error("FIXTURE_TRUSTED_HOST_ARGS");
}
const SHA = /^[a-f0-9]{40}$/u;
if ((nativeHead || nativeIndex) && (!nativeHead || !nativeIndex || !SHA.test(nativeHead) || !SHA.test(nativeIndex))) {
  throw new Error("FIXTURE_INVALID_NATIVE_CAS");
}
const send = (msg: Omit<Message, "pid">) => process.send?.({ ...msg, pid: process.pid });
const ownerScope = "fixture:trusted-full-host";
const workspaceId = "test";
let release: (() => void) | undefined;
let executing: Promise<unknown> | undefined;
const agent = await LocalAgent.create(policyFile);
const host = agent.createTrustedCampaignHost([{
  workspaceId,
  campaignId,
  ownerScope,
  bind: async (trustedAgent, plan) => new Map<string, TypedCampaignCapability>(
    plan.tasks.map((task): [string, TypedCampaignCapability] => {
      if (nativeHead && nativeIndex) {
        const bound = bindGitCommit({
          agent: trustedAgent,
          nativeReceiptStore: new FileMutationReceiptStore(path.join(localStateDirectory, "workspace")),
          input: {
            workspaceId: "test", root: ".", message: "Native OS campaign commit",
            expectedHeadSha: nativeHead, expectedIndexTreeSha: nativeIndex,
          },
          expectedBranch: "feature/delegated",
          context: { ownerScope },
        });
        return [task.id, {
          ...bound.capability,
          execute: async request => {
            send({ kind: "executing", operationId: request.operationId });
            await new Promise<void>(resolve => { release = resolve });
            return bound.capability.execute(request);
          },
        }];
      }
      return [task.id, {
      action: task.action,
      targetResource: task.targetResource,
      expectedState: task.expectedState,
      argumentsDigest: task.argumentsDigest,
      execute: async request => {
        send({ kind:"executing", operationId: request.operationId });
        await new Promise<void>(resolve => {release = resolve});
        return {
          operationId: request.operationId,
          targetResource: request.targetResource,
          expectedState: request.expectedState,
          argumentsDigest: request.argumentsDigest,
          state: "succeeded" as const,
          proof: {kind: "verified" as const, reference: "synthetic-native-receipt:" + request.operationId},
        };
      },
      reconcile: async request => ({
        operationId: request.operationId, targetResource: request.targetResource,
        expectedState: request.expectedState, argumentsDigest: request.argumentsDigest,
        state: "outcome_unknown" as const,
      }),
      verify: async (request, observation) => observation.state === "succeeded" &&
        observation.proof.reference === "synthetic-native-receipt:" + request.operationId,
    }];
    }),
  ),
}], {stateDirectory:localStateDirectory, supervisor:{maxStepsPerWake:1}});
process.on("message", (raw:unknown) => {
  if(!raw||typeof raw!=="object"||!("action" in raw)) return;
  const {action}=raw as Command;
  if(action==="start"){
    if(executing) return void send({kind:"error",detail:"FIXTURE_ALREADY_RUNNING"});
    executing = host.serve(1).then(report =>
      send({kind:"result",status:report.stop}),
    ).catch(error => send({
      kind:"error",detail:error instanceof Error ? error.message : "UNKNOWN",
    })).finally(()=>{executing=undefined});
  } else if (action==="release") {
    release?.();
  } else if (action==="shutdown") {
    release?.();
    void (async()=>{
      await host.shutdown();
      process.exit(0);
    })().catch(()=>process.exit(1));
  }
});
send({kind:"ready"});
