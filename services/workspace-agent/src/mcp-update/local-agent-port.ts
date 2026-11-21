import { AppError } from "@vs-code-gpt/shared";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { LocalAgent } from "../local-agent.js";
import type { McpUpdatePort, McpUpdateRecord, McpUpdateWorkflowCall } from "./mcp-update-runner.js";
import type { CutoverReceipt, ReleaseInstallPort } from "./release-install.js";

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
    tagCommit: async (tag) => {
      const refs = await agent().githubRead({ workspaceId, ...REPOSITORY, kind: "refs",
        refType: "tags", prefix: tag, page: 1, perPage: 100 });
      if (refs.nextPage !== undefined) {
        throw new AppError("INTERNAL_ERROR", "GitHub tag inventory is incomplete.");
      }
      const exact = refs.items.filter((entry) => entry.ref === `refs/tags/${tag}`);
      if (exact.length === 0) return null;
      if (exact.length !== 1 || exact[0]?.type !== "commit" || typeof exact[0]?.sha !== "string" ||
          !/^[a-f0-9]{40}$/u.test(exact[0].sha)) {
        throw new AppError("INTERNAL_ERROR", "GitHub tag ref is not a verified commit.");
      }
      return exact[0].sha;
    },
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
    companionReleased: async (tag) => {
      const releases = await agent().githubRead({ workspaceId, ...REPOSITORY, kind: "releases", page: 1, perPage: 100 });
      const release = releases.items.find((item) => item.tag === tag && item.draft === false);
      const assets = Array.isArray(release?.assets) ? release.assets : [];
      const archive = `${tag}-windows-x64.zip`;
      return [archive, `${archive}.sha256`].every((name) => assets.some((asset) => asset.startsWith(`${name} (`)));
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
    // As the user who asked for the update, so they can read the task it starts (and are woken about) themselves.
    prepare: async (tag, confirmationId, ownerScope) => {
      const result = await agent().prepareRelease({ workspaceId, tag, ...(confirmationId === undefined ? {} : { confirmationId }) },
        ownerScope === undefined ? {} : { ownerScope });
      if (result.status === "confirmation_required") return confirmation(result);
      if (result.task === undefined) throw new AppError("INTERNAL_ERROR", "prepare_release started no task.");
      return { status: "started", taskId: result.task.id };
    },
    task: async (taskId, ownerScope) => {
      const { task } = await agent().getBackgroundTask({ workspaceId, id: taskId }, ownerScope === undefined ? {} : { ownerScope });
      if (task === null) throw new AppError("TASK_NOT_FOUND", `Background task ${taskId} is gone.`);
      return task.state === "succeeded" ? "succeeded" : task.state === "starting" || task.state === "running" ? "running" : "failed";
    },
    promote: async (releaseId, confirmationId) => {
      const result = await agent().promoteRelease({ workspaceId, releaseId, ...(confirmationId === undefined ? {} : { confirmationId }) });
      if (result.status === "confirmation_required") return confirmation(result);
      const cutoverReceipt: CutoverReceipt = {
        releaseId: result.releaseId, requestId: result.requestId,
        installationRoot: result.installationRoot, resultPath: result.resultPath,
      };
      return { status: "handover_started", ...(workspaceId === WORKSPACE_ID ? { cutoverReceipt } : {}) };
    },
    cutoverStatus: async (receipt) => {
      if (workspaceId !== WORKSPACE_ID ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(receipt.requestId)) {
        throw new AppError("EXECUTION_OUTCOME_UNKNOWN", "Invalid Oracle cutover receipt identity.");
      }
      const installed = await agent().getReleaseState({ workspaceId });
      if (path.resolve(installed.installationRoot) !== path.resolve(receipt.installationRoot)) {
        throw new AppError("EXECUTION_OUTCOME_UNKNOWN", "Oracle cutover installation root changed since handoff.");
      }
      const expectedPath = path.resolve(receipt.installationRoot, "state", "linux-cutover-runs", receipt.requestId, "result.json");
      if (path.resolve(receipt.resultPath) !== expectedPath) {
        throw new AppError("EXECUTION_OUTCOME_UNKNOWN", "Oracle cutover result path does not match its handoff.");
      }
      let info;
      try { info = await lstat(expectedPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      if (!info.isFile() || info.size > 65_536) {
        throw new AppError("EXECUTION_OUTCOME_UNKNOWN", "Oracle cutover result is not a bounded regular file.");
      }
      let result: unknown;
      try { result = JSON.parse(await readFile(expectedPath, "utf8")); }
      catch { throw new AppError("EXECUTION_OUTCOME_UNKNOWN", "Oracle cutover result is not readable JSON."); }
      if (!result || typeof result !== "object" || !("schemaVersion" in result) || result.schemaVersion !== 1 ||
          !("requestId" in result) ||
          result.requestId !== receipt.requestId || !("releaseId" in result) || result.releaseId !== receipt.releaseId ||
          !("status" in result) || (result.status !== "passed" && result.status !== "failed")) {
        throw new AppError("EXECUTION_OUTCOME_UNKNOWN", "Oracle cutover terminal receipt is invalid.");
      }
      return result.status;
    },
  };
}
