import { spawn } from "node:child_process";
import { analyzeSimplePowerShellCommand } from "./powershell-lexical.js";
import type { ShellName } from "@vs-code-gpt/shared";
import type {
  ShellCommandAnalysis,
  ShellSyntaxDiagnostic,
} from "./types.js";

const MAX_PARSER_OUTPUT_BYTES = 32_000;
const PARSER_TIMEOUT_MS = 15_000;
const PARSER_RETRY_DELAY_MS = 50;

export interface QualifiedShellAdapter {
  readonly shell: ShellName;
  analyze(command: string, cwd: string): Promise<ShellCommandAnalysis>;
}

export interface PowerShellParseResult {
  available: boolean;
  valid: boolean;
  argv?: string[];
  usesShellFeatures: boolean;
  errors: string[];
}

export interface PowerShellSyntaxProbe {
  parse(
    shell: "powershell" | "pwsh",
    command: string,
    cwd: string,
  ): Promise<PowerShellParseResult>;
}

export class NativePowerShellSyntaxProbe implements PowerShellSyntaxProbe {
  async parse(
    shell: "powershell" | "pwsh",
    command: string,
    cwd: string,
  ): Promise<PowerShellParseResult> {
    const executable = shell === "powershell" ? "powershell.exe" : "pwsh.exe";
    const encoded = Buffer.from(POWERSHELL_AST_PROBE, "utf16le").toString("base64");
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let child;
      try {
        child = spawn(
          executable,
          [
            ...(shell === "pwsh" ? ["-NoLogo"] : []),
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            encoded,
          ],
          {
            cwd,
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
      } catch {
        resolve({
          available: false,
          valid: false,
          usesShellFeatures: true,
          errors: [`${shell} parser is unavailable.`],
        });
        return;
      }

      const append = (current: string, chunk: Buffer): string =>
        (current + chunk.toString("utf8")).slice(0, MAX_PARSER_OUTPUT_BYTES);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve({
          available: false,
          valid: false,
          usesShellFeatures: true,
          errors: [`${shell} parser timed out.`],
        });
      }, PARSER_TIMEOUT_MS);
      timer.unref();

      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          available: false,
          valid: false,
          usesShellFeatures: true,
          errors: [`${shell} parser is unavailable.`],
        });
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          resolve({
            available: true,
            valid: false,
            usesShellFeatures: true,
            errors: [sanitizeParserError(stderr || stdout)],
          });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            valid: boolean;
            argv?: string[] | null;
            usesShellFeatures: boolean;
            errors?: string[];
          };
          resolve({
            available: true,
            valid: parsed.valid,
            ...(Array.isArray(parsed.argv) && parsed.argv.length > 0
              ? { argv: parsed.argv }
              : {}),
            usesShellFeatures: parsed.usesShellFeatures,
            errors: Array.isArray(parsed.errors)
              ? parsed.errors.map((value) => value.slice(0, 500))
              : [],
          });
        } catch {
          resolve({
            available: true,
            valid: false,
            usesShellFeatures: true,
            errors: ["PowerShell parser returned an invalid response."],
          });
        }
      });

      child.stdin?.end(command, "utf8");
    });
  }
}

export class PowerShellQualifiedShellAdapter implements QualifiedShellAdapter {
  constructor(
    readonly shell: "powershell" | "pwsh",
    private readonly probe: PowerShellSyntaxProbe = new NativePowerShellSyntaxProbe(),
  ) {}

  async analyze(command: string, cwd: string): Promise<ShellCommandAnalysis> {
    const lexical = analyzeSimplePowerShellCommand(this.shell, command);
    if (lexical) return lexical;

    let parsed = await this.probe.parse(this.shell, command, cwd);
    if (!parsed.available) {
      await delay(PARSER_RETRY_DELAY_MS);
      parsed = await this.probe.parse(this.shell, command, cwd);
    }
    if (!parsed.available) {
      return {
        shell: this.shell,
        valid: false,
        diagnostics: parsed.errors.map((message) => ({
          code: "shell_unavailable",
          message,
        })),
        usesShellFeatures: true,
      };
    }
    if (!parsed.valid) {
      return {
        shell: this.shell,
        valid: false,
        diagnostics: parsed.errors.map((message) => ({
          code: "syntax_error",
          message,
        })),
        usesShellFeatures: true,
      };
    }
    if (parsed.argv && parsed.argv.length > 0) {
      const [executable, ...argv] = parsed.argv;
      if (executable) {
        return {
          shell: this.shell,
          valid: true,
          execution: { kind: "argv", executable, argv },
          diagnostics: [],
          usesShellFeatures: false,
        };
      }
    }
    return {
      shell: this.shell,
      valid: true,
      execution: { kind: "script", script: command },
      diagnostics: [],
      usesShellFeatures: parsed.usesShellFeatures,
    };
  }
}

