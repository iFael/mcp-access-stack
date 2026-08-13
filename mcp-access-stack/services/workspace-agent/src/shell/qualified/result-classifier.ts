import type {
  CommandDiagnosis,
  CommandPlan,
  CommandPostconditionResult,
  RunCommandResult,
} from "@vs-code-gpt/shared";

export interface QualifiedResultClassification {
  successful: boolean;
  diagnosis?: CommandDiagnosis;
}

interface DiagnosisRule {
  category: CommandDiagnosis["category"];
  confidence: number;
  pattern: RegExp;
  message: string;
}

const RULES: DiagnosisRule[] = [
  {
    category: "authentication_failed",
    confidence: 0.99,
    pattern: /\b(authentication failed|invalid credentials?|invalid token|login failed|unauthenticated)\b/iu,
    message: "Command output indicates an authentication failure.",
  },
  {
    category: "authorization_failed",
    confidence: 0.99,
    pattern: /\b(authorization failed|access denied|forbidden|not authorized)\b/iu,
    message: "Command output indicates an authorization failure.",
  },
  {
    category: "permission_denied",
    confidence: 0.98,
    pattern: /\b(permission denied|operation not permitted|eacces|eperm)\b/iu,
    message: "Command output indicates a local permission failure.",
  },
  {
    category: "executable_unavailable",
    confidence: 0.99,
    pattern:
      /\b(command not found|is not recognized as an internal or external command|not recognized as the name of a cmdlet|executable file not found)\b/iu,
    message: "Command output indicates that an executable is unavailable.",
  },
  {
    category: "dependency_missing",
    confidence: 0.96,
    pattern:
      /\b(cannot find module|module not found|could not resolve dependency|missing dependency|package .* not found)\b/iu,
    message: "Command output indicates a missing dependency.",
  },
  {
    category: "configuration_missing",
    confidence: 0.94,
    pattern:
      /\b(configuration|config(?:uration)? file)\b[^\r\n]{0,120}\b(not found|missing|required)\b/iu,
    message: "Command output indicates missing configuration.",
  },
  {
    category: "resource_locked",
    confidence: 0.96,
    pattern:
      /\b(resource busy|file is being used by another process|sharing violation|locked by another process|ebusy)\b/iu,
    message: "Command output indicates a locked resource.",
  },
  {
    category: "transient_failure",
    confidence: 0.8,
    pattern:
      /\b(econnreset|econnrefused|etimedout|temporary failure|temporarily unavailable|service unavailable|connection reset)\b/iu,
    message: "Command output indicates a potentially transient failure.",
  },
  {
    category: "argument_incompatible",
    confidence: 0.96,
    pattern:
      /\b(unknown option|unrecognized option|invalid option|unknown argument|unexpected argument|unsupported option)\b/iu,
    message: "Command output indicates an incompatible argument or option.",
  },
  {
    category: "wrong_working_directory",
    confidence: 0.88,
    pattern:
      /\b(not a git repository|package\.json[^\r\n]{0,80}(not found|missing)|no such project|workspace .* not found)\b/iu,
    message: "Command output may indicate the wrong working directory.",
  },
  {
    category: "path_not_found",
    confidence: 0.94,
    pattern:
      /\b(no such file or directory|path .* not found|cannot find path|file not found|enoent)\b/iu,
    message: "Command output indicates a missing path.",
  },
  {
    category: "quoting",
    confidence: 0.93,
    pattern:
      /\b(unterminated quoted string|unexpected eof while looking for matching|missing terminator|unmatched quote)\b/iu,
    message: "Command output indicates a quoting or escaping error.",
  },
  {
    category: "syntax",
    confidence: 0.9,
    pattern:
      /\b(syntax error|parsererror|unexpected token|parse error|incorrect syntax)\b/iu,
    message: "Command output indicates a syntax error.",
  },
];

export function classifyQualifiedCommandResult(
  plan: CommandPlan,
  result: Extract<RunCommandResult, { status: "executed" }>,
  postcondition: CommandPostconditionResult,
): QualifiedResultClassification {
  if (result.timedOut) {
    return {
      successful: false,
      diagnosis: diagnosis(
        "timeout",
        1,
        "The command attempt exceeded its effective deadline.",
      ),
    };
  }

  if (result.exitCode === 0 && postcondition.passed) {
    return { successful: true };
  }

  if (result.exitCode === 0 && !postcondition.passed) {
    return {
      successful: false,
      diagnosis: diagnosis(
        "application_failed",
        1,
        "The command exited successfully but one or more postconditions failed.",
      ),
    };
  }

  const output = `${result.stderr}\n${result.stdout}`.slice(0, 200_000);
  for (const rule of RULES) {
    if (rule.pattern.test(output)) {
      return {
        successful: false,
        diagnosis: diagnosis(
          rule.category,
          rule.confidence,
          rule.message,
        ),
      };
    }
  }

  if (isTestPlan(plan)) {
    return {
      successful: false,
      diagnosis: diagnosis(
        "test_failed",
        0.95,
        "The qualified test command exited unsuccessfully.",
      ),
    };
  }
  if (isBuildPlan(plan)) {
    return {
      successful: false,
      diagnosis: diagnosis(
        "build_failed",
        0.95,
        "The qualified build command exited unsuccessfully.",
      ),
    };
  }

  return {
    successful: false,
    diagnosis: diagnosis(
      "application_failed",
      0.7,
      "The command attempt exited unsuccessfully without a more specific deterministic classification.",
    ),
  };
}

function diagnosis(
  category: CommandDiagnosis["category"],
  confidence: number,
  message: string,
): CommandDiagnosis {
  return {
    category,
    confidence,
    source: "deterministic",
    message,
  };
}

function isTestPlan(plan: CommandPlan): boolean {
  if (plan.provenance.recipeId?.includes("test")) return true;
  if (plan.objective && /\b(test|tests|teste|testes)\b/iu.test(plan.objective)) {
    return true;
  }
  if (plan.execution.kind === "argv") {
    return plan.execution.argv.some((value) => /^(?:test|tests|jest|vitest)$/iu.test(value));
  }
  return /\b(jest|vitest|mocha|playwright\s+test|npm\s+(?:run\s+)?test)\b/iu.test(
    plan.execution.script,
  );
}

function isBuildPlan(plan: CommandPlan): boolean {
  if (plan.provenance.recipeId?.includes("build")) return true;
  if (plan.objective && /\b(build|compilar|compilação)\b/iu.test(plan.objective)) {
    return true;
  }
  if (plan.execution.kind === "argv") {
    return plan.execution.argv.some((value) => /^(?:build|compile)$/iu.test(value));
  }
  return /\b(build|tsc|webpack|vite\s+build|dotnet\s+build)\b/iu.test(
    plan.execution.script,
  );
}
