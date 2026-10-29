import { AppError } from "@vs-code-gpt/shared";
import type { LocalAgent } from "../local-agent.js";
import type { McpUpdatePort, McpUpdateRecord, McpUpdateWorkflowCall } from "./mcp-update-runner.js";
import type { ReleaseInstallPort } from "./release-install.js";

const WORKSPACE_ID = "mcp-access-stack";
const REPOSITORY = { owner: "iFael", repository: "mcp-access-stack" } as const;

export interface LocalAgentMcpUpdateCallbacks {
  progress?: McpUpdatePort["progress"];
  finished?: (record: McpUpdateRecord) => void;
  requestCompanionUpdate: McpUpdatePort["requestCompanionUpdate"];
}

/**
 * Each step of an update is the typed operation an agent would call on the
 * execution node, through whichever LocalAgent the current policy built:
 * never a stale one, so a policy reload does not keep an old generation alive.
 */
export function createLocalAgentMcpUpdatePort(agent: () => LocalAgent, callbacks: LocalAgentMcpUpdateCallbacks): McpUpdatePort {
  const workspaceId = WORKSPACE_ID;
  const workflow = (mode: "dispatch" | "reconcile") => async ({ ownerScope, ...call }: McpUpdateWorkflowCall) => {
    const result = await agent().githubWorkflowOperation({ workspaceId, ...REPOSITORY, mode, ...call },
      ownerScope === undefined ? {} : { ownerScope });
    return result.status === "observed"
      ? { status: "observed" as const, runId: result.runId, state: result.state, conclusion: result.conclusion }
      : { status: result.status };
  };
  return {
    mainHead: () => agent().releaseReadGitHubMainHead({ workspaceId, ...REPOSITORY }),
    checks: async (commitSha) => {
      const checks = await agent().githubGetCommitChecks({ workspaceId, ...REPOSITORY, commitSha });
      if (checks.failingCount > 0) return "failed";
      return checks.allCompleted && checks.passed && !checks.truncated ? "passed" : "pending";
    },
    rolloutTarget: (sha) => agent().readEdgeCatalogRollout(sha),
    health: async (origin) => {
      const response = await agent().httpGet({ workspaceId, url: `${origin}/health` });
      const text = response.bodyEncoding === "base64" ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
      const body = JSON.parse(text) as {
        activeContractRevision?: unknown;
        candidateContractRevision?: unknown;
        runtime?: { toolCount?: unknown; connectorInstanceId?: unknown };
      };
      if (response.status !== 200 || typeof body.activeContractRevision !== "string") {
        throw new AppError("INTERNAL_ERROR", `The Edge /health answered ${response.status}.`);
      }
      return {
        activeContractRevision: body.activeContractRevision,
        candidateContractRevision: typeof body.candidateContractRevision === "string" ? body.candidateContractRevision : null,
        toolCount: typeof body.runtime?.toolCount === "number" ? body.runtime.toolCount : null,
        connectorInstanceId: typeof body.runtime?.connectorInstanceId === "string" ? body.runtime.connectorInstanceId : null,
      };
    },
    ...createLocalAgentReleasePort(agent, workspaceId),
    dispatch: workflow("dispatch"),
    reconcile: workflow("reconcile"),
    ciRun: async (headSha) => {
      const runs = await agent().githubRead({ workspaceId, ...REPOSITORY, kind: "workflow_runs", workflow: "ci.yml",
        headSha, branch: "main", event: "push", status: "success", page: 1, perPage: 10 });
      const ids = runs.items.map((run) => run.id).filter((id): id is number => typeof id === "number");
      return ids.length === 0 ? null : Math.max(...ids);
    },
    requestCompanionUpdate: callbacks.requestCompanionUpdate,
    ...(callbacks.progress === undefined ? {} : { progress: callbacks.progress }),
    ...(callbacks.finished === undefined ? {} : { finished: callbacks.finished }),
  };
}

/** prepare_release and promote_release in one workspace of the current LocalAgent, as an agent would call them. */
export function createLocalAgentReleasePort(agent: () => LocalAgent, workspaceId: string): ReleaseInstallPort {
  const confirmation = (value: { confirmationId?: string | undefined; reasons?: string[] | undefined; expiresAt?: string | undefined }) => {
    if (value.confirmationId === undefined) throw new AppError("INTERNAL_ERROR", "A confirmation without a confirmationId.");
    return { status: "confirmation_required" as const, confirmationId: value.confirmationId, reasons: value.reasons ?? [], expiresAt: value.expiresAt ?? "" };
  };
  return {
    releaseState: async () => {
      const { state } = await agent().getReleaseState({ workspaceId });
      return { active: state.active?.releaseId ?? null, candidate: state.candidate?.releaseId ?? null };
    },
    prepare: async (tag, confirmationId) => {
      const result = await agent().prepareRelease({ workspaceId, tag, ...(confirmationId === undefined ? {} : { confirmationId }) });
      if (result.status === "confirmation_required") return confirmation(result);
      if (result.task === undefined) throw new AppError("INTERNAL_ERROR", "prepare_release started no task.");
      return { status: "started", taskId: result.task.id };
    },
    task: async (taskId) => {
      const { task } = await agent().getBackgroundTask({ workspaceId, id: taskId });
      if (task === null) throw new AppError("TASK_NOT_FOUND", `Background task ${taskId} is gone.`);
      return task.state === "succeeded" ? "succeeded" : task.state === "starting" || task.state === "running" ? "running" : "failed";
    },
    promote: async (releaseId, confirmationId) => {
      const result = await agent().promoteRelease({ workspaceId, releaseId, ...(confirmationId === undefined ? {} : { confirmationId }) });
      return result.status === "confirmation_required" ? confirmation(result) : { status: "handover_started" };
    },
  };
}
