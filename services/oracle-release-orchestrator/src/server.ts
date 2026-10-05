import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReleaseOrchestrator } from "./engine/release-orchestrator.js";
import { createOracleReleaseReadApi } from "./read-api.js";
import { createOracleReadApiServer } from "./node-read-server.js";
import { SqliteReleaseLedger } from "./storage/sqlite-release-ledger.js";

export interface OracleReadApiServiceConfig {
  readonly ledgerPath: string;
  readonly releaseRoot: string;
  readonly bearerToken: string;
  readonly host: string;
  readonly port: number;
}

export function startOracleReleaseReadApiService(
  config: OracleReadApiServiceConfig,
): { close(): Promise<void> } {
  validateConfig(config);
  mkdirSync(config.releaseRoot, { recursive: true });
  const ledger = SqliteReleaseLedger.open({
    databasePath: config.ledgerPath,
    releaseRoot: config.releaseRoot,
  });
  const orchestrator = new ReleaseOrchestrator(ledger);
  try {
    orchestrator.recoverInterruptedOperations("system:oracle-startup");
    const handler = createOracleReleaseReadApi({
      orchestrator,
      bearerToken: config.bearerToken,
    });
    const server = createOracleReadApiServer({ handler, host: config.host });
    server.listen(config.port, config.host);
    return {
      close: () => new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          orchestrator.close();
          if (error) rejectClose(error);
          else resolveClose();
        });
      }),
    };
  } catch (error) {
    orchestrator.close();
    throw error;
  }
}

function validateConfig(config: OracleReadApiServiceConfig): void {
  if (!isAbsolute(config.ledgerPath) || !isAbsolute(config.releaseRoot)) {
    throw new Error("ORCHESTRATOR_LEDGER_PATH and ORCHESTRATOR_RELEASE_ROOT must be absolute paths.");
  }
  if (config.host !== "127.0.0.1" && config.host !== "::1") {
    throw new Error("ORCHESTRATOR_READ_API_HOST must be 127.0.0.1 or ::1.");
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error("ORCHESTRATOR_READ_API_PORT must be between 1 and 65535.");
  }
  if (config.bearerToken.length < 32 || config.bearerToken.length > 2048 ||
      /[\r\n\0]/u.test(config.bearerToken)) {
    throw new Error("UPDATE_CONTROL_ORCHESTRATOR_TOKEN must be 32 to 2048 safe characters.");
  }
}

function requireEnv(name: string, environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function resolveOrchestratorReadApiToken(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const credentialFile = environment.UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE?.trim();
  const environmentToken = environment.UPDATE_CONTROL_ORCHESTRATOR_TOKEN?.trim();
  if (credentialFile && environmentToken) {
    throw new Error("Configure exactly one Oracle read API token source.");
  }
  if (!credentialFile) return requireEnv("UPDATE_CONTROL_ORCHESTRATOR_TOKEN", environment);
  if (!isAbsolute(credentialFile)) {
    throw new Error("UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE must be an absolute path.");
  }

  const credential = lstatSync(credentialFile);
  if (!credential.isFile()) {
    throw new Error("UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE must reference a regular file.");
  }
  if (process.platform !== "win32" && (credential.mode & 0o077) !== 0) {
    throw new Error("UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE permissions are too broad.");
  }

  const raw = readFileSync(credentialFile, "utf8");
  const token = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!token) throw new Error("UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE is empty.");
  return token;
}

function readPort(value: string): number {
  if (!/^\d{1,5}$/u.test(value)) throw new Error("ORCHESTRATOR_READ_API_PORT is invalid.");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ORCHESTRATOR_READ_API_PORT is invalid.");
  }
  return port;
}

export function startFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): { close(): Promise<void> } {
  const ledgerPath = resolve(requireEnv("ORCHESTRATOR_LEDGER_PATH", environment));
  const releaseRoot = resolve(requireEnv("ORCHESTRATOR_RELEASE_ROOT", environment));
  const host = environment.ORCHESTRATOR_READ_API_HOST?.trim() || "127.0.0.1";
  const port = readPort(environment.ORCHESTRATOR_READ_API_PORT?.trim() || "9381");
  return startOracleReleaseReadApiService({
    ledgerPath,
    releaseRoot,
    bearerToken: resolveOrchestratorReadApiToken(environment),
    host,
    port,
  });
}

async function main(): Promise<void> {
  const service = startFromEnvironment();
  const shutdown = () => {
    void service.close().then(
      () => { process.exitCode = 0; },
      () => { process.exitCode = 1; },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void main().catch(() => {
    process.stderr.write("oracle-release-orchestrator: startup failed\n");
    process.exitCode = 1;
  });
}
