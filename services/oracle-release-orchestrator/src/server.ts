import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readPort(value: string): number {
  if (!/^\d{1,5}$/u.test(value)) throw new Error("ORCHESTRATOR_READ_API_PORT is invalid.");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ORCHESTRATOR_READ_API_PORT is invalid.");
  }
  return port;
}

export function startFromEnvironment(): { close(): Promise<void> } {
  const ledgerPath = resolve(requireEnv("ORCHESTRATOR_LEDGER_PATH"));
  const releaseRoot = resolve(requireEnv("ORCHESTRATOR_RELEASE_ROOT"));
  const host = process.env.ORCHESTRATOR_READ_API_HOST?.trim() || "127.0.0.1";
  const port = readPort(process.env.ORCHESTRATOR_READ_API_PORT?.trim() || "9381");
  return startOracleReleaseReadApiService({
    ledgerPath,
    releaseRoot,
    bearerToken: requireEnv("UPDATE_CONTROL_ORCHESTRATOR_TOKEN"),
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

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(() => {
    process.stderr.write("oracle-release-orchestrator: startup failed\n");
    process.exitCode = 1;
  });
}
