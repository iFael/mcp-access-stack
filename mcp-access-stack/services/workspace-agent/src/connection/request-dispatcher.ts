import type {
  OperationContext,
  RelayRequest,
} from "@vs-code-gpt/shared";
import type { LocalAgent } from "../local-agent.js";

export async function dispatchRelayRequest(
  agent: LocalAgent,
  request: RelayRequest,
  context: OperationContext,
): Promise<unknown> {
  switch (request.operation) {
    case "listWorkspaces":
      return agent.listWorkspaces(context);
    case "listWorkspaceRoots":
      return agent.listWorkspaceRoots(request.input, context);
    case "listFiles":
      return agent.listFiles(request.input, context);
    case "readFile":
      return agent.readFile(request.input, context);
    case "readBinaryFile":
      return agent.readBinaryFile(request.input, context);
    case "writeFile":
      return agent.writeFile(request.input, context);
    case "patchFile":
      return agent.patchFile(request.input, context);
    case "runValidation":
      return agent.runValidation(request.input, context);
    case "runCommand":
      return agent.runCommand(request.input, context);
    case "runPowerShell":
      return agent.runPowerShell(request.input, context);
    case "searchFiles":
      return agent.searchFiles(request.input, context);
    case "inspectGit":
      return agent.inspectGit(request.input, context);
    case "getWorkspaceContext":
      return agent.getWorkspaceContext(request.input, context);
    case "startBackgroundTask":
      return agent.startBackgroundTask(request.input, context);
    case "getBackgroundTask":
      return agent.getBackgroundTask(request.input, context);
    case "waitBackgroundTask":
      return agent.waitBackgroundTask(request.input, context);
    case "listBackgroundTasks":
      return agent.listBackgroundTasks(request.input, context);
    case "cancelBackgroundTask":
      return agent.cancelBackgroundTask(request.input, context);
    case "readBackgroundTaskLogs":
      return agent.readBackgroundTaskLogs(request.input, context);
  }
}
