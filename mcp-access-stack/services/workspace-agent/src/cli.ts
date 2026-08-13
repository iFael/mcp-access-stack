#!/usr/bin/env node
import { writeSync } from "node:fs";
import path from "node:path";
import {
  AppError,
  asAppError,
  QUICK_OPERATION_TIMEOUT_MS,
} from "@vs-code-gpt/shared";
import { LocalAgent } from "./local-agent.js";
import { createQualifiedCommandRuntimeOptions } from "./qualified-command-runtime-config.js";
import { AgentConnection } from "./connection/service.js";
import { applyPolicyFile, validatePolicyFile } from "./policy-deployment.js";

const processStartedAt = Date.now();
let fatalExitScheduled = false;
installProcessDiagnostics();
writeDiagnostic({
  event: "agent_process_started",
  pid: process.pid,
  nodeVersion: process.version,
});

interface ParsedArguments {
  command: string;
  policyPath: string;
  options: Map<string, string | true>;
}

async function main(): Promise<void> {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.command === "validate-policy") {
      const result = await validatePolicyFile(args.policyPath);
      process.stdout.write(JSON.stringify(result) + "\n");
      return;
    }
    if (args.command === "apply-policy") {
      const targetPath = requireValue(getString(args.options, "target"), "--target");
      const result = await applyPolicyFile(args.policyPath, targetPath);
      process.stdout.write(JSON.stringify(result) + "\n");
      return;
    }
    const agent = await LocalAgent.create(
      args.policyPath,
      createQualifiedCommandRuntimeOptions(process.env, (event) =>
        writeDiagnostic(event),
      ),
    );
    if (args.command === "connect") {
      await connectAgent(agent, args.options);
      return;
    }
    const result = await executeCommand(agent, args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const appError = asAppError(error);
    process.stderr.write(`${JSON.stringify(appError.toJSON())}\n`);
    process.exitCode = 1;
  }
}

async function connectAgent(
  agent: LocalAgent,
  options: Map<string, string | true>,
): Promise<void> {
  const maxPayloadBytes = readPositiveInteger(
    process.env.VS_CODE_GPT_MAX_PAYLOAD_BYTES,
    "VS_CODE_GPT_MAX_PAYLOAD_BYTES",
  );
  const maxConcurrentSynchronousShells = readPositiveInteger(
    process.env.VS_CODE_GPT_MAX_CONCURRENT_SYNCHRONOUS_SHELLS,
    "VS_CODE_GPT_MAX_CONCURRENT_SYNCHRONOUS_SHELLS",
  );
  const connection = new AgentConnection(agent, {
    gatewayUrl: requireValue(
      getString(options, "gateway") ?? process.env.VS_CODE_GPT_GATEWAY_URL,
      "--gateway or VS_CODE_GPT_GATEWAY_URL",
    ),
    agentId: requireValue(
      getString(options, "agent-id") ?? process.env.VS_CODE_GPT_AGENT_ID,
      "--agent-id or VS_CODE_GPT_AGENT_ID",
    ),
    token: requireValue(
      getString(options, "agent-token") ?? process.env.VS_CODE_GPT_AGENT_TOKEN,
      "--agent-token or VS_CODE_GPT_AGENT_TOKEN",
    ),
    ...(maxPayloadBytes === undefined ? {} : { maxPayloadBytes }),
    ...(maxConcurrentSynchronousShells === undefined
      ? {}
      : { maxConcurrentSynchronousShells }),
    log: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
  });
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    writeDiagnostic({ event: "agent_process_signal", signal });
    controller.abort();
  };
  const stopOnSigint = () => stop("SIGINT");
  const stopOnSigterm = () => stop("SIGTERM");
  process.once("SIGINT", stopOnSigint);
  process.once("SIGTERM", stopOnSigterm);
  try {
    await connection.run(controller.signal);
  } finally {
    process.removeListener("SIGINT", stopOnSigint);
    process.removeListener("SIGTERM", stopOnSigterm);
  }
}

function parseArguments(argv: string[]): ParsedArguments {
  const options = new Map<string, string | true>();
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument?.startsWith("--")) {
      const name = argument.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        options.set(name, next);
        index += 1;
      } else {
        options.set(name, true);
      }
      continue;
    }
    if (command) {
      throw new AppError("INVALID_ARGUMENT", "Only one command may be provided.");
    }
    command = argument;
  }

  const configuredPolicy = getString(options, "policy") ?? process.env.VS_CODE_GPT_POLICY_PATH;
  if (!configuredPolicy) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Provide --policy or VS_CODE_GPT_POLICY_PATH.",
    );
  }
  if (!command) {
    throw new AppError("INVALID_ARGUMENT", "A command is required.");
  }

  return {
    command,
    policyPath: path.resolve(configuredPolicy),
    options,
  };
}

