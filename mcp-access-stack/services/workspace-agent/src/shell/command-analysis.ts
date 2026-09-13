import type { ShellName } from "@vs-code-gpt/shared";

export interface ShellSyntaxDiagnostic {
  code: "syntax_error" | "unsupported_construct" | "shell_unavailable";
  message: string;
}

export type ShellCommandExecution =
  | { kind: "argv"; executable: string; argv: string[] }
  | { kind: "script"; script: string };

export interface ShellCommandAnalysis {
  shell: ShellName;
  valid: boolean;
  execution?: ShellCommandExecution;
  diagnostics: ShellSyntaxDiagnostic[];
  usesShellFeatures: boolean;
}

const POWERSHELL_UNSUPPORTED_UNQUOTED = /[|&;<>`$*?{}()[\]#,@%\r\n]/u;

export function analyzeSimpleShellCommand(
  shell: ShellName,
  command: string,
): ShellCommandAnalysis | undefined {
  if (shell === "powershell" || shell === "pwsh") {
    return analyzeSimplePowerShellCommand(shell, command);
  }
  if (shell === "cmd") {
    return analyzeLexicalCommand(shell, command, /[&|<>^()%!\r\n]/u, "cmd");
  }
  return analyzeLexicalCommand(
    shell,
    command,
    /[|&;<>`$*?{}()[\]\r\n]/u,
    "posix",
  );
}

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
    if (POWERSHELL_UNSUPPORTED_UNQUOTED.test(character)) return undefined;

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

function analyzeLexicalCommand(
  shell: ShellName,
  command: string,
  metacharacters: RegExp,
  grammar: "cmd" | "posix",
): ShellCommandAnalysis {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return invalidAnalysis(shell, "Command must not be empty.");
  }
  const tokenized = tokenize(trimmed, grammar);
  if (!tokenized.valid || tokenized.tokens.length === 0) {
    return invalidAnalysis(shell, tokenized.error ?? "Command syntax is invalid.");
  }
  if (containsUnquoted(trimmed, metacharacters, grammar)) {
    return {
      shell,
      valid: true,
      execution: { kind: "script", script: command },
      diagnostics: [],
      usesShellFeatures: true,
    };
  }
  const [executable, ...argv] = tokenized.tokens;
  if (!executable) return invalidAnalysis(shell, "Command executable is missing.");
  return {
    shell,
    valid: true,
    execution: { kind: "argv", executable, argv },
    diagnostics: [],
    usesShellFeatures: false,
  };
}

function containsUnquoted(
  value: string,
  pattern: RegExp,
  grammar: "cmd" | "posix",
): boolean {
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (grammar === "posix" && character === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== "double" && grammar === "posix") {
      quote = quote === "single" ? undefined : "single";
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      continue;
    }
    if (!quote && pattern.test(character)) return true;
    pattern.lastIndex = 0;
  }
  return false;
}

function tokenize(
  value: string,
  grammar: "cmd" | "posix",
): { valid: boolean; tokens: string[]; error?: string } {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;
  let escaped = false;

  const flush = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (const character of value) {
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (grammar === "posix" && character === "\\" && quote !== "single") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (grammar === "posix" && character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      tokenStarted = true;
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      tokenStarted = true;
      continue;
    }
    if (!quote && /\s/u.test(character)) {
      flush();
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (escaped || quote) {
    return {
      valid: false,
      tokens: [],
      error: "Command contains an unterminated escape or quote.",
    };
  }
  flush();
  return { valid: true, tokens };
}

function isTokenBoundary(character: string | undefined): boolean {
  return character === undefined || /\s/u.test(character);
}

function invalidAnalysis(
  shell: ShellName,
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
