import {
  AppError,
  directRunCommandInputSchema,
  disabledQualifiedCommandFeatureFlags,
  qualifiedRunCommandInputSchema,
  type DirectRunCommandInput,
  type QualifiedCommandFeatureFlags,
  type QualifiedRunCommandInput,
  type RunCommandInput,
} from "@vs-code-gpt/shared";

export type RoutedRunCommandInput =
  | {
      mode: "direct";
      input: DirectRunCommandInput;
    }
  | {
      mode: "qualified";
      input: QualifiedRunCommandInput;
    };

export function routeRunCommandInput(
  input: RunCommandInput,
  flags: QualifiedCommandFeatureFlags = disabledQualifiedCommandFeatureFlags,
): RoutedRunCommandInput {
  if (isQualifiedInput(input)) {
    const qualified = qualifiedRunCommandInputSchema.parse(input);
    if (!flags.qualifiedExecution) {
      throw new AppError(
        "CAPABILITY_UNSUPPORTED",
        "Qualified command execution is disabled.",
      );
    }
    if (
      qualified.autoCorrection === "safe" &&
      !flags.safeAutoCorrection
    ) {
      throw new AppError(
        "CAPABILITY_UNSUPPORTED",
        "Safe command autocorrection is disabled.",
      );
    }
    return { mode: "qualified", input: qualified };
  }

  return {
    mode: "direct",
    input: directRunCommandInputSchema.parse(input),
  };
}

function isQualifiedInput(input: RunCommandInput): boolean {
  return (
    "objective" in input ||
    ("executionMode" in input && input.executionMode === "qualified")
  );
}