async function executeCommand(agent: LocalAgent, args: ParsedArguments): Promise<unknown> {
  const workspaceId = getString(args.options, "workspace");
  switch (args.command) {
    case "qualified-command-status":
      return agent.qualifiedCommandObservability();
    case "list-workspaces":
      return agent.listWorkspaces();
    case "list-files":
      return agent.listFiles({
        workspaceId: requireValue(workspaceId, "--workspace"),
        ...optionalString(args.options, "root"),
        ...optionalString(args.options, "glob"),
      });
    case "read-file":
      return agent.readFile({
        workspaceId: requireValue(workspaceId, "--workspace"),
        path: requireValue(getString(args.options, "path"), "--path"),
        ...optionalInteger(args.options, "start-line", "startLine"),
        ...optionalInteger(args.options, "end-line", "endLine"),
      });
    case "write-file":
      return agent.writeFile({
        workspaceId: requireValue(workspaceId, "--workspace"),
        path: requireValue(getString(args.options, "path"), "--path"),
        content: requireValue(getString(args.options, "content"), "--content"),
      });
    case "run-command":
      return agent.runCommand({
        workspaceId: requireValue(workspaceId, "--workspace"),
        shell: requireValue(getString(args.options, "shell"), "--shell") as never,
        command: requireValue(getString(args.options, "command"), "--command"),
        timeoutMs: readCommandTimeout(args.options),
        ...optionalString(args.options, "cwd"),
        ...optionalString(args.options, "confirmation-id"),
      });
    case "run-powershell":
      return agent.runPowerShell({
        workspaceId: requireValue(workspaceId, "--workspace"),
        command: requireValue(getString(args.options, "command"), "--command"),
        timeoutMs: readCommandTimeout(args.options),
        ...optionalString(args.options, "cwd"),
        ...optionalString(args.options, "confirmation-id"),
      });
    case "search-files":
      return agent.searchFiles({
        workspaceId: requireValue(workspaceId, "--workspace"),
        query: requireValue(getString(args.options, "query"), "--query"),
        ...optionalString(args.options, "root"),
        ...optionalString(args.options, "glob"),
        caseSensitive: args.options.has("case-sensitive"),
      });
    case "inspect-git":
      return agent.inspectGit({
        workspaceId: requireValue(workspaceId, "--workspace"),
        ...optionalString(args.options, "path"),
      });
    default:
      throw new AppError("INVALID_ARGUMENT", "Unknown command.");
  }
}

function getString(options: Map<string, string | true>, key: string): string | undefined {
  const value = options.get(key);
  return typeof value === "string" ? value : undefined;
}

function requireValue(value: string | undefined, option: string): string {
  if (!value) {
    throw new AppError("INVALID_ARGUMENT", `${option} is required.`);
  }
  return value;
}

function readPositiveInteger(
  value: string | undefined,
  variableName: string,
): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(
      "INVALID_ARGUMENT",
      `${variableName} must be a positive integer.`,
    );
  }
  return parsed;
}

function optionalString(
  options: Map<string, string | true>,
  key: string,
): Record<string, string> {
  const value = getString(options, key);
  return value === undefined ? {} : { [camelCase(key)]: value };
}

function optionalInteger(
  options: Map<string, string | true>,
  key: string,
  outputKey: string,
): Record<string, number> {
  const value = getString(options, key);
  if (value === undefined) {
    return {};
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError("INVALID_ARGUMENT", `--${key} must be a positive integer.`);
  }
  return { [outputKey]: parsed };
}

function readCommandTimeout(options: Map<string, string | true>): number {
  const value = optionalInteger(options, "timeout-ms", "timeoutMs").timeoutMs;
  return typeof value === "number" ? value : QUICK_OPERATION_TIMEOUT_MS;
}

function camelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function installProcessDiagnostics(): void {
  process.on("warning", (warning) => {
    writeDiagnostic({
      event: "agent_process_warning",
      reason: warning.name,
      message: sanitizeDiagnosticText(warning.message),
    });
  });
  process.on("uncaughtException", (error) => {
    scheduleFatalExit("agent_uncaught_exception", error);
  });
  process.on("unhandledRejection", (reason) => {
    scheduleFatalExit(
      "agent_unhandled_rejection",
      reason instanceof Error ? reason : new Error(String(reason)),
    );
  });
  process.on("exit", (code) => {
    writeDiagnostic({
      event: "agent_process_exit",
      code,
      uptimeMs: Date.now() - processStartedAt,
      ...memoryMetrics(),
    });
  });
}

function scheduleFatalExit(event: string, error: Error): void {
  writeDiagnostic({
    event,
    reason: error.name,
    message: sanitizeDiagnosticText(error.message),
    stack: sanitizeDiagnosticText(error.stack ?? ""),
    ...memoryMetrics(),
  });
  if (fatalExitScheduled) return;
  fatalExitScheduled = true;
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
}

function writeDiagnostic(entry: Record<string, unknown>): void {
  try {
    writeSync(2, JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "workspace-agent",
      ...entry,
    }) + "\n");
  } catch {
    // Diagnostics must never become a second fatal error.
  }
}

function sanitizeDiagnosticText(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 2_000);
}

function memoryMetrics(): { rssBytes: number; heapUsedBytes: number } {
  const memory = process.memoryUsage();
  return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed };
}

void main();
