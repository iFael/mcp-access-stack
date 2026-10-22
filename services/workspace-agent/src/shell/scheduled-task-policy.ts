import type { ShellName } from "@vs-code-gpt/shared";

// Bitdefender's Advanced Threat Control killed the companion after an agent
// used it to register and start an elevated, ExecutionPolicy Bypass task and
// then kept probing Scheduled Tasks from the new node process. A remote agent
// creating persistence looks like an intrusion to endpoint protection, so these
// effects stay with the person at the Windows console; queries remain allowed.
const SCHEDULED_TASK_MUTATION_PATTERNS = [
  /\b(?:register|unregister|set|start|stop|enable|disable)-scheduledtask\b/iu,
  /\bschtasks(?:\.exe)?\b[^\r\n]{0,400}?\/(?:create|delete|change|run|end)\b/iu,
  /\bschedule\.service\b/iu,
] as const;

const EXECUTION_POLICY_BYPASS_PATTERN = /(?:^|\s)-(?:executionpolicy|exec|ep)\s+['"]?bypass\b/iu;

export function scheduledTaskPolicyReason(
  shell: ShellName,
  command: string,
  elevated: boolean,
): string | undefined {
  void shell;
  if (SCHEDULED_TASK_MUTATION_PATTERNS.some((pattern) => pattern.test(command))) {
    return "MCP shells cannot create, change, start or stop Scheduled Tasks. Run that on the Windows console yourself; MCP V3 releases switch only through the MCP V3 local updater.";
  }
  if (elevated && EXECUTION_POLICY_BYPASS_PATTERN.test(command)) {
    return "Elevated MCP commands cannot bypass the PowerShell execution policy.";
  }
  return undefined;
}
