import type {
  ShellCommandAnalysis,
  ShellSyntaxDiagnostic,
} from "./types.js";

const UNSUPPORTED_UNQUOTED = /[|&;<>`$*?{}()[\]#,@%\r\n]/u;

export function analyzeSimplePowerShellCommand(
  shell: "powershell" | "pwsh",
  command: string,
): ShellCommandAnalysis | undefined {
  const value = command.trim();
  if (value.length === 0) {
    return invalidAnalysis(shell, "Command must not be empty.");
  }

  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;

  const flush = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;

    if (quote === "single") {
      if (character === "'") {
        if (value[index + 1] === "'") {
          token += "'";
          index += 1;
          continue;
        }
        if (!isTokenBoundary(value[index + 1])) return undefined;
        quote = undefined;
        continue;
      }
      token += character;
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        if (!isTokenBoundary(value[index + 1])) return undefined;
        quote = undefined;
        continue;
      }
      if (character === "$" || character === "`") return undefined;
      token += character;
      continue;
    }

    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    if (character === "'" || character === '"') {
      if (tokenStarted) return undefined;
      tokenStarted = true;
      quote = character === "'" ? "single" : "double";
      continue;
    }
    if (UNSUPPORTED_UNQUOTED.test(character)) return undefined;

    token += character;
    tokenStarted = true;
  }

  if (quote) {
    return invalidAnalysis(
      shell,
      "PowerShell command contains an unterminated quote.",
    );
  }
  flush();

  const [executable, ...argv] = tokens;
  if (!executable) {
    return invalidAnalysis(shell, "Command executable is missing.");
  }
  if (executable === ".") return undefined;

  return {
    shell,
    valid: true,
    execution: { kind: "argv", executable, argv },
    diagnostics: [],
    usesShellFeatures: false,
  };
}

function isTokenBoundary(character: string | undefined): boolean {
  return character === undefined || /\s/u.test(character);
}

function invalidAnalysis(
  shell: "powershell" | "pwsh",
  message: string,
): ShellCommandAnalysis {
  const diagnostic: ShellSyntaxDiagnostic = {
    code: "syntax_error",
    message,
  };
  return {
    shell,
    valid: false,
    diagnostics: [diagnostic],
    usesShellFeatures: true,
  };
}
