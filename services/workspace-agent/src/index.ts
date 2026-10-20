export { InProcessWorkspaceExecutor } from "./in-process-workspace-executor.js";
export { LocalAgent, type LocalAgentOptions } from "./local-agent.js";
export { loadOracleControlBindingFromEnvironment } from "./release/oracle-control-host-binding.js";
export { createOracleReleaseGitHubReadPort } from "./release/oracle-github-read-port.js";
export {createOracleCandidateReadPort} from "./release/oracle-candidate-host-port.js";
export {createOracleActiveReadPort} from "./release/oracle-active-host-port.js";
export type {OracleCandidateHostConfig} from "./release/oracle-candidate-host-port.js";
export type {OracleCandidateReadResult} from "./release/oracle-candidate-read.js";
export { createOracleReleaseGitHubWorkflowPort } from "./release/oracle-github-workflow-port.js";
export type {OracleReleaseGitHubWorkflowPolicy} from "./release/oracle-github-workflow-port.js";
export type {OracleReleaseGitHubReadConfig} from "./release/oracle-github-read-port.js";
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
