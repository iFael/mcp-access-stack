export { AgentConnection } from "./connection/service.js";
export { InProcessWorkspaceExecutor } from "./in-process-workspace-executor.js";
export { LocalAgent, type LocalAgentOptions } from "./local-agent.js";
export {
  BackgroundTaskManager,
  BACKGROUND_TASK_STATES,
  type BackgroundTaskManagerOptions,
  type BackgroundTaskRecord,
  type BackgroundTaskRunner,
  type BackgroundTaskState,
  type StartBackgroundTaskInput,
} from "./tasks/background-task-manager.js";
export {
  applyPolicyFile,
  validatePolicyFile,
  type PolicyApplyResult,
  type PolicyValidationResult,
} from "./policy-deployment.js";
export { SubprocessWorkspaceExecutor } from "./subprocess-workspace-executor.js";