export class CmdQualifiedShellAdapter implements QualifiedShellAdapter {
  readonly shell = "cmd" as const;

  async analyze(command: string): Promise<ShellCommandAnalysis> {
    return analyzeLexicalCommand(this.shell, command, /[&|<>^()%!\r\n]/u, "cmd");
  }
}

export class PosixQualifiedShellAdapter implements QualifiedShellAdapter {
  constructor(readonly shell: "wsl" | "git-bash") {}

  async analyze(command: string): Promise<ShellCommandAnalysis> {
    return analyzeLexicalCommand(
      this.shell,
      command,
      /[|&;<>`$*?{}()[\]\r\n]/u,
      "posix",
    );
  }
}

export class QualifiedShellAdapterRegistry {
  private readonly adapters: Map<ShellName, QualifiedShellAdapter>;

  constructor(adapters: QualifiedShellAdapter[] = defaultAdapters()) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.shell, adapter]));
  }

  async analyze(
    shell: ShellName,
    command: string,
    cwd: string,
  ): Promise<ShellCommandAnalysis> {
    const adapter = this.adapters.get(shell);
    if (!adapter) {
      return {
        shell,
        valid: false,
        diagnostics: [
          {
            code: "unsupported_construct",
            message: `No qualified command adapter is registered for ${shell}.`,
          },
        ],
        usesShellFeatures: true,
      };
    }
    return adapter.analyze(command, cwd);
  }
}

function defaultAdapters(): QualifiedShellAdapter[] {
  const powerShellProbe = new NativePowerShellSyntaxProbe();
  return [
    new PowerShellQualifiedShellAdapter("powershell", powerShellProbe),
    new PowerShellQualifiedShellAdapter("pwsh", powerShellProbe),
    new CmdQualifiedShellAdapter(),
    new PosixQualifiedShellAdapter("wsl"),
    new PosixQualifiedShellAdapter("git-bash"),
  ];
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

function sanitizeParserError(value: string): string {
  const first = value.split(/\r?\n/u).find((line) => line.trim().length > 0);
  return first?.trim().slice(0, 500) || "PowerShell syntax validation failed.";
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
}

const POWERSHELL_AST_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$source = [Console]::In.ReadToEnd()
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
$argv = $null
$usesShellFeatures = $true
if ($errors.Count -eq 0 -and $ast.EndBlock.Statements.Count -eq 1) {
  $statement = $ast.EndBlock.Statements[0]
  if ($statement -is [System.Management.Automation.Language.PipelineAst] -and
      $statement.PipelineElements.Count -eq 1 -and
      $statement.PipelineElements[0] -is [System.Management.Automation.Language.CommandAst]) {
    $commandAst = $statement.PipelineElements[0]
    if ($commandAst.Redirections.Count -eq 0 -and $commandAst.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Unknown) {
      $values = [System.Collections.Generic.List[string]]::new()
      $simple = $true
      foreach ($element in $commandAst.CommandElements) {
        if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
          $values.Add([string]$element.Value)
        }
        else {
          $simple = $false
          break
        }
      }
      if ($simple -and $values.Count -gt 0) {
        $argv = @($values)
        $usesShellFeatures = $false
      }
    }
  }
}
[ordered]@{
  valid = ($errors.Count -eq 0)
  argv = $argv
  usesShellFeatures = $usesShellFeatures
  errors = @($errors | ForEach-Object { [string]$_.Message })
} | ConvertTo-Json -Depth 5 -Compress
`;
