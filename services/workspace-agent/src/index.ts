export { InProcessWorkspaceExecutor } from "./in-process-workspace-executor.js";
export { LocalAgent, type LocalAgentOptions } from "./local-agent.js";
export { CommandConfirmationRegistry, type CommandConfirmationBinding } from "./shell/confirmation.js";
export { WindowsElevationBroker, type ElevationBroker, type ElevatedCommandRequest, type WindowsElevationBrokerOptions } from "./shell/elevation-broker.js";
export { GitHubCommitChecksWatchManager, type GitHubCommitChecksWatchManagerOptions } from "./source-control/github-checks-watch-manager.js";
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
