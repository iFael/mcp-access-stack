import path from "node:path";
import type { CommandPlanExecution, ShellName } from "@vs-code-gpt/shared";
import { classifyCommandExecution } from "./effect-risk-classifier.js";
import type {
  CommandClassification,
  LimitedCommandContext,
  LimitedPackageScriptMetadata,
} from "./types.js";

interface ParsedPackageScriptInvocation {
  name: string;
  consumedArguments: number;
}

export function classifyExplicitCommandExecution(
  shell: ShellName,
  execution: CommandPlanExecution,
  context: LimitedCommandContext,
): CommandClassification {
  const directClassification = classifyCommandExecution(shell, execution);
  const invocation = parsePackageScriptInvocation(execution);
  if (!invocation) return directClassification;

  const script = context.packageMetadata?.scripts.find(
    (entry) => entry.name === invocation.name,
  );
  if (!script) {
    return unknownPackageScriptClassification(
      invocation.name,
      "definition is unavailable in sanitized manifest metadata",
    );
  }

  if (execution.kind !== "argv") return directClassification;
  if (execution.argv.length > invocation.consumedArguments) {
    return unknownPackageScriptClassification(
      script.name,
      "received additional arguments that can alter its declared effect",
    );
  }

  return classificationFromPackageScript(script);
}

function parsePackageScriptInvocation(
  execution: CommandPlanExecution,
): ParsedPackageScriptInvocation | undefined {
  if (execution.kind !== "argv") return undefined;

  const packageManager = path
    .basename(execution.executable)
    .replace(/\.(?:cmd|exe)$/iu, "")
    .toLowerCase();
  if (
    packageManager !== "npm" &&
    packageManager !== "pnpm" &&
    packageManager !== "yarn" &&
    packageManager !== "bun"
  ) {
    return undefined;
  }

  return resolveScriptName(packageManager, execution.argv);
}

function resolveScriptName(
  packageManager: "npm" | "pnpm" | "yarn" | "bun",
  argv: string[],
): ParsedPackageScriptInvocation | undefined {
  const first = argv[0]?.toLowerCase();
  if (!first) return undefined;

  if (first === "run" || (packageManager === "npm" && first === "run-script")) {
    const name = argv[1];
    return name ? { name, consumedArguments: 2 } : undefined;
  }

  if (
    first === "test" &&
    (packageManager === "npm" ||
      packageManager === "pnpm" ||
      packageManager === "yarn")
  ) {
    return { name: "test", consumedArguments: 1 };
  }

  return undefined;
}

function classificationFromPackageScript(
  script: LimitedPackageScriptMetadata,
): CommandClassification {
  return {
    effectClass: script.effectClass,
    riskClass: script.riskClass,
    reasons: [
      `package script ${script.name} classification was inherited from sanitized manifest metadata`,
    ],
  };
}

function unknownPackageScriptClassification(
  scriptName: string,
  reason: string,
): CommandClassification {
  return {
    effectClass: "unknown",
    riskClass: "unknown",
    reasons: [`package script ${scriptName} ${reason}`],
  };
}
